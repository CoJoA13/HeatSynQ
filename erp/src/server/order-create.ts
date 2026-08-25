// #33 — the order CREATE service (spec §5), extracted VERBATIM from orders.ts (byte-parity verified).
// The #115 retry nesting, the §5.14 Serializable-plus-in-transaction-read contract and the
// idempotent-replay behaviour documented on createOrder below describe exactly this file. The shared
// line schemas, part/quote-link resolution and the detail read live in order-internals.ts.
import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors, retryAllocation, isDuplicateClientRequestId } from "./db-errors";
import { orderEntryReadiness } from "./order-entry-readiness";
import { auditedCreate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { currentActor } from "./context";
import { allocateNumber, getSetting } from "./settings";
import { lockCurrentRevision } from "./part-process-steps";
import { resolveCertSettings, createCert, type CertResolution } from "./certs";
import type { QuoteLinkCandidate } from "./quote-links";
import { addBusinessDays, formatDateOnly, todayDateOnly } from "../lib/business-days";
import { CERT_SCOPES } from "../lib/cert-constants";
import { trafficSettings, type Traffic } from "./order-board";
import {
  LINE, CONTAINER_ITEM, CHARGE_ITEM,
  parseDate, lineLabel, resolveLineParts, resolveQuoteLinks, createSerials, lineTotals, runSplitLoads,
  readDetail,
  type OrderDetail, type OrderWarnings, type LineInput, type ResolvedPart,
} from "./order-internals";
const CREATE = z.object({
  customerId: z.string().min(1),
  /**
   * Fix-wave R4 finding 5: the entry form's idempotency nonce, minted when a FRESH entry form
   * mounts and carried inside the autosaved draft payload — so two tabs resuming the SAME draft
   * submit the SAME nonce, and the automatic 409 retry re-submits the identical one.
   *
   * Optional: omitting it keeps the pre-existing behaviour byte for byte (Postgres NULLs never
   * collide in a unique index), which is what makes every non-browser caller — the tests, a
   * future import — unaffected. `uuid()` rather than a free string so a caller cannot accidentally
   * pin a constant and silently make every one of its saves a replay of the first.
   */
  clientRequestId: z.string().uuid().optional(),
  poNumber: z.string().max(200).default(""),
  vsOrderNumber: z.string().max(60).default(""),
  // §3.22: prints on the ticket beside the PO — built with no present-day user on the owner's
  // explicit instruction, same as containers[].customerContainerId above.
  customerJobNo: z.string().max(60).default(""),
  // Spec §6.1: the resolution is "overridable at entry". An omitted key means "no override" —
  // the chain (part → customer → plant) resolves and freezes as always; a present key IS the
  // frozen value, and §6.2's order-scope cert creation follows the EFFECTIVE values either way
  // (an override to LOAD scope creates nothing eagerly; an override to `certRequired: false`
  // suppresses the cert the chain would have produced). `.optional()`, never `.nullable()`:
  // unlike the part/customer columns there is no "inherit" state to store on the order — its
  // columns are always resolved values (Task 17; the UPDATE_ORDER pair below is the
  // "and after" half of the same spec sentence).
  certRequired: z.boolean().optional(),
  certScope: z.enum(CERT_SCOPES).optional(),
  receivedDate: z.string().optional(),
  requestDate: z.string().optional(),
  targetDate: z.string().nullable().optional(),
  notes: z.string().max(4000).default(""),
  lines: z.array(LINE).min(1),
  containers: z.array(CONTAINER_ITEM).default([]),
  charges: z.array(CHARGE_ITEM).default([]),
}).strict();

type CreateInput = z.infer<typeof CREATE>;
/** Non-blocking notices returned alongside the saved order (spec §5.5). Neither of these ever
 *  refuses a save — credit hold warns and never blocks (owner ruling §3), and a missing serial
 *  list is something the operator finishes later. */
function buildWarnings(
  customer: { code: string; name: string; creditHold: boolean },
  parts: ResolvedPart[], lines: LineInput[],
): OrderWarnings {
  const warnings = lines.flatMap((line, i) =>
    parts[i].serializationRequired && line.serials.length === 0
      ? [`${lineLabel(i, parts[i])}: serialization required but no serials entered`]
      : []);
  if (customer.creditHold) warnings.push(`${customer.code} · ${customer.name} is on credit hold`);
  return warnings;
}

/**
 * The create entry's `after` snapshot. Composed by hand rather than read back — `auditedCreate`
 * takes the payload as an argument, which is the chance to shape it: every collection is ordered
 * by construction (issue #24 — an unordered collection makes two identical snapshots render as a
 * spurious diff), each foreign key travels with the live name it points at so history reads
 * "3541720C3" and "Basket" rather than cuids (the rule `SNAPSHOT_INCLUDE.order` follows for
 * update diffs), and nothing file-shaped comes anywhere near it.
 *
 * Row ids are absent because they do not exist yet; serials are keyed by their line's POSITION
 * for the same reason, which also happens to read better than a cuid would.
 */
function auditPayload(args: {
  orderNumber: number;
  customer: { id: string; code: string };
  data: CreateInput;
  parts: ResolvedPart[];
  receivedDate: Date; requestDate: Date; targetDate: Date | null;
  revisionNumber: number;
  loads: { qty: number; weight: number }[];
  containerTypeNames: Map<string, string>;
  certResolution: CertResolution;
  quoteLinks: (QuoteLinkCandidate | null)[];
}) {
  const { orderNumber, customer, data, parts, loads, containerTypeNames, certResolution } = args;
  return {
    orderNumber,
    customerId: customer.id, customerCode: customer.code,
    poNumber: data.poNumber, vsOrderNumber: data.vsOrderNumber, customerJobNo: data.customerJobNo,
    receivedDate: formatDateOnly(args.receivedDate),
    requestDate: formatDateOnly(args.requestDate),
    targetDate: args.targetDate === null ? null : formatDateOnly(args.targetDate),
    // Not written by createOrder — the column default, recorded so the create entry and every
    // later update diff describe the same set of fields.
    status: "OPEN",
    notes: data.notes,
    // The EFFECTIVE values frozen at the moment of this save (spec §6.1): the chain's own
    // resolution, unless the caller sent an explicit entry-time override (Task 17) — the audit
    // entry proves what actually froze on at save time, ahead of any later part edit.
    certRequired: certResolution.certRequired, certScope: certResolution.certScope,
    lines: data.lines.map((line, i) => ({
      position: i + 1, partId: line.partId, partNumber: parts[i].partNumber,
      revisionNumber: i === 0 ? args.revisionNumber : null, qty: line.qty, weight: line.weight,
      // The resolved link (explicit or auto — §5.2), with the quote NUMBER beside the id so the
      // create entry and every later update diff (SNAPSHOT_INCLUDE.order pulls the same pair)
      // describe the same fields and history reads "1006", never a cuid.
      quoteLineId: args.quoteLinks[i]?.quoteLineId ?? null,
      quoteNumber: args.quoteLinks[i]?.quoteNumber ?? null,
    })),
    containers: data.containers.map((c, i) => ({
      position: i + 1, typeId: c.typeId, typeName: containerTypeNames.get(c.typeId) ?? null,
      count: c.count, qty: c.qty ?? null,
      tareWeight: c.tareWeight ?? null, grossWeight: c.grossWeight ?? null,
      // `.optional()`, not `.default("")` (the brief's exact shape) — an omitted key parses to
      // `undefined`, and `redact()`'s `JSON.stringify` round-trip DROPS a key whose value is
      // `undefined` rather than keeping it, so the audit snapshot would silently lose this column
      // for the ordinary (omitted) case without this fallback. `?? ""` matches both the column's
      // own DB default and every sibling optional field in this same object literal.
      customerContainerId: c.customerContainerId ?? "",
    })),
    serials: data.lines.flatMap((line, i) => line.serials.map((s, index) => ({
      linePosition: i + 1, position: index + 1, serial: s.serial, description: s.description,
    }))),
    loads: loads.map((l, i) => ({ loadNumber: i + 1, qty: l.qty, weight: l.weight })),
    charges: data.charges.map((c, i) => ({
      position: i + 1, description: c.description, amount: c.amount ?? null,
    })),
  };
}

/**
 * The order save (spec §5). One `withDbErrors` → Serializable `$transaction`, in this order:
 * validate → allocate → lock → assert container types → split → write → clear the draft.
 *
 * Serializable is required by the registered-FK writer pattern for `containers[].typeId`
 * (`assertRefExists` on the caller's own `tx` is only half of the reference-delete TOCTOU
 * guard — the other half is deleteReference's Serializable blocker scan). It is emphatically NOT
 * what protects the locked revision: `lockCurrentRevision`'s `SELECT … FOR UPDATE` row lock is
 * the guarantee (spec §5.3), and this transaction's isolation level is irrelevant to it.
 *
 * ⚠️ Since Phase 6, Serializable is ALSO load-bearing for the §5.14 quote-link pairing — no
 * longer mere uniformity, and never downgrade it: `resolveQuoteLinks`' eligibility read of the
 * quote line this save links (on this same `tx` — both halves matter, the isolation level AND
 * the in-transaction read) pairs with `updateQuote`/`deleteQuote`'s Serializable OrderLine-
 * predicate guard so SSI aborts a link racing a quote-line drop (quote-links.test.ts's
 * dangerous-direction test is the tripwire). One race is deliberately NOT prevented and no
 * hardening should assume it is: a link committing concurrently onto a just-CLOSED quote is
 * spec-sanctioned (judged-at-link-time, ruling 6 — the `OrderLine.quoteLineId` schema comment);
 * `closeQuote` runs claim-only, so isolation does not stop it, by design.
 *
 * A serialization failure — two saves colliding on the number sequence or on the same part's
 * revision — surfaces as the retryable 409 `withDbErrors` already maps 40001 to. Nothing is
 * written, and no order number is consumed.
 *
 * Fix-wave R4 finding 5 (the idempotency half): if the INSERT collides on `clientRequestId`, this
 * exact request has already been saved — by the other tab, or by this same tab's first attempt
 * before a 409 sent it back for a retry. The honest answer is the order that request already
 * created, not a second order carrying the next number: THAT is the double-billing adjacency the
 * no-duplication rule exists to prevent (spec §15), and it was reachable through the entry page's
 * own automatic 409 retry, which resubmits the identical intent by design.
 *
 * The replay response is deliberately warning-free and flagged `deduped: true`. Warnings describe
 * a save that is happening; this one already happened, and its warnings were part of the
 * response the winning submission got. `deduped` is what lets the client tell the two apart —
 * added, never substituted, so every existing caller reading `{ order, warnings }` is untouched.
 */
export async function createOrder(
  input: unknown,
): Promise<{ order: OrderDetail; warnings: OrderWarnings; deduped?: true }> {
  const data = CREATE.parse(input);

  // Settings are read-only and take no `tx`. Reading them BEFORE the transaction opens keeps a
  // second-connection read out of a Serializable transaction that goes on to lock a Setting row
  // itself (allocateNumber) — the shape a deadlock gets introduced through later.
  const defaultRequestDays = await getSetting("request_days_default");
  const traffic = await trafficSettings();

  // Idempotency BEFORE the gate (Codex): a retried request whose order already committed must get
  // that order back — even if an admin has since cleared a company field or the A/R account. The
  // gate runs only for genuine first submissions; a delayed retry carrying a committed nonce would
  // otherwise receive a setup-400 instead of its existing order, breaking the replay contract. (The
  // collision-replay in the catch below still handles the concurrent-first-submission race.)
  if (data.clientRequestId) {
    const existing = await prisma.order.findFirst({
      where: { clientRequestId: data.clientRequestId }, select: { id: true },
    });
    if (existing) {
      return { order: await readDetail(prisma, existing.id, traffic), warnings: [], deduped: true };
    }
  }

  // Order-entry gate (Phase 8B §5.6): real order entry is blocked until company identity AND a
  // chart of accounts are configured. Evaluated here as a PRE-transaction read (alongside the
  // settings reads above), BEFORE saveNewOrder's Serializable transaction — inside Serializable it
  // would enlarge the predicate read-set and turn a concurrent config edit into a no-retry abort.
  // TOCTOU is benign: the gated facts are admin-only install config and a one-order race either
  // way violates no invariant. (order-drafts.ts is scratch storage and writes no Order, so this is
  // the single chokepoint.)
  const readiness = await orderEntryReadiness();
  if (!readiness.ready) {
    throw new HttpError(
      400,
      `Finish setup before entering orders — ${readiness.gaps.map((g) => g.label).join("; ")}. ` +
        `Complete setup on the Setup page (/setup).`,
    );
  }

  // `retryAllocation` (#115) wraps the try/catch, and the nesting is the whole point. A 40001 from
  // `allocateNumber`'s Serializable claim is rethrown by the catch below (it is not a
  // `clientRequestId` collision) and absorbed by the retry, which re-runs on a fresh snapshot — so
  // two clerks saving at the same instant both get an order instead of one getting a 409. A
  // `clientRequestId` collision, by contrast, is answered by the replay on the FIRST attempt and
  // never retried: it is already the right answer, and re-running it would only fail identically.
  // The pre-transaction reads above stay outside — they are read-only install config, and re-running
  // them per attempt would buy nothing (the `closePeriod` precedent re-reads its aging inside the
  // retry only because that figure is what it goes on to reconcile).
  return withDbErrors({ entity: "Order", conflictField: "order number" }, () => retryAllocation(async () => {
    try {
      return await saveNewOrder(data, defaultRequestDays, traffic);
    } catch (err) {
      // The replay. Deliberately INSIDE withDbErrors' callback and OUTSIDE the transaction: by the
      // time this runs the failed attempt has fully rolled back (no number consumed), and the
      // winning order is committed and readable. Anything that is not this exact collision falls
      // straight through to withDbErrors' own translation, unchanged.
      if (!data.clientRequestId || !isDuplicateClientRequestId(err)) throw err;
      const existing = await prisma.order.findFirst({
        where: { clientRequestId: data.clientRequestId }, select: { id: true },
      });
      // Unreachable in practice — the collision IS the proof a row holds this nonce — but a
      // missing row is not something to invent an answer for: report the original failure.
      if (!existing) throw err;
      return { order: await readDetail(prisma, existing.id, traffic), warnings: [], deduped: true };
    }
  }));
}

/**
 * The save transaction itself, unchanged in substance — split out of `createOrder` only so the
 * idempotent-replay catch above wraps ONE call rather than being threaded through a 100-line
 * transaction body. Everything about the ordering, the isolation level and the rollback
 * guarantees documented on `createOrder` describes this function.
 */
async function saveNewOrder(
  data: CreateInput, defaultRequestDays: number, traffic: Traffic,
): Promise<{ order: OrderDetail; warnings: OrderWarnings }> {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.findFirst({ where: { id: data.customerId, deletedAt: null } });
    if (!customer) throw new HttpError(400, "That customer does not exist");
    if (!customer.active) throw new HttpError(400, "That customer is inactive");

    const parts = await resolveLineParts(tx, customer.id, data.lines);
    const lead = parts[0];

    // Resolved and FROZEN onto the order right here, at save (spec §6.1) — never re-derived from
    // a part edited after the fact. `data.lines[0].partId` is the lead, matching every other
    // most-specific-wins chain in this function (requestDate just below). An explicit entry-time
    // override (Task 17, §6.1's "overridable at entry") beats the chain per field; the EFFECTIVE
    // pair is what freezes on, what the audit entry records, and what decides the §6.2 eager
    // order-scope cert below. The chain still resolves even when both keys are overridden —
    // one extra read inside an already-open transaction, in exchange for never forking this
    // function's control flow on which keys happened to arrive.
    const resolved = await resolveCertSettings(tx, customer.id, data.lines.map((l) => l.partId));
    const certResolution: CertResolution = {
      certRequired: data.certRequired ?? resolved.certRequired,
      certScope: data.certScope ?? resolved.certScope,
    };

    const receivedDate = data.receivedDate
      ? parseDate(data.receivedDate, "Received date")
      : todayDateOnly();
    // Most-specific-wins and silent (spec §6): the LEAD part's override, else the customer's,
    // else the plant default — never a rider's.
    const requestDate = data.requestDate
      ? parseDate(data.requestDate, "Request date")
      : addBusinessDays(receivedDate,
        lead.requestDaysOverride ?? customer.requestDaysOverride ?? defaultRequestDays);
    const targetDate = data.targetDate ? parseDate(data.targetDate, "Target date") : null;

    // Per-line quote links (spec §5.2), judged AT LINK TIME against THIS order's received date
    // (ruling 6). On `tx`, before the allocation below — validation refuses before a number is
    // consumed, and the in-transaction read is the §5.14 SSI pairing's order-side half (see
    // resolveQuoteLinks' own ⚠️ comment).
    const quoteLinks = await resolveQuoteLinks(tx, customer.id, receivedDate, data.lines, parts);

    const orderNumber = await allocateNumber("order_number_next", tx);
    const { revisionNumber } = await lockCurrentRevision(lead.id, tx); // the row lock IS the guarantee

    // Two reads per distinct type, deliberately. `assertRefExists` is the mandated writer-side
    // half of the reference-delete TOCTOU guard and returns nothing; the names are for the
    // audit payload, which must read "Basket" rather than a cuid. No `deletedAt` filter on the
    // second read — the assert above has already refused every id that is not live.
    const typeIds = [...new Set(data.containers.map((c) => c.typeId))];
    for (const typeId of typeIds) await assertRefExists("containerType", typeId, tx);
    const containerTypeNames = new Map(typeIds.length === 0 ? [] :
      (await tx.containerType.findMany({ where: { id: { in: typeIds } }, select: { id: true, name: true } }))
        .map((t) => [t.id, t.name] as const));

    // The lead part's caps, passed straight through — splitLoads trusts pre-validated input
    // (a zero loadQty would not terminate), and parts.ts already enforces loadQty ≥ 1 and
    // loadWeight > 0 when present, so nothing is synthesized here. `runSplitLoads`, not
    // `splitLoads` directly: translates a >MAX_LOADS refusal into a clean 400 (finding 3).
    const loads = runSplitLoads({
      ...lineTotals(data.lines),
      loadQty: lead.loadQty,
      loadWeight: lead.loadWeight === null ? null : lead.loadWeight.toNumber(),
    });

    const order = await auditedCreate(
      "order",
      auditPayload({
        orderNumber, customer, data, parts, receivedDate, requestDate, targetDate,
        revisionNumber, loads, containerTypeNames, certResolution, quoteLinks,
      }),
      () => tx.order.create({
        data: {
          orderNumber, customerId: customer.id,
          // The nonce rides on the row itself: a replay of this same request collides HERE, on
          // the unique index, rather than quietly allocating the next number (R4 finding 5).
          clientRequestId: data.clientRequestId ?? null,
          poNumber: data.poNumber, vsOrderNumber: data.vsOrderNumber, customerJobNo: data.customerJobNo,
          certRequired: certResolution.certRequired, certScope: certResolution.certScope,
          receivedDate, requestDate, targetDate, notes: data.notes,
          lines: {
            create: data.lines.map((line, i) => ({
              position: i + 1, partId: line.partId,
              // Non-null on position 1 and nowhere else — the order's locked recipe is the
              // pair (lines[0].partId, lines[0].revisionNumber). Spec §4.
              revisionNumber: i === 0 ? revisionNumber : null,
              qty: line.qty, weight: line.weight,
              quoteLineId: quoteLinks[i]?.quoteLineId ?? null,
            })),
          },
          containers: {
            create: data.containers.map((c, i) => ({
              position: i + 1, typeId: c.typeId, count: c.count, qty: c.qty ?? null,
              tareWeight: c.tareWeight ?? null, grossWeight: c.grossWeight ?? null,
              customerContainerId: c.customerContainerId,
            })),
          },
          loads: { create: loads.map((l, i) => ({ loadNumber: i + 1, qty: l.qty, weight: l.weight })) },
          charges: {
            create: data.charges.map((c, i) => ({
              position: i + 1, description: c.description, amount: c.amount ?? null,
            })),
          },
        },
        select: { id: true, lines: { select: { id: true }, orderBy: { position: "asc" } } },
      }),
      { tx },
    );

    await createSerials(tx, order.id, order.lines.map((l) => l.id), data.lines, parts);

    // ORDER-scope certs are created here, at save (spec §6.2, owner ruling §3.17) — the ONLY
    // scope created eagerly. SHIPMENT scope is created when a shipment is created (Task 8); LOAD
    // scope is created on demand from the order hub, deliberately, since Phase 3 keeps loads
    // editable and re-splittable after save. `tx` threads through so the cert commits or rolls
    // back with the order it belongs to, and `claimOrder` inside `createCert` re-locks the row
    // this same transaction just inserted — a no-op wait, since nothing else can see it yet.
    if (certResolution.certRequired && certResolution.certScope === "ORDER") {
      await createCert({ orderId: order.id, scope: "ORDER" }, tx);
    }

    // Same transaction as the save (spec §5.5): the scratch draft dies exactly when the order
    // it became is committed, and survives untouched if anything above rolled back.
    const actor = currentActor();
    if (actor.id) {
      await tx.orderDraft.updateMany({ where: { userId: actor.id }, data: { payload: Prisma.DbNull } });
    }

    return {
      order: await readDetail(tx, order.id, traffic),
      warnings: buildWarnings(customer, parts, data.lines),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

/**
 * The §6 chain (`part.requestDaysOverride ?? customer.requestDaysOverride ??
 * request_days_default`) applied to a base date, for `GET /api/orders/entry-defaults` — the
 * entry page's prefill preview before an order exists at all. `createOrder` runs this identical
 * chain inline against the order's own (possibly backdated) `receivedDate`; `receivedDate` here
 * is that SAME optional override, so the preview and the eventual save agree — omitted (or
 * blank), this falls back to `todayDateOnly()`, the identical default `createOrder` itself uses
 * when `receivedDate` is omitted (spec §5.1), since a fresh, not-yet-backdated order is, by
 * construction, received today.
 *
 * Fix-wave finding 1: before `receivedDate` existed here, the preview always computed from today
 * even after the operator backdated the received date on the entry form, so an order saved with
 * an overridden `receivedDate` could show a request date at save time that never matched what
 * the preview showed moments before. Passing the same override through closes that gap.
 *
 * Existence-checked (a bogus id must 400, not crash reading `.requestDaysOverride` off `null`)
 * and cross-checked when both ids are given (a part from another customer would silently preview
 * a number that could never be saved), but deliberately NOT active-checked: this is a preview,
 * never a commitment, and `createOrder` is what actually refuses to save against an inactive
 * customer or part.
 */
export async function defaultRequestDate(customerId: string, partId?: string, receivedDate?: string): Promise<string> {
  if (!customerId) throw new HttpError(400, "customerId is required");

  const customer = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: { requestDaysOverride: true },
  });
  if (!customer) throw new HttpError(400, "That customer does not exist");

  let partOverride: number | null = null;
  if (partId) {
    const part = await prisma.part.findFirst({
      where: { id: partId, deletedAt: null }, select: { customerId: true, requestDaysOverride: true },
    });
    if (!part) throw new HttpError(400, "That part does not exist");
    if (part.customerId !== customerId) throw new HttpError(400, "That part belongs to another customer");
    partOverride = part.requestDaysOverride;
  }

  const defaultRequestDays = await getSetting("request_days_default");
  const days = partOverride ?? customer.requestDaysOverride ?? defaultRequestDays;
  const base = receivedDate ? parseDate(receivedDate, "Received date") : todayDateOnly();
  return formatDateOnly(addBusinessDays(base, days));
}

