import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { toXlsx } from "./excel";
import { getSetting } from "./settings";
// orders.ts's own `createOrder` calls THIS file's `createCert` for the ORDER-scope case (spec
// §6.2). That used to be a genuine bidirectional cycle — `claimOrder` lived in orders.ts, so
// certs.ts imported it from there while orders.ts imported `createCert` back — safe only because
// every crossing export was a hoisted `function` declaration. Task 7 broke it at the root:
// `claimOrder`/`claimCertsOrder` now live in the leaf `order-locks.ts` (the `errors.ts`
// precedent), so this import no longer points back at orders.ts at all.
import { claimOrder, claimCertsOrder } from "./order-locks";
// `readCertDetail` used to live in THIS file and cert-results.ts imported it back (alongside
// `claimCertsOrder`, above) — the identical bidirectional-cycle shape, found and broken in the
// same Task 7 review. It now lives in cert-results.ts itself, so this import is one-directional.
import { seedRequirements, readCertDetail } from "./cert-results";
import { renderPdf } from "./pdf/render";
import { buildCertDefinition, type CertPdfData, type CertPartRow, type CertSerialBlock } from "./pdf/cert";
import { storeDocument, assertPrintable } from "./documents";
import { listAddresses } from "./customer-addresses";
import { formatDateOnly, todayDateOnly } from "../lib/business-days";
import { CERT_SCOPES, type CertScopeValue } from "../lib/cert-constants";

// Either the top-level client or a `tx` — the `readDetail` precedent (orders.ts): callers pass a
// `tx` when the resolution has to see this same transaction's own writes (createOrder, Task 5's
// shipment-scope creation), and the bare `prisma` client structurally satisfies this type too, so
// a standalone caller (a future preview endpoint, this file's own tests) needs nothing special.
type Db = Prisma.TransactionClient;

export type CertResolution = { certRequired: boolean; certScope: CertScopeValue };

/**
 * Spec §6.1's resolution chain, evaluated per line and combined two different ways:
 *
 * - **Required** is `line.part.certRequired ?? customer.certRequiredDefault ??
 *   cert_required_default`, OR'd across every line in `partIds` — any line requiring a cert makes
 *   the order require one, so a rider's requirement is never silently dropped by the lead's own
 *   answer.
 * - **Scope** is the identical chain but read from `partIds[0]`, the LEAD line, ALONE — never
 *   combined across lines, even when a rider disagrees. The lead owns document identity exactly
 *   as it owns the process (§6.1).
 *
 * One query for the customer's two defaults, one query for every named part's two columns (not
 * one query per part) — the `resolveLineParts` precedent (orders.ts) for avoiding N+1 lookups.
 * Both reads are scoped to LIVE rows only: a soft-deleted customer or part contributes nothing,
 * which resolves to "inherit from the next link in the chain" exactly as a genuinely absent
 * override would.
 *
 * EVERY read this function makes — customer, parts, and the two plant defaults — runs on `db`,
 * the caller's own client. `getSetting` takes the same optional `db` (settings.ts) for exactly
 * this reason: a caller passing `tx` (createOrder's own transaction) never has this function open
 * a second, competing connection from the pool while that `tx` is held open. That is the
 * pool-starvation shape fix-wave R4 finding 8 fixed for `printTraveler`'s reads
 * (`readTravelerData`, traveler.ts) — `createOrder` is a hotter path than traveler printing, so
 * the same fix applies here from the start rather than after the fact.
 *
 * The four reads run SEQUENTIALLY, not `Promise.all`'d — `readTravelerData`'s own precedent
 * (traveler.ts) for the same reason: on a `tx`, every one of these queries shares ONE physical
 * connection regardless, and issuing them concurrently is what makes @prisma/adapter-pg's
 * `performIO` overlap calls on that single connection and emit node-postgres' own deprecation
 * warning (tests/helpers/setup.ts documents the identical threshold for `readDetail`'s relation
 * loads).
 */
export async function resolveCertSettings(
  db: Db, customerId: string, partIds: string[],
): Promise<CertResolution> {
  // `saveNewOrder` (orders.ts) already holds the FULL customer row a few lines above this call —
  // re-querying just these two columns is one redundant round trip. Left as-is rather than adding
  // a "pass the row you already have" parameter: the interface Task 5 depends on is exactly
  // `resolveCertSettings(db, customerId, partIds)`, and now that this read runs on `db` (the
  // caller's own connection, never a second one), the cost is one extra query on an
  // already-open connection — not the pool-starvation shape the Important finding was about.
  const customer = await db.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    select: { certRequiredDefault: true, certScopeDefault: true },
  });
  const parts = await db.part.findMany({
    where: { id: { in: partIds }, deletedAt: null },
    select: { id: true, certRequired: true, certScope: true },
  });
  const requiredDefault = await getSetting("cert_required_default", db);
  const scopeDefault = await getSetting("cert_scope_default", db);

  const byId = new Map(parts.map((p) => [p.id, p]));

  const certRequired = partIds.some((id) =>
    byId.get(id)?.certRequired ?? customer?.certRequiredDefault ?? requiredDefault);

  const lead = byId.get(partIds[0]);
  const certScope = (lead?.certScope ?? customer?.certScopeDefault ?? scopeDefault) as CertScopeValue;

  return { certRequired, certScope };
}

// -------------------------------------------------------------------------------------------
// Task 5: the cert record itself — scope-aware creation, uniqueness under the claim, listing,
// export, update and void (spec §4.1/§5.6/§6.2).
// -------------------------------------------------------------------------------------------

export type CertRow = {
  id: string; orderId: string; orderNumber: number; sequence: number | null;
  customerCode: string; customerName: string; scope: CertScopeValue;
  loadNumber: number | null; shipperId: string | null; shipperNumber: number | null;
  printedAt: string | null; deletedAt: string | null;
  // `readingCount` is `passedCount + failCount + <readings with no value yet>` — the third state
  // (`passed === null`, a reading nobody has entered) is NOT `readingCount - failCount`. That
  // subtraction is exactly the bug the certifications worklist (src/app/certs/CertList.tsx) shipped
  // with: it reported a mid-entry cert (some requirements filled and passing, the rest still
  // blank, zero failures so far — the normal state of every cert before data entry finishes) as
  // fully "N passed", overstating completeness to the audience this page exists for. `passedCount`
  // is computed the same explicit-equality way `failCount` always was (`passed === true`, not
  // "not false"), so a caller can tell all three states apart without re-deriving one from a
  // subtraction that silently folds "no value" into "passed".
  readingCount: number; passedCount: number; failCount: number;
};
export type CertDetail = CertRow & {
  freeform: string; internalNotes: string; requirements: CertRequirementDetail[];
  poNumber: string; material: string; receivedDate: string;
};
export type CertFilter = {
  customerId?: string; scope?: CertScopeValue; printed?: boolean; includeVoided?: boolean; search?: string;
};

// Declared HERE and imported by Task 6's cert-results.ts — this task runs first, so declaring
// them the other way round would be a forward reference that does not compile. Task 6 owns their
// population (seedRequirements, replaceReadings); this file owns their shape.
export type CertReadingDetail = {
  id: string; position: number; value: number | null;
  passed: boolean | null; overridden: boolean; note: string;
};
export type CertRequirementDetail = {
  id: string; orderLineId: string | null; linePosition: number; partNumber: string; partName: string;
  position: number; inspectionCodeId: string; inspectionCodeName: string;
  scaleId: string | null; scaleName: string | null;
  min: number | null; max: number | null; sampleQty: string; location: string;
  readings: CertReadingDetail[];
};

const CREATE_CERT = z.object({
  orderId: z.string().min(1),
  scope: z.enum(CERT_SCOPES),
  loadNumber: z.number().int().positive().nullable().optional(),
  shipperId: z.string().min(1).nullable().optional(),
}).strict();

type CreateCertInput = { orderId: string; scope: CertScopeValue; loadNumber: number | null; shipperId: string | null };

/**
 * Spec §4.1's per-scope shape: `LOAD` requires a `loadNumber` and no `shipperId`, `SHIPMENT`
 * requires a `shipperId` and no `loadNumber`, `ORDER` carries neither. Field-anchored 400s, named
 * after the offending field the way every other refusal in this codebase is (CLAUDE.md).
 */
function assertScopeShape(data: CreateCertInput): void {
  if (data.scope === "LOAD") {
    if (data.loadNumber === null) throw new HttpError(400, "Load number is required for a load-scope certification");
    if (data.shipperId !== null) throw new HttpError(400, "A load-scope certification cannot have a shipper");
  } else if (data.scope === "SHIPMENT") {
    if (data.shipperId === null) throw new HttpError(400, "Shipper is required for a shipment-scope certification");
    if (data.loadNumber !== null) throw new HttpError(400, "A shipment-scope certification cannot have a load number");
  } else {
    if (data.loadNumber !== null) throw new HttpError(400, "An order-scope certification cannot have a load number");
    if (data.shipperId !== null) throw new HttpError(400, "An order-scope certification cannot have a shipper");
  }
}

/**
 * The save itself, run against whichever `tx` the caller is already inside (createOrder,
 * Task 8's shipment creation) or a fresh one this function opens for a standalone caller
 * (`createCert` below). `claimOrder` first (spec §5.3) — the row lock is what makes the
 * uniqueness check beneath it correct at ANY isolation level, never the Serializable level
 * itself (CLAUDE.md): two concurrent creates for the same scope-instance serialize through THIS
 * lock, not through Postgres's own conflict detection.
 */
async function createCertInTx(tx: Db, data: CreateCertInput): Promise<CertDetail> {
  const order = await claimOrder(tx, data.orderId);
  if (!order || order.deletedAt !== null) throw new HttpError(404, "Order not found");

  // Task 11 Step 0 (carried from Task 8's review): `shipperId` deliberately carries no
  // `assertRefExists` — that helper is exclusively the REFERENCE_LINKS pattern and spec §7 omits
  // shipper from it — but `Shipper` is soft-deletable, so the raw foreign key below only catches
  // a NONEXISTENT id, never a VOIDED one. Safe until now only because the sole caller
  // (shippers.ts's `saveNewShipper`) always passed its own uncommitted row, which by
  // construction cannot yet be voided by anyone. `assertScopeShape` (createCert, below) already
  // guarantees `data.shipperId !== null` whenever `data.scope === "SHIPMENT"`, so the assertion
  // here is documentation, not a runtime possibility this function has to branch on.
  if (data.scope === "SHIPMENT") {
    const shipperId = data.shipperId;
    if (shipperId === null) throw new HttpError(400, "shipperId: shipment scope requires a shipper");
    const shipper = await tx.shipper.findFirst({ where: { id: shipperId, deletedAt: null }, select: { id: true } });
    if (!shipper) throw new HttpError(400, "shipperId: that shipment does not exist or has been voided");
  }

  // LOAD scope must name a load the order CURRENTLY has — checked under the claim above, so a
  // concurrent re-split serializes with this create. Creation-time only, deliberately: a
  // re-split AFTER creation orphans the cert and keeps it live (spec §4.1's loadNumber-not-FK
  // reasoning), but a cert born pointing at a load that never existed is not an orphan, it is a
  // printable record of nothing.
  if (data.scope === "LOAD") {
    const load = await tx.load.findFirst({
      where: { orderId: data.orderId, loadNumber: data.loadNumber! }, select: { id: true },
    });
    if (!load) {
      throw new HttpError(400, `loadNumber: this order does not have a load ${data.loadNumber}`);
    }
  }

  // Service-enforced, not indexed (spec §4.1): a partial unique index cannot express "one live
  // row per (orderId, scope, loadNumber, shipperId)" because Postgres treats NULLs as distinct,
  // so two (orderId, ORDER, NULL, NULL) rows would never collide in any index.
  const clash = await tx.cert.findFirst({
    where: {
      orderId: data.orderId, scope: data.scope,
      loadNumber: data.loadNumber, shipperId: data.shipperId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (clash) throw new HttpError(400, "This order already has a certification for that scope");

  const cert = await auditedCreate(
    "cert",
    { orderId: data.orderId, scope: data.scope, loadNumber: data.loadNumber, shipperId: data.shipperId },
    () => tx.cert.create({
      data: {
        orderId: data.orderId, scope: data.scope,
        loadNumber: data.loadNumber, shipperId: data.shipperId,
      },
      select: { id: true },
    }),
    { tx },
  );

  // Task 6's seeder (cert-results.ts) — writes one CertRequirement per live PartInspection of
  // every line's part, frozen at seed time (spec §6.3).
  await seedRequirements(tx, cert.id);

  return readCertDetail(tx, cert.id);
}

/**
 * Scope decides when a cert comes into existence (spec §6.2, owner ruling §3.17): `ORDER` is
 * created here at order save (orders.ts's `saveNewOrder` calls this with `scope: "ORDER"`),
 * `SHIPMENT` is created when a shipment is created (Task 8, passing its own `tx` so the cert
 * commits or rolls back with the shipment it belongs to), and `LOAD` is created on demand from
 * the order hub — never eagerly, because Phase 3 keeps loads editable and re-splittable and an
 * eager per-load cert would mean a re-split either orphans certs or destroys ones already holding
 * readings.
 *
 * `tx` genuinely threads through: passed, this runs inside the caller's own transaction with no
 * additional `withDbErrors`/`$transaction` wrapping of its own (the caller owns that, and owns
 * translating whatever this throws). Omitted, this opens its own `withDbErrors` → Serializable
 * `$transaction` — the shape every standalone mutator in this codebase uses.
 */
export async function createCert(
  input: { orderId: string; scope: CertScopeValue; loadNumber?: number | null; shipperId?: string | null },
  tx?: Prisma.TransactionClient,
): Promise<CertDetail> {
  const parsed = CREATE_CERT.parse(input);
  const data: CreateCertInput = {
    orderId: parsed.orderId, scope: parsed.scope,
    loadNumber: parsed.loadNumber ?? null, shipperId: parsed.shipperId ?? null,
  };
  assertScopeShape(data);

  if (tx) return createCertInTx(tx, data);
  return withDbErrors({ entity: "Cert" }, () => prisma.$transaction(
    (fresh) => createCertInTx(fresh, data),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// Minimal projection for listing — selects only what `listCerts`/`certsForOrder` need to compute
// `readingCount`/`failCount` (every reading's `passed` flag, not the full requirement/reading
// detail `getCert` builds) and the sequence lookup below, rather than assembling a full
// `CertDetail` per row.
const ROW_SELECT = {
  id: true, orderId: true, scope: true, loadNumber: true, shipperId: true,
  printedAt: true, deletedAt: true,
  order: { select: { orderNumber: true, customer: { select: { code: true, name: true } } } },
  shipper: { select: { shipperNumber: true } },
  requirements: { select: { readings: { select: { passed: true } } } },
} satisfies Prisma.CertSelect;

type RowShape = Prisma.CertGetPayload<{ select: typeof ROW_SELECT }>;

/**
 * `Cert.shipperId` points at `Shipper`, not at the `ShipperOrder` pairing that actually carries
 * the per-order shipment sequence (spec §3.19's "-3" in "72036-3") — there is no direct relation
 * to follow. Batched (one query for every SHIPMENT-scope row in the set) rather than one lookup
 * per row, so a list of certs never turns into an N+1 on this join.
 */
async function sequenceMap(db: Db, pairs: { shipperId: string; orderId: string }[]): Promise<Map<string, number>> {
  if (pairs.length === 0) return new Map();
  const rows = await db.shipperOrder.findMany({
    where: { OR: pairs.map((p) => ({ shipperId: p.shipperId, orderId: p.orderId })) },
    select: { shipperId: true, orderId: true, sequence: true },
  });
  return new Map(rows.map((r) => [`${r.shipperId}:${r.orderId}`, r.sequence]));
}

async function rowsToCertRows(db: Db, rows: RowShape[]): Promise<CertRow[]> {
  const pairs = rows
    .filter((r): r is RowShape & { shipperId: string } => r.scope === "SHIPMENT" && r.shipperId !== null)
    .map((r) => ({ shipperId: r.shipperId, orderId: r.orderId }));
  const seqMap = await sequenceMap(db, pairs);

  return rows.map((row) => {
    const readings = row.requirements.flatMap((req) => req.readings);
    return {
      id: row.id, orderId: row.orderId, orderNumber: row.order.orderNumber,
      sequence: row.shipperId === null ? null : (seqMap.get(`${row.shipperId}:${row.orderId}`) ?? null),
      customerCode: row.order.customer.code, customerName: row.order.customer.name,
      scope: row.scope as CertScopeValue,
      loadNumber: row.loadNumber, shipperId: row.shipperId,
      shipperNumber: row.shipper?.shipperNumber ?? null,
      printedAt: row.printedAt ? row.printedAt.toISOString() : null,
      deletedAt: row.deletedAt ? row.deletedAt.toISOString() : null,
      readingCount: readings.length,
      passedCount: readings.filter((r) => r.passed === true).length,
      failCount: readings.filter((r) => r.passed === false).length,
    };
  });
}

function certSearchWhere(term: string): Prisma.CertWhereInput[] {
  const clauses: Prisma.CertWhereInput[] = [
    { order: { poNumber: { contains: term, mode: "insensitive" } } },
    { order: { customer: { code: { contains: term, mode: "insensitive" } } } },
    { order: { customer: { name: { contains: term, mode: "insensitive" } } } },
  ];
  // orderNumber is an Int4 column (the searchWhere precedent, orders.ts): a longer digit string
  // is not a value it can hold, and handing it to Prisma is a validation error, not "no match".
  const asNumber = Number(term);
  if (/^\d+$/.test(term) && Number.isSafeInteger(asNumber) && asNumber <= 2_147_483_647) {
    clauses.push({ order: { orderNumber: asNumber } });
  }
  return clauses;
}

function certListWhere(filter: CertFilter): Prisma.CertWhereInput {
  const term = filter.search?.trim();
  return {
    // Voided certs leave the list unless the toggle is on (spec §5.6, the orders §5c precedent).
    ...(filter.includeVoided ? {} : { deletedAt: null }),
    ...(filter.scope ? { scope: filter.scope } : {}),
    ...(filter.customerId ? { order: { customerId: filter.customerId } } : {}),
    ...(filter.printed !== undefined ? { printedAt: filter.printed ? { not: null } : null } : {}),
    ...(term ? { OR: certSearchWhere(term) } : {}),
  };
}

/** Newest-first (spec §4.1's step 4), `id` tie-broken (the `readAudit` precedent, audit.ts) so two
 *  certs created in the same millisecond still sort deterministically. */
export async function listCerts(filter: CertFilter): Promise<CertRow[]> {
  const rows = await prisma.cert.findMany({
    where: certListWhere(filter), select: ROW_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rowsToCertRows(prisma, rows);
}

/** Every cert for one order, voided included — the order hub's own view of "by load · 4 loads ·
 *  0 certs" needs to see a voided cert too, not have it silently vanish (the orders.ts `readDetail`
 *  precedent: a voided row is still shown, never hidden). */
export async function certsForOrder(orderId: string): Promise<CertRow[]> {
  const rows = await prisma.cert.findMany({
    where: { orderId }, select: ROW_SELECT, orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  return rowsToCertRows(prisma, rows);
}

const CERT_COLUMNS = [
  { key: "orderNumber", header: "Order #" },
  { key: "sequence", header: "Seq" },
  { key: "customerCode", header: "Customer code" },
  { key: "customerName", header: "Customer name" },
  { key: "scope", header: "Scope" },
  { key: "loadNumber", header: "Load #" },
  { key: "shipperNumber", header: "Shipper #" },
  { key: "printed", header: "Printed" },
  { key: "readingCount", header: "Readings" },
  // All three states, explicitly (CertRow's own rule): pending is a distinct state, and a row of
  // N readings / 0 fails must not read as N passing while all N are still blank.
  { key: "passedCount", header: "Passed" },
  { key: "failCount", header: "Fails" },
  { key: "pendingCount", header: "Pending" },
  { key: "voided", header: "Voided" },
];

/** Exactly what `listCerts` returned for the same filter (the `exportOrders` precedent,
 *  orders.ts) — same query, same rows, humanized cells. */
export async function exportCerts(filter: CertFilter): Promise<Buffer> {
  const rows = await listCerts(filter);
  const xlsxRows = rows.map((r) => ({
    ...r,
    printed: r.printedAt ? "yes" : "no",
    pendingCount: r.readingCount - r.passedCount - r.failCount,
    voided: r.deletedAt ? "yes" : "no",
  }));
  return toXlsx("Certifications", CERT_COLUMNS, xlsxRows as unknown as Record<string, unknown>[]);
}

/** Moved into cert-results.ts (Task 7 review, 2026-08-04 — order-locks.ts's own header comment
 *  explains why): `readCertDetail`, its `DETAIL_INCLUDE`/`toCertDetail`/`num` helpers. Imported
 *  from there below (alongside `seedRequirements`), one-directional. */
export async function getCert(id: string): Promise<CertDetail> {
  return readCertDetail(prisma, id);
}

const UPDATE_CERT = z.object({
  freeform: z.string().max(4000).optional(),
  internalNotes: z.string().max(4000).optional(),
}).strict();

export async function updateCert(id: string, input: unknown): Promise<CertDetail> {
  const data = UPDATE_CERT.parse(input);

  return withDbErrors({ entity: "Cert" }, () => prisma.$transaction(async (tx) => {
    await claimCertsOrder(tx, id);
    const cert = await tx.cert.findFirst({ where: { id } });
    if (!cert || cert.deletedAt !== null) throw new HttpError(404, "Certification not found");

    const patch: Prisma.CertUpdateInput = {
      ...(data.freeform !== undefined ? { freeform: data.freeform } : {}),
      ...(data.internalNotes !== undefined ? { internalNotes: data.internalNotes } : {}),
    };

    await auditedUpdate("cert", id, () => tx.cert.update({ where: { id }, data: patch }), { tx });
    return readCertDetail(tx, id);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

// -------------------------------------------------------------------------------------------
// Task 19: the certification print (spec §10.3, §3.11, §3.21, §5.15) — the printTraveler /
// printShippingTickets mechanic applied to a cert: settings outside the transaction, then one
// Serializable transaction bracketing claim → re-read → assertPrintable → read-on-tx → render →
// `printedAt` on first print → archive.
// -------------------------------------------------------------------------------------------

/** Every SETTING the cert needs, read BEFORE the print transaction opens (the ticketSettings
 *  precedent): the company block, and the `cert_statement` standing text (§3.21). */
export type CertPrintSettings = {
  company: { name: string; address: string; phone: string };
  statement: string;
};

export async function certPrintSettings(): Promise<CertPrintSettings> {
  const [name, address, phone, statement] = await Promise.all([
    getSetting("company_name"),
    getSetting("company_address"),
    getSetting("company_phone"),
    getSetting("cert_statement"),
  ]);
  return { company: { name, address, phone }, statement };
}

/** The three signer columns `printCert` reads off the User row under its own transaction —
 *  deliberately NOT users.ts's `getSignature` (that reads on the top-level client; borrowing a
 *  second pooled connection mid-transaction is the pool-starvation shape fix-wave R4 finding 8
 *  exists to prevent). */
export type CertSignerRow = {
  displayName: string; signatureImage: Uint8Array | null; signatureMimeType: string | null;
};

/** pdfkit embeds PNG and JPEG only. New uploads are constrained to exactly these (users.ts's
 *  SIGNATURE_MIME, §9 amendment 2026-08-05), so this filter is defense in depth for rows uploaded
 *  while image/bmp was still allowed: a non-embeddable image falls back to the
 *  typed-name-over-the-rule rendering exactly as "no signature on file" does (§3.11's own
 *  fallback; a broken render at the printer would serve nobody). */
const EMBEDDABLE_SIGNATURE_MIME = ["image/png", "image/jpeg"];

function signatureDataUri(signer: CertSignerRow): string | null {
  if (!signer.signatureImage || !signer.signatureMimeType) return null;
  if (!EMBEDDABLE_SIGNATURE_MIME.includes(signer.signatureMimeType)) return null;
  return `data:${signer.signatureMimeType};base64,${Buffer.from(signer.signatureImage).toString("base64")}`;
}

/**
 * Assembles the print payload (spec §10.3) off the caller's `db` — inside `printCert` that is the
 * claim-holding `tx` (the `readShippingTicketData` rule). `printDate` travels as an argument so
 * this collector, like the builder, never touches the clock itself.
 *
 * - **To:** the customer at their default `BILL_TO` address (the ticket's Sold To idiom) — §10.3
 *   says only "the customer name and address block", and the billing address is the customer's
 *   own record the way the sample's "To:" block reads.
 * - **Parts** carry scope-appropriate quantities (§10.3): the order's own for ORDER scope; this
 *   shipment's shipped qty/lbs for SHIPMENT (zero for a line the shipment didn't carry — honest,
 *   not blank: the line shipped nothing on this shipment); for LOAD, the load's own qty/weight on
 *   the LEAD line (Phase 3's loads split the lead part's quantity; `Load` carries one qty/weight
 *   pair, not per-line ones) with rider lines keeping their order quantities.
 * - **Requirements** flatten to specification + scale + bare values — min/max/pass/fail/override
 *   never leave this function (§3.21; the builder's input type cannot even carry them).
 * - **Serials** are the ORDER's serial rows with their description (the heat/lot field), grouped
 *   per part line (§10.3 does not scope them per shipment/load, and the description lives on the
 *   order serial).
 */
export async function readCertPdfData(
  db: Db, certId: string, settings: CertPrintSettings, signer: CertSignerRow, printDate: string,
): Promise<{ data: CertPdfData; orderNumber: number }> {
  const detail = await readCertDetail(db, certId); // 404s a missing cert

  const order = await db.order.findFirst({
    where: { id: detail.orderId }, select: { customerId: true },
  });
  if (!order) throw new HttpError(404, "Order not found");

  const addresses = await listAddresses(order.customerId, undefined, db);
  const billTos = addresses.filter((a) => a.kind === "BILL_TO");
  const billTo = billTos.find((a) => a.isDefault) ?? billTos[0] ?? null;

  const lines = await db.orderLine.findMany({
    where: { orderId: detail.orderId },
    orderBy: { position: "asc" },
    select: {
      id: true, position: true, qty: true, weight: true,
      part: { select: { partNumber: true, name: true, description: true } },
    },
  });

  // Scope-appropriate quantities (§10.3) — see the doc comment above.
  let shippedByLineId = new Map<string, { qty: number; weight: number }>();
  if (detail.scope === "SHIPMENT" && detail.shipperId !== null) {
    const so = await db.shipperOrder.findFirst({
      where: { shipperId: detail.shipperId, orderId: detail.orderId }, select: { id: true },
    });
    const shipLines = so === null ? [] : await db.shipperLine.findMany({
      where: { shipperOrderId: so.id }, select: { orderLineId: true, qty: true, weight: true },
    });
    shippedByLineId = new Map(shipLines.flatMap((l) => (l.orderLineId === null
      ? [] // a released snapshot row no longer maps to a live order line
      : [[l.orderLineId, { qty: l.qty, weight: l.weight.toNumber() }] as const])));
  }
  const load = detail.scope === "LOAD" && detail.loadNumber !== null
    ? await db.load.findFirst({ where: { orderId: detail.orderId, loadNumber: detail.loadNumber } })
    : null;

  const parts: CertPartRow[] = lines.map((l) => {
    let qty: number | null = l.qty;
    let pounds: number | null = l.weight.toNumber();
    if (detail.scope === "SHIPMENT") {
      const shipped = shippedByLineId.get(l.id) ?? { qty: 0, weight: 0 };
      qty = shipped.qty;
      pounds = shipped.weight;
    } else if (detail.scope === "LOAD" && l.position === 1) {
      qty = load?.qty ?? null;
      pounds = load === null || load.weight === null ? null : load.weight.toNumber();
    }
    return {
      qty, pounds,
      partNumber: l.part.partNumber, partName: l.part.name, partDescription: l.part.description,
    };
  });

  // Requirement lines the order no longer carries (snapshot + release, rulings 23–24): the cert
  // stays live with those readings frozen, so the archived paper must still NAME the parts they
  // belong to. One row per released line off the requirement snapshots, quantities honest-blank
  // (the live line — and any qty to print — is gone), in the line's own frozen position.
  const releasedReqs = await db.certRequirement.findMany({
    where: { certId, orderLineId: null },
    orderBy: { linePosition: "asc" },
    select: { linePosition: true, partNumber: true, partName: true },
  });
  const seenReleased = new Set<number>();
  for (const r of releasedReqs) {
    if (seenReleased.has(r.linePosition)) continue;
    seenReleased.add(r.linePosition);
    parts.push({ qty: null, pounds: null, partNumber: r.partNumber, partName: r.partName, partDescription: "" });
  }

  const serialRows = await db.orderSerial.findMany({
    where: { orderId: detail.orderId },
    orderBy: { position: "asc" },
    select: { lineId: true, serial: true, description: true },
  });
  const serialBlocks: CertSerialBlock[] = lines.map((l) => ({
    partNumber: l.part.partNumber,
    serials: serialRows.filter((s) => s.lineId === l.id).map((s) => ({ serial: s.serial, description: s.description })),
  }));

  const data: CertPdfData = {
    company: settings.company,
    // "<orderNumber>-<sequence>" for shipment scope, the bare number otherwise (§10.3) —
    // `detail.sequence` is non-null exactly for shipment-scope certs (readCertDetail).
    orderLabel: detail.sequence === null ? String(detail.orderNumber) : `${detail.orderNumber}-${detail.sequence}`,
    printDate,
    entryDate: detail.receivedDate,
    to: {
      name: detail.customerName,
      street: billTo?.street ?? "", city: billTo?.city ?? "", state: billTo?.state ?? "", zip: billTo?.zip ?? "",
    },
    poNumber: detail.poNumber,
    packingListNo: detail.shipperNumber,
    material: detail.material,
    parts,
    statement: settings.statement,
    requirements: detail.requirements.map((r) => ({
      specification: r.inspectionCodeName,
      scale: r.scaleName ?? "",
      readings: r.readings.map((rd) => rd.value).filter((v): v is number => v !== null),
    })),
    serialBlocks,
    freeform: detail.freeform,
    signer: {
      name: signer.displayName,
      // The sample prints a title ("Production Manager") but no title field exists anywhere on
      // this system's User record — "" omits the line rather than fabricating one (CertSigner's
      // own comment, pdf/cert.ts).
      title: "",
      company: settings.company.name,
      signatureDataUri: signatureDataUri(signer),
    },
  };
  return { data, orderNumber: detail.orderNumber };
}

/**
 * Renders and archives the certification, returning the exact bytes stored (spec §5.15's
 * print/reprint contract, task-19-brief.md Step 5). The signature that prints is the PRINTING
 * user's (§3.11) — `signerUserId` is the route's `requireUser().id`, never a selection.
 *
 * `printedAt` is set on the FIRST print only, through `auditedUpdate` inside this same
 * transaction — it is the fact §5.16's post-print gate reads (`replaceReadings` refuses without
 * `edit_cert_results_after_print` once set), so it must commit with the archived document, not
 * before or after it. A voided cert refuses a NEW print with the shared 400 while every stored
 * print stays reprintable forever (spec §5.6).
 */
export async function printCert(
  certId: string, signerUserId: string,
): Promise<{ documentId: string; orderNumber: number; pdf: Buffer }> {
  const settings = await certPrintSettings();
  const printDate = formatDateOnly(todayDateOnly());

  return withDbErrors({ entity: "Cert" }, () => prisma.$transaction(async (tx) => {
    const { orderId } = await claimCertsOrder(tx, certId); // 404s a missing cert, claims its order row
    const cert = await tx.cert.findFirst({ where: { id: certId } });
    if (!cert) throw new HttpError(404, "Certification not found");
    assertPrintable(cert);
    // The OWNING ORDER's void refuses new paper too (spec §5.6): `voidOrder` leaves ORDER/LOAD
    // certs live, so the cert's own `deletedAt` alone cannot carry the rule. Read fresh under
    // the claim just taken — the house rule's whole point.
    const owner = await tx.order.findFirst({ where: { id: orderId }, select: { deletedAt: true } });
    assertPrintable(owner ?? { deletedAt: new Date(0) });

    const signer = await tx.user.findFirst({
      where: { id: signerUserId },
      select: { displayName: true, signatureImage: true, signatureMimeType: true },
    });
    if (!signer) throw new HttpError(404, "User not found");

    const { data, orderNumber } = await readCertPdfData(tx, certId, settings, signer, printDate);
    const pdf = await renderPdf(buildCertDefinition(data));

    if (cert.printedAt === null) {
      await auditedUpdate("cert", certId,
        () => tx.cert.update({ where: { id: certId }, data: { printedAt: new Date() } }), { tx });
    }

    const doc = await storeDocument(tx, { kind: "CERT", certId }, pdf);
    return { documentId: doc.id, orderNumber, pdf };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}

/** Mirrors `voidOrder` (orders.ts): reason trimmed and required IN THE SERVICE (§5.17's shape, so
 *  no future caller can bypass it by skipping the route), `auditedSoftDelete` for the real
 *  before/after diff. Same order-claim discipline as every other mutator here. */
export async function voidCert(id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new HttpError(400, "A reason is required to void a certification");

  await withDbErrors({ entity: "Cert" }, () => prisma.$transaction(async (tx) => {
    await claimCertsOrder(tx, id);
    const cert = await tx.cert.findFirst({ where: { id } });
    if (!cert || cert.deletedAt !== null) throw new HttpError(404, "Certification not found");
    await auditedSoftDelete("cert", id, why, tx);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
