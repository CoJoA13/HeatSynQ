// Read-only prisma script the manual-capture harness spawns (via `npx tsx`) to discover REAL ids
// from the dev database for every dynamic route it has to photograph. Same entry-point shape and
// same stdout contract as `db-fixtures.ts` next door — `manual-capture.mjs` shells out with
// `execFileSync("npx", ["tsx", ...])` and parses ONE line of JSON off stdout, so every diagnostic
// below goes to stderr.
//
// The one hard difference from db-fixtures.ts: **this script never writes.** It creates no
// fixtures and deletes nothing, because the dataset it is pointed at is the manual/acceptance
// dataset — the whole point of the capture is to photograph what is actually there. Nothing here
// may mutate, and nothing here needs a cleanup counterpart.
//
// "Discover" means *pick the richest row*, not *pick any row*: a screenshot of an order with no
// lines, a part with no prices, or a customer with no divisions teaches a reader nothing and hides
// exactly the layout the manual needs to show. Each picker below therefore pulls a bounded
// candidate set with relation counts attached and scores it in JS (see `pick`), rather than
// leaning on a single `orderBy` — the preferences are multi-term (status first, then breadth of
// content) and are far easier to read, and to change, as an explicit score.
import "dotenv/config";
import { PrismaClient } from "../../prisma/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { devDbRefusal, dbNameFromUrl, hostFromUrl } from "../../src/lib/dev-db-guard";

/** How many rows each picker considers before scoring. Bounded so a large acceptance dataset
 *  can't turn discovery into a table scan of everything; ordered newest-first, because the rich
 *  demo/acceptance rows are the recently seeded ones. */
const CANDIDATES = 250;

/**
 * The dev-DB guard. It used to be a re-declaration rather than an import, because `db-fixtures.ts`
 * runs its own `main()` at import time (it is a CLI entry point, not a library) and importing IT
 * would execute a fixture command as a side effect of asking for ids. That reasoning held; the
 * copy did not — this file's local-host set had silently lost `[::1]`, which the other three
 * accept. The rule now lives in the pure leaf `src/lib/dev-db-guard.ts`, which drags nothing.
 *
 * This script is read-only, so the stakes are lower than db-fixtures.ts's, but the check stays:
 * pointing a capture run at `erp_test` would silently photograph an empty truncated database and
 * report it as a passing sweep, which is worse than an error.
 */
function assertDevDb(url: string): void {
  const refusal = devDbRefusal({
    subject: "manual capture",
    consequence: "capturing against the wrong database would photograph the wrong rows — a "
      + "truncated erp_test, say — and report it as a clean sweep",
    dbName: dbNameFromUrl(url),
    host: hostFromUrl(url),
  });
  if (refusal) throw new Error(refusal);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");
assertDevDb(databaseUrl);

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

/** What one dynamic route's chosen example looks like on the way back out. `label` is what the
 *  sweep report prints so a reader can tell WHICH row was photographed; `why` records the
 *  richness that won it the pick, so a thin capture is visible in the report rather than silent. */
export type Pick = { id: string; label: string; why: string; data?: Record<string, string> } | null;

/**
 * Scores a candidate list and returns the winner, or null for an empty list. `score` returns a
 * number (higher wins); ties break toward the earlier candidate, which is newest-first for every
 * caller below.
 */
function pick<T>(
  rows: T[],
  score: (row: T) => number,
  describe: (row: T) => { label: string; why: string; data?: Record<string, string> },
): Pick {
  let best: T | undefined;
  let bestScore = -Infinity;
  for (const row of rows) {
    const s = score(row);
    if (s > bestScore) {
      best = row;
      bestScore = s;
    }
  }
  if (best === undefined) return null;
  const { label, why, data } = describe(best);
  return { id: (best as { id: string }).id, label, why, ...(data ? { data } : {}) };
}

async function discover() {
  // ---- Order (/orders/[id]) ------------------------------------------------------------------
  // Prefer a fully-travelled order: INVOICED > SHIPPED/CLOSED > OPEN, then breadth (lines,
  // containers, serials, charges) so the hub's tabs all have something in them.
  const orderStatusRank: Record<string, number> = { INVOICED: 400, CLOSED: 300, SHIPPED: 300, OPEN: 100 };
  const orders = await prisma.order.findMany({
    where: { deletedAt: null },
    orderBy: { orderNumber: "desc" },
    take: CANDIDATES,
    select: {
      id: true, orderNumber: true, status: true,
      customer: { select: { name: true } },
      _count: { select: { lines: true, containers: true, serials: true, charges: true, certs: true } },
    },
  });
  const order = pick(
    orders,
    (o) => (orderStatusRank[o.status] ?? 0)
      + o._count.lines * 10 + o._count.containers * 3 + o._count.serials * 2 + o._count.charges * 3
      + o._count.certs * 5,
    (o) => ({
      label: `Order #${o.orderNumber} (${o.status}) — ${o.customer.name}`,
      why: `${o._count.lines} line(s), ${o._count.containers} container(s), ${o._count.serials} serial(s), ${o._count.charges} charge(s)`,
    }),
  );

  // ---- Part (/parts/[id]) --------------------------------------------------------------------
  // Prices and process revisions are the two things the part page exists to show, so both are
  // weighted heavily — a part with neither photographs as an empty shell.
  const parts = await prisma.part.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, partNumber: true, name: true,
      // The part's OWN customer, carried out in `data` below. Order entry filters the part picker
      // to the selected customer's parts, so the capture has to select this customer — pairing the
      // independently-chosen "richest customer" with the "richest part" picks two rows that
      // usually belong to different customers, and the part option can then never appear.
      customer: { select: { name: true, code: true } },
      _count: {
        select: {
          prices: true, processRevisions: true, specifications: true,
          inspections: true, fieldValues: true, orderLines: true,
        },
      },
    },
  });
  const part = pick(
    parts,
    (p) => p._count.prices * 20 + p._count.processRevisions * 20 + p._count.specifications * 5
      + p._count.inspections * 5 + p._count.fieldValues * 3 + Math.min(p._count.orderLines, 10) * 2,
    (p) => ({
      label: `Part ${p.partNumber}${p.name ? ` — ${p.name}` : ""} (${p.customer.name})`,
      why: `${p._count.prices} price(s), ${p._count.processRevisions} revision(s), ${p._count.specifications} spec(s)`,
      // Consumed by the order-entry interaction capture, which must pick THIS customer before it
      // can pick this part. Passed as data rather than re-parsed out of `label` — a capture that
      // recovers a code with a regex over a human-readable string breaks the moment the string
      // is reworded.
      data: { partNumber: p.partNumber, customerCode: p.customer.code, customerName: p.customer.name },
    }),
  );

  // ---- Customer (/customers/[id]) ------------------------------------------------------------
  // Divisions (the self-relation) are the structural thing worth photographing, then addresses
  // and contacts; a trickle of orders/parts proves the tabs aren't empty.
  const customers = await prisma.customer.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, code: true, name: true,
      _count: {
        select: {
          children: true, addresses: true, contacts: true,
          parts: true, orders: true, invoices: true, surchargeRules: true,
        },
      },
    },
  });
  const customer = pick(
    customers,
    (c) => c._count.children * 25 + c._count.addresses * 10 + c._count.contacts * 10
      + c._count.surchargeRules * 5 + Math.min(c._count.parts, 20) * 2 + Math.min(c._count.orders, 20) * 2,
    (c) => ({
      label: `Customer ${c.code} — ${c.name}`,
      why: `${c._count.children} division(s), ${c._count.addresses} address(es), ${c._count.contacts} contact(s), ${c._count.parts} part(s)`,
    }),
  );

  // ---- Invoice (/invoicing/[id]) -------------------------------------------------------------
  // A FINALIZED INVOICE is the interesting one (frozen paper, a due date, applications against
  // it); a DRAFT shows the editable state, and a CREDIT is a different document entirely. Prefer
  // FINALIZED, and return a DRAFT separately so the manual can show both faces of the screen.
  const invoices = await prisma.invoice.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, kind: true, status: true, creditNumber: true,
      order: { select: { orderNumber: true } },
      customer: { select: { name: true } },
      _count: { select: { lines: true, applications: true } },
    },
  });
  // An INVOICE has no number column of its own — it is one-per-order (`@@unique([orderId])` where
  // kind = INVOICE), so the paper and the whole service layer call it "Invoice #<orderNumber>".
  // Only a CREDIT carries an allocated number of its own.
  const invoiceLabel = (i: (typeof invoices)[number]) =>
    i.kind === "CREDIT" ? `Credit #${i.creditNumber ?? "—"}` : `Invoice #${i.order.orderNumber}`;
  const invoice = pick(
    invoices.filter((i) => i.kind === "INVOICE"),
    (i) => (i.status === "FINALIZED" ? 500 : 0) + i._count.lines * 10 + i._count.applications * 15,
    (i) => ({
      label: `${invoiceLabel(i)} (${i.status}) — ${i.customer.name}`,
      why: `${i._count.lines} line(s), ${i._count.applications} application(s)`,
    }),
  );
  const draftInvoice = pick(
    invoices.filter((i) => i.kind === "INVOICE" && i.status === "DRAFT"),
    (i) => i._count.lines * 10,
    (i) => ({
      label: `${invoiceLabel(i)} (DRAFT) — ${i.customer.name}`,
      why: `${i._count.lines} line(s)`,
    }),
  );

  // ---- Quote (/quotes/[id]) ------------------------------------------------------------------
  const quotes = await prisma.quote.findMany({
    where: { deletedAt: null },
    orderBy: { quoteNumber: "desc" },
    take: CANDIDATES,
    select: {
      id: true, quoteNumber: true, status: true,
      customer: { select: { name: true } },
      _count: { select: { lines: true } },
    },
  });
  const quote = pick(
    quotes,
    (q) => (q.status === "OPEN" ? 200 : 0) + q._count.lines * 20,
    (q) => ({
      label: `Quote #${q.quoteNumber} (${q.status}) — ${q.customer.name}`,
      why: `${q._count.lines} line(s)`,
    }),
  );

  // ---- Cert (/certs/[id]) --------------------------------------------------------------------
  // A cert carries no number of its own (spec §3.19) — its label is its order number + scope, so
  // that is what the sweep report gets. A PRINTED cert with requirements is the rich one.
  const certs = await prisma.cert.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, scope: true, loadNumber: true, printedAt: true,
      order: { select: { orderNumber: true } },
      _count: { select: { requirements: true } },
    },
  });
  const cert = pick(
    certs,
    (c) => (c.printedAt ? 100 : 0) + c._count.requirements * 20,
    (c) => ({
      label: `Cert for order #${c.order.orderNumber} (${c.scope}${c.loadNumber ? ` load ${c.loadNumber}` : ""})`,
      why: `${c._count.requirements} requirement(s), ${c.printedAt ? "printed" : "not yet printed"}`,
    }),
  );

  // ---- Shipper (/shipping/[id]) --------------------------------------------------------------
  // `ShipperLine` hangs off `ShipperOrder`, not off `Shipper`, so breadth here is counted as
  // orders-on-the-shipment plus each order's own lines — a multi-order shipment is the layout
  // worth photographing. A BOL number means the paper side is populated too.
  const shippers = await prisma.shipper.findMany({
    where: { deletedAt: null },
    orderBy: { shipperNumber: "desc" },
    take: CANDIDATES,
    select: {
      id: true, shipperNumber: true, bolNumber: true,
      customer: { select: { name: true } },
      orders: { select: { _count: { select: { lines: true, containers: true, serials: true } } } },
    },
  });
  const shipperLineCount = (s: (typeof shippers)[number]) =>
    s.orders.reduce((n, o) => n + o._count.lines, 0);
  const shipper = pick(
    shippers,
    (s) => s.orders.length * 30 + shipperLineCount(s) * 10 + (s.bolNumber ? 50 : 0),
    (s) => ({
      label: `Shipper #${s.shipperNumber}${s.bolNumber ? ` / BOL #${s.bolNumber}` : ""} — ${s.customer.name}`,
      why: `${s.orders.length} order(s) on the shipment, ${shipperLineCount(s)} line(s)`,
    }),
  );

  // ---- Receipt batch (/receivables/batches/[id]) ---------------------------------------------
  const batches = await prisma.receiptBatch.findMany({
    where: { deletedAt: null },
    orderBy: { batchNumber: "desc" },
    take: CANDIDATES,
    select: { id: true, batchNumber: true, status: true, _count: { select: { payments: true } } },
  });
  const batch = pick(
    batches,
    (b) => b._count.payments * 20 + (b.status === "OPEN" ? 30 : 0),
    (b) => ({
      label: `Receipt batch #${b.batchNumber} (${b.status})`,
      why: `${b._count.payments} payment(s)`,
    }),
  );
  // The apply-payment interaction needs an OPEN batch specifically — a posted batch's payments
  // are past applying. Returned separately so the landing shot can still prefer the richest.
  const openBatch = pick(
    batches.filter((b) => b.status === "OPEN" && b._count.payments > 0),
    (b) => b._count.payments * 20,
    (b) => ({
      label: `Receipt batch #${b.batchNumber} (OPEN)`,
      why: `${b._count.payments} payment(s)`,
    }),
  );

  // ---- Process template (/processes/templates/[id]) ------------------------------------------
  const processTemplates = await prisma.processTemplate.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: { id: true, name: true, active: true, _count: { select: { steps: true } } },
  });
  const processTemplate = pick(
    processTemplates,
    (t) => t._count.steps * 20 + (t.active ? 10 : 0),
    (t) => ({ label: `Process template "${t.name}"`, why: `${t._count.steps} step(s)` }),
  );

  // ---- Document template (/admin/templates/[id]/edit) ----------------------------------------
  // The editor edits a DRAFT version. A template whose newest version is already PUBLISHED opens
  // fine (the editor offers to start a draft from it), but one that HAS a live draft is the
  // richer, more representative screen — so prefer that, and fall back to the seeded default.
  const documentTemplates = await prisma.documentTemplate.findMany({
    where: { deletedAt: null },
    orderBy: { createdAt: "desc" },
    take: CANDIDATES,
    select: {
      id: true, name: true, docType: true, isDefault: true, publishedVersionId: true,
      versions: { select: { status: true } },
    },
  });
  const documentTemplate = pick(
    documentTemplates,
    // Having an OPEN DRAFT dominates everything: without one the editor renders "no open draft to
    // edit", which is not a screenshot the manual can use at any weighting. TRAVELER then outranks
    // isDefault as a tiebreak WITHIN that tier, because the traveler is the only contract carrying
    // §5.6 locked elements (its typed step fields and barcode) — the padlock the manual's template
    // chapter wants to show. It cannot promote a draft-less traveler over a template that has one.
    (t) => (t.versions.some((v) => v.status === "DRAFT") ? 200 : 0)
      + (t.docType === "TRAVELER" ? 60 : 0)
      + (t.isDefault ? 50 : 0) + (t.publishedVersionId ? 25 : 0),
    (t) => ({
      label: `Document template "${t.name}" (${t.docType})`,
      why: `${t.versions.length} version(s)${t.versions.some((v) => v.status === "DRAFT") ? ", has a live draft" : ", published only"}`,
    }),
  );

  return {
    order, part, customer, invoice, draftInvoice, quote, cert, shipper,
    batch, openBatch, processTemplate, documentTemplate,
  };
}

async function main(): Promise<void> {
  const [, , command] = process.argv;
  let result: unknown;
  switch (command) {
    case "discover":
      result = await discover();
      break;
    default:
      throw new Error(`Unknown manual-ids command: ${String(command)}`);
  }
  // The one line of stdout manual-capture.mjs parses as JSON — everything else goes to stderr.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
