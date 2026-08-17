/**
 * Assembles, renders and archives an open-item customer statement (Task 12, P5B design spec §8).
 *
 * `buildStatement` composes a `StatementData` (owned by `pdf/statement.ts`, re-exported here) —
 * the open invoices/credits with a balance, the point-in-time aging summary reusing `aging.ts`'s
 * pure `bucketAging` ("one pure aging function serves both the report and the statement's
 * summary" — spec §6), and an opt-in finance-charge line — off the SAME point-in-time discipline
 * aging uses: only invoices finalized on/before `asOf`, only applications applied on/before `asOf`
 * (spec §6/§8: "a statement re-run for a past as-of date reproduces exactly what was sent").
 *
 * `printStatement` follows the 5A print bracket (`invoicePrintSettings` read OUTSIDE the
 * transaction, render, `storeDocument` UNDER the transaction) and archives the result as a
 * STATEMENT document owned by the customer — permanently, byte-exact on reprint (`getDocument`),
 * exactly like every other document kind in this codebase. Unlike an invoice/cert/traveler print,
 * a statement owns no single order/invoice row of its own to CLAIM — it is a composed report over
 * many invoices, not a mutation of one entity's own state — so there is no row claim in this
 * bracket (task-12-brief.md's own description of it carries none); the transaction is Serializable
 * only to pair with `storeDocument`'s `auditedCreate` FK-writer convention, the same as every
 * other 5A/5B mutator (CLAUDE.md: never present isolation as the lock — there is no lock to
 * misrepresent here, because there is no cross-transaction invariant a concurrent write could
 * violate: a statement is a point-in-time snapshot by construction, and two concurrent prints of
 * the same customer simply produce two independent, individually-consistent archived documents).
 *
 * Phase 7 Task 13: `printStatementInTx` resolves the customer's STATEMENT template (§5.2) on that
 * same claim-free Serializable transaction — correct by §5.1 immutability, not by locking — renders
 * `buildStatementDefinition` against the resolved config + logo, and stamps `resolved.versionId`
 * onto the archived row. **The statement is a FULLY-LIVE rebuild** (the third snapshot posture,
 * the OPPOSITE of the invoice's frozen paper): the config only styles the paper — the numbers are
 * rebuilt live from A/R every print, so a data change between two prints shows in the second.
 *
 * `runStatements` prints one statement for every customer carrying a NONZERO net balance as of the
 * chosen date — never combining family (spec §8: "combined" vs. "per-division" is a choice made
 * PER print, not run-wide; the run treats every customer independently).
 */
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { invoiceOpenBalance, creditRemaining, paymentOnAccount, type ApplicationLite } from "./ar-balances";
import { bucketAging, type AgingRow, type CustomerRef } from "./aging";
import { financeCharge, financeChargeRateFor } from "./finance-charges";
import { getBillingConfig } from "./billing-config";
import { listAddresses, type AddressRow } from "./customer-addresses";
import { invoicePrintSettings, type InvoicePrintSettings } from "./invoices";
import { getSetting } from "./settings";
import { renderPdf, jpegDataUri, pngDataUri } from "./pdf/render";
import { buildStatementDefinition, type StatementData } from "./pdf/statement";
import { storeDocument } from "./documents";
import { resolveTemplateForPrint } from "./template-assignments";
import type { ApplicationTypeValue } from "../lib/ar-constants";
import { invoiceDocumentNumber } from "../lib/invoice-constants";
import { parseDateOnly, formatDateOnly, todayDateOnly } from "../lib/business-days";

export type { StatementData };

type Db = Prisma.TransactionClient;

export type StatementOpts = { asOf?: string; combineFamily: boolean; assessFinanceCharges: boolean };
export type RunStatementsOpts = { asOf?: string; assessFinanceCharges: boolean };

/** `parseDateOnly` at the service boundary, field-anchored — the `aging.ts` `parseAsOf` precedent
 *  (duplicated; private there). */
function parseAsOf(value: string): Date {
  try {
    return parseDateOnly(value);
  } catch {
    throw new HttpError(400, `"${value}" is not a valid date (yyyy-mm-dd) for As-of date`);
  }
}

const cents = (n: number): number => Math.round(n * 100);

const CUSTOMER_REF_SELECT = { id: true, code: true, name: true } satisfies Prisma.CustomerSelect;

// -------------------------------------------------------------------------------------------
// The point-in-time snapshot read — the `aging.ts` `readSnapshot` shape, duplicated (it is
// private there, not exported) and widened with the per-document fields `bucketAging` doesn't
// need but the open-item table and the finance-charge base do (`financeChargeExempt`,
// `creditNumber`, `orderNumber`, `invoiceDate`). Structurally compatible with `bucketAging`'s own
// (unexported) `Snapshot` parameter type, so it is handed straight to `bucketAging` below with no
// adapter — extra fields on a passed VARIABLE (as opposed to an inline literal) are not an excess-
// property error.
// -------------------------------------------------------------------------------------------

type SnapshotInvoice = {
  id: string; customerId: string; kind: "INVOICE" | "CREDIT"; total: number;
  invoiceDate: string; dueDate: string | null; finalizedAt: string | null;
  financeChargeExempt: boolean; creditNumber: number | null; orderNumber: number;
};
type SnapshotApplication = {
  invoiceId: string; creditInvoiceId: string | null; type: ApplicationTypeValue;
  amount: number; appliedDate: string;
};
// Widened past `bucketAging`'s `{ customerId; amount; appliedPaymentTotal }` (still structurally
// compatible — the extra fields are on a passed VARIABLE, not an inline literal) with the
// per-document identity the open-item PAYMENT line needs: the check reference for its label, and
// `receivedDate` for its date. `appliedPaymentTotal` is the point-in-time PAYMENT total (the query
// filters `appliedDate ≤ asOf`), so the on-account line reconciles to the SAME `aging.unapplied`
// on-account bucketAging folds it into.
type SnapshotPayment = {
  customerId: string; amount: number; appliedPaymentTotal: number;
  reference: string; receivedDate: string;
};
type Snapshot = { invoices: SnapshotInvoice[]; applications: SnapshotApplication[]; payments: SnapshotPayment[] };

async function readFamilySnapshot(db: Db, customerIds: string[], asOfDate: Date): Promise<Snapshot> {
  if (customerIds.length === 0) return { invoices: [], applications: [], payments: [] };

  const invoiceRows = await db.invoice.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null, status: "FINALIZED" },
    orderBy: [{ invoiceDate: "asc" }, { id: "asc" }],
    select: {
      id: true, customerId: true, kind: true, total: true, invoiceDate: true, dueDate: true,
      finalizedAt: true, financeChargeExempt: true, creditNumber: true,
      order: { select: { orderNumber: true } },
    },
  });
  const invoiceIds = invoiceRows.map((i) => i.id);

  const applicationRows = invoiceIds.length === 0 ? [] : await db.application.findMany({
    where: { deletedAt: null, OR: [{ invoiceId: { in: invoiceIds } }, { creditInvoiceId: { in: invoiceIds } }] },
    select: { invoiceId: true, creditInvoiceId: true, type: true, amount: true, appliedDate: true },
  });

  const paymentRows = await db.payment.findMany({
    where: { customerId: { in: customerIds }, deletedAt: null, receivedDate: { lte: asOfDate } },
    select: {
      customerId: true, amount: true, reference: true, receivedDate: true,
      applications: { where: { deletedAt: null, type: "PAYMENT", appliedDate: { lte: asOfDate } }, select: { amount: true } },
    },
  });

  return {
    invoices: invoiceRows.map((i) => ({
      id: i.id, customerId: i.customerId, kind: i.kind, total: i.total.toNumber(),
      invoiceDate: formatDateOnly(i.invoiceDate),
      dueDate: i.dueDate ? formatDateOnly(i.dueDate) : null,
      finalizedAt: i.finalizedAt ? formatDateOnly(i.finalizedAt) : null,
      financeChargeExempt: i.financeChargeExempt, creditNumber: i.creditNumber,
      orderNumber: i.order.orderNumber,
    })),
    applications: applicationRows.map((a) => ({
      invoiceId: a.invoiceId, creditInvoiceId: a.creditInvoiceId, type: a.type,
      amount: a.amount.toNumber(), appliedDate: formatDateOnly(a.appliedDate),
    })),
    payments: paymentRows.map((p) => ({
      customerId: p.customerId, amount: p.amount.toNumber(),
      appliedPaymentTotal: p.applications.reduce((sum, a) => sum + a.amount.toNumber(), 0),
      reference: p.reference, receivedDate: formatDateOnly(p.receivedDate),
    })),
  };
}

/** The applications relevant to ONE row, asOf-filtered — the `aging.ts` `liveAsOf` precedent
 *  (duplicated; private there). Every `SnapshotApplication` is already live by construction
 *  (`readFamilySnapshot` only ever queries `deletedAt: null` rows). */
function appsAsOf(
  apps: SnapshotApplication[], asOfMs: number, match: (a: SnapshotApplication) => boolean,
): ApplicationLite[] {
  return apps
    .filter((a) => match(a) && parseDateOnly(a.appliedDate).getTime() <= asOfMs)
    .map((a) => ({ amount: a.amount, type: a.type, deletedAt: null }));
}

/** Sums a set of `AgingRow`s into one combined family-total row, in integer cents — the
 *  `aging.ts` `sumRows` precedent (duplicated; private there). */
function sumAgingRows(rows: AgingRow[], as: CustomerRef): AgingRow {
  const sum = (key: Exclude<keyof AgingRow, "customerId" | "customerCode" | "customerName" | "isFamilyTotal">): number =>
    rows.reduce((total, r) => total + cents(r[key]), 0) / 100;
  return {
    customerId: as.id, customerCode: as.code, customerName: as.name,
    current: sum("current"), d1_30: sum("d1_30"), d31_60: sum("d31_60"),
    d61_90: sum("d61_90"), d90_plus: sum("d90_plus"), unapplied: sum("unapplied"), net: sum("net"),
  };
}

/** The default BILL_TO address's lines — the `invoices.ts` `renderAddress` precedent (duplicated;
 *  private there), returning an array of lines rather than a "\n"-joined block (the
 *  `InvoicePdfData.billTo` shape this mirrors). A statement is a LIVE document, never frozen paper
 *  the way an invoice is — it reads the customer's CURRENT default address every time it is
 *  built, not a snapshot frozen at some earlier save. */
function billToLines(addr: AddressRow | null, fallbackName: string): string[] {
  const name = addr && addr.name !== "" ? addr.name : fallbackName;
  const cityLine = addr ? [addr.city, [addr.state, addr.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") : "";
  return [name, addr?.street ?? "", cityLine].filter((s) => s !== "");
}

function pickDefaultBillTo(addresses: AddressRow[]): AddressRow | null {
  const billTos = addresses.filter((a) => a.kind === "BILL_TO");
  return billTos.find((a) => a.isDefault) ?? billTos[0] ?? null;
}

// -------------------------------------------------------------------------------------------
// buildStatement
// -------------------------------------------------------------------------------------------

async function buildStatementInTx(
  db: Db, customerId: string, opts: StatementOpts, settings: InvoicePrintSettings,
): Promise<StatementData> {
  const asOf = opts.asOf ?? formatDateOnly(todayDateOnly());
  const asOfDate = parseAsOf(asOf);
  const asOfMs = asOfDate.getTime();

  const customer = await db.customer.findFirst({
    where: { id: customerId, deletedAt: null },
    select: { id: true, code: true, name: true, financeChargeRate: true },
  });
  if (!customer) throw new HttpError(404, "Customer not found");

  // Family, on demand (spec §8, ruling 10): `combineFamily` rolls in every LIVE child. A plain
  // customer (or `combineFamily: false`) is just itself — the `aging.ts` family-roll-up shape,
  // but decided by the CALLER's flag rather than "does this customer happen to have children",
  // so a parent-with-children statement built `combineFamily: false` still reports only its own
  // activity (the "per-division" choice — spec §8 — is made per print, this is where it lands).
  const children = opts.combineFamily
    ? await db.customer.findMany({ where: { parentId: customerId, deletedAt: null }, select: CUSTOMER_REF_SELECT })
    : [];
  const familyRefs: CustomerRef[] = [{ id: customer.id, code: customer.code, name: customer.name }, ...children];
  const familyIds = familyRefs.map((c) => c.id);

  const [snap, billingConfig, addresses, prefix] = await Promise.all([
    readFamilySnapshot(db, familyIds, asOfDate),
    getBillingConfig(db),
    listAddresses(customerId, undefined, db),
    getSetting("invoice_number_prefix", db),
  ]);

  // The aging summary — `bucketAging` (the SAME pure core the aging report uses, spec §6) over
  // exactly the family set above; combined into one row when there's more than one (the "combined"
  // family statement — spec §8), otherwise the sole row is already correct.
  const agingRows = bucketAging(snap, asOf, familyRefs);
  const aging = familyRefs.length === 1
    ? agingRows[0]
    : sumAgingRows(agingRows, { id: customer.id, code: customer.code, name: customer.name });

  const openItems: StatementData["openItems"] = [];
  const pastDueBalances: { open: number; exempt: boolean }[] = [];

  for (const inv of snap.invoices) {
    // Point-in-time (§6/§8, the aging precedent): not yet finalized as of this asOf never appears.
    if (!inv.finalizedAt || parseDateOnly(inv.finalizedAt).getTime() > asOfMs) continue;

    if (inv.kind === "INVOICE") {
      const apps = appsAsOf(snap.applications, asOfMs, (a) => a.invoiceId === inv.id);
      const open = invoiceOpenBalance(inv.total, apps);
      if (cents(open) <= 0) continue; // fully settled as of this asOf — not an open item

      openItems.push({
        documentNumber: invoiceDocumentNumber("INVOICE", null, inv.orderNumber, prefix),
        date: inv.invoiceDate, dueDate: inv.dueDate, kind: "INVOICE", original: inv.total, open,
      });

      // The finance-charge base: non-exempt, PAST-DUE (dueDate < asOf — `bucketFor`'s own
      // daysPastDue > 0 line) open invoices only. Collected regardless of `assessFinanceCharges`
      // so the gate below stays a single, obvious branch.
      const dueMs = inv.dueDate ? parseDateOnly(inv.dueDate).getTime() : null;
      if (dueMs !== null && dueMs < asOfMs) {
        pastDueBalances.push({ open, exempt: inv.financeChargeExempt });
      }
    } else {
      // CREDIT — its remaining shows as its OWN open item, negative (§8: "open credits … as
      // negatives"); it carries no due date (aging.ts's own "a CREDIT gets none"). On-account
      // PAYMENTs get their own negative lines below (§8: "on-account as negatives").
      const apps = appsAsOf(snap.applications, asOfMs, (a) => a.creditInvoiceId === inv.id);
      const remaining = creditRemaining(inv.total, apps);
      if (cents(remaining) <= 0) continue;

      openItems.push({
        documentNumber: invoiceDocumentNumber("CREDIT", inv.creditNumber, inv.orderNumber, prefix),
        date: inv.invoiceDate, dueDate: null, kind: "CREDIT", original: inv.total, open: -remaining,
      });
    }
  }

  // On-account payments as NEGATIVE open items (§8: "on-account as negatives"). Each payment's
  // unapplied cash gets its own line so the open-item lines SUM to Total Due — before this, an
  // invoice + an on-account payment printed one positive line and a lower Total Due, and the
  // document didn't reconcile. `paymentOnAccount` over `appliedPaymentTotal` (the PAYMENT total
  // already point-in-time-cut to `appliedDate ≤ asOf` at the query — `receivedDate ≤ asOf` is
  // likewise guaranteed by `readFamilySnapshot`'s own filter) is the SAME on-account basis
  // `bucketAging` folds into `aging.unapplied`, so these lines and the aging strip reconcile.
  for (const pay of snap.payments) {
    const onAccount = paymentOnAccount(pay.amount, [{ amount: pay.appliedPaymentTotal, type: "PAYMENT", deletedAt: null }]);
    if (cents(onAccount) <= 0) continue; // fully applied as of this asOf — no on-account line

    openItems.push({
      documentNumber: pay.reference !== "" ? pay.reference : "Payment on account",
      date: pay.receivedDate, dueDate: null, kind: "PAYMENT", original: pay.amount, open: -onAccount,
    });
  }

  // Finance charges — informational-only, opt-in per run (spec §7/§8). `null` unless the caller
  // assessed them AND something non-exempt is actually past due (a computed $0.00 line is not
  // printed either — `financeCharge` returning exactly 0 collapses to the same `null`).
  let financeChargeAmount: number | null = null;
  if (opts.assessFinanceCharges) {
    const rate = financeChargeRateFor(customer.financeChargeRate?.toNumber() ?? null, billingConfig.financeChargeRate);
    const computed = financeCharge({ pastDueBalances, rate });
    financeChargeAmount = computed > 0 ? computed : null;
  }

  const billTo = billToLines(pickDefaultBillTo(addresses), customer.name);

  return {
    asOf, company: settings.company, remitTo: settings.remitTo,
    customer: { code: customer.code, name: customer.name, billTo },
    openItems, aging,
    financeCharge: financeChargeAmount,
    totalDue: aging.net, // buckets − unapplied = the net owed (the SAME number `aging.net` is)
  };
}

/** Builds a statement's data WITHOUT archiving it (a preview — Task 12's UI reads this before the
 *  customer commits to a print). `settings` is read OUTSIDE any transaction, the invoice/cert
 *  precedent: a plain read has no reason to hold a Serializable connection open. The BUILD reads,
 *  though, run inside ONE RepeatableRead transaction so every component read (the family snapshot's
 *  invoices/applications/payments, the billing config, the addresses) sees a single stable DB view
 *  — a commit landing mid-build could otherwise mix states and transiently mis-state the net.
 *  Read-only: no writes, no claim (the print path's Serializable bracket is strictly stronger). */
export async function buildStatement(customerId: string, opts: StatementOpts): Promise<StatementData> {
  const settings = await invoicePrintSettings();
  return prisma.$transaction(
    (tx) => buildStatementInTx(tx, customerId, opts, settings),
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

// -------------------------------------------------------------------------------------------
// printStatement — the 5A print bracket: `invoicePrintSettings` OUTSIDE the transaction, render,
// `storeDocument` UNDER the transaction. See the file header for why this bracket carries no row
// claim (unlike `printInvoice`/`printCert`/`printTraveler`).
// -------------------------------------------------------------------------------------------

async function printStatementInTx(
  tx: Db, customerId: string, opts: StatementOpts, settings: InvoicePrintSettings,
): Promise<{ documentId: string; pdf: Buffer; data: StatementData }> {
  const data = await buildStatementInTx(tx, customerId, opts, settings);

  // §5.2 resolution on THIS Serializable transaction at its isolation — correct by §5.1
  // immutability, not by locking (the printInvoice/printCert precedent). The statement is CLAIM-FREE
  // by design (no single owner row to CLAIM — see the file header), so no template row is claimed and
  // none is needed; resolution walks from the statement's own customer up the §5.2 chain.
  const resolved = await resolveTemplateForPrint(tx, "STATEMENT", customerId);
  // Logo bytes → data URI by the STORED mime type (spec §6.3); the builder renders it only when the
  // config also places it, so an unplaced upload converts nothing.
  const logoDataUri = resolved.logoImage !== null && resolved.config.logo !== null
    ? (resolved.logoMimeType === "image/jpeg"
        ? jpegDataUri(Buffer.from(resolved.logoImage))
        : pngDataUri(Buffer.from(resolved.logoImage)))
    : undefined;

  const pdf = await renderPdf(buildStatementDefinition(data, resolved.config, logoDataUri));
  // `resolved.versionId` is the §5.2 stamp: exactly which template version produced the paper.
  const doc = await storeDocument(tx, { kind: "STATEMENT", customerId }, pdf, resolved.versionId);
  // `data` rides back for callers that report on what they printed (`printStatementsPerDivision`
  // lists each member's Total Due) — it is already built here, so nothing is re-read to get it.
  return { documentId: doc.id, pdf, data };
}

/** Render, archive and return the statement PDF (spec §8). A reprint of a STORED document is the
 *  download route's job (`getDocument`), not this function's, and stays available forever — the
 *  same reissue-never-re-render contract every document kind in this codebase carries. */
export async function printStatement(
  customerId: string, opts: StatementOpts,
): Promise<{ documentId: string; pdf: Buffer }> {
  const settings = await invoicePrintSettings(); // OUTSIDE the transaction (the invoice/cert precedent)
  return withDbErrors({ entity: "Statement" }, () => prisma.$transaction(
    (tx) => printStatementInTx(tx, customerId, opts, settings),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  ));
}

// -------------------------------------------------------------------------------------------
// runStatements — one printed statement for every customer carrying a nonzero net balance as of
// the chosen date (spec §8: "a run over everyone with an open balance"). See the file header for
// why the run never combines family.
// -------------------------------------------------------------------------------------------

export async function runStatements(
  opts: RunStatementsOpts,
): Promise<{ customerId: string; documentId: string }[]> {
  const asOf = opts.asOf ?? formatDateOnly(todayDateOnly());
  const asOfDate = parseAsOf(asOf);

  // Every customer with ANY A/R history — the `aging.ts` unfiltered-report discovery query
  // (duplicated so the two "who has A/R" answers can never silently drift apart from a shared,
  // unexported helper neither file actually needs elsewhere). The whole discovery — who has
  // history, plus the family snapshot that decides each one's net — runs inside ONE RepeatableRead
  // transaction so a commit landing mid-read can't mis-decide who gets a statement (read-only: no
  // writes, no claim; the per-customer PRINTS below each open their own Serializable bracket).
  const discovery = await prisma.$transaction(async (tx) => {
    const [invoicedCustomers, paidCustomers] = await Promise.all([
      tx.invoice.findMany({
        where: { deletedAt: null, status: "FINALIZED" }, select: { customerId: true }, distinct: ["customerId"],
      }),
      tx.payment.findMany({ where: { deletedAt: null }, select: { customerId: true }, distinct: ["customerId"] }),
    ]);
    const customerIds = [...new Set([
      ...invoicedCustomers.map((r) => r.customerId), ...paidCustomers.map((r) => r.customerId),
    ])];
    if (customerIds.length === 0) return null;

    const customers = await tx.customer.findMany({
      where: { id: { in: customerIds } }, select: CUSTOMER_REF_SELECT, orderBy: { code: "asc" },
    });
    const snap = await readFamilySnapshot(tx, customerIds, asOfDate);
    return { customers, snap };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  if (!discovery) return [];
  const rows = bucketAging(discovery.snap, asOf, discovery.customers);

  const settings = await invoicePrintSettings(); // OUTSIDE every per-customer print transaction below
  const results: { customerId: string; documentId: string }[] = [];
  for (const row of rows) {
    if (cents(row.net) === 0) continue; // settled — nothing to send
    const printOpts: StatementOpts = { asOf, combineFamily: false, assessFinanceCharges: opts.assessFinanceCharges };
    const { documentId } = await withDbErrors({ entity: "Statement" }, () => prisma.$transaction(
      (tx) => printStatementInTx(tx, row.customerId, printOpts, settings),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ));
    results.push({ customerId: row.customerId, documentId });
  }
  return results;
}

export type PerDivisionStatement = {
  customerId: string; customerCode: string; customerName: string;
  documentId: string; totalDue: number;
};

/**
 * The PER-DIVISION half of "combined or per-division" (spec §3 ruling 10) — one archived statement
 * for the parent AND one for each live division, each scoped to its own activity (#85).
 *
 * Unchecking "Combine family" used to send exactly ONE request, for the parent, which
 * `buildStatement` correctly answered with the parent alone: the divisions were silently omitted,
 * so the advertised per-division option produced strictly LESS than the combined one rather than a
 * statement each. The choice is real now.
 *
 * Shaped exactly like `runStatements` above — settings read ONCE outside, then one Serializable
 * print transaction per member — because it is the same act at a different scope, and two different
 * print loops would be two things to keep in step. A customer with no children yields exactly its
 * own statement, so the caller never has to ask whether this one is a family head. Unlike
 * `runStatements` it does NOT skip a settled member: the operator asked for this family's
 * statements by name, and a division that owes nothing still gets the paper saying so.
 */
export async function printStatementsPerDivision(
  customerId: string, opts: StatementOpts,
): Promise<PerDivisionStatement[]> {
  const asOf = opts.asOf ?? formatDateOnly(todayDateOnly());
  const parent = await prisma.customer.findFirst({
    where: { id: customerId, deletedAt: null }, select: CUSTOMER_REF_SELECT,
  });
  if (!parent) throw new HttpError(404, "Customer not found");
  // LIVE children only — the same filter `buildStatement`'s own family roll-up applies, so the two
  // halves of the choice cover exactly the same set of customers.
  const children = await prisma.customer.findMany({
    where: { parentId: parent.id, deletedAt: null }, select: CUSTOMER_REF_SELECT, orderBy: { code: "asc" },
  });

  const settings = await invoicePrintSettings(); // OUTSIDE every per-member print transaction below
  const results: PerDivisionStatement[] = [];
  for (const member of [parent, ...children]) {
    // `combineFamily: false` for every member, INCLUDING the parent — the whole point is that each
    // one reports its own activity. A parent printed `true` here would double-count its divisions.
    const printOpts: StatementOpts = { asOf, combineFamily: false, assessFinanceCharges: opts.assessFinanceCharges };
    const printed = await withDbErrors({ entity: "Statement" }, () => prisma.$transaction(
      (tx) => printStatementInTx(tx, member.id, printOpts, settings),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ));
    results.push({
      customerId: member.id, customerCode: member.code, customerName: member.name,
      documentId: printed.documentId, totalDue: printed.data.totalDue,
    });
  }
  return results;
}
