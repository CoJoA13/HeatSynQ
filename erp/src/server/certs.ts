import { Prisma } from "../../prisma/generated/prisma/client";
import { getSetting } from "./settings";
import type { CertScopeValue } from "../lib/cert-constants";

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
