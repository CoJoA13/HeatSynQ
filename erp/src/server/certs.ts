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
 * The two plant defaults are read via `getSetting`, which always goes through the top-level
 * `prisma` client (settings.ts has no `tx`-accepting variant) — so a caller passing `tx` here
 * (createOrder's own transaction) still has this function's OTHER two reads (`customer`, `part`)
 * run ON that same `tx`; only the plant-default reads open a second connection while that `tx` is
 * in flight, the general shape `createOrder`'s own settings-read comment cautions against. This is
 * a deliberate, narrower case of it: `cert_required_default`/`cert_scope_default` are two Setting
 * rows nothing ever locks (no `allocateNumber` call touches either key), so they cannot be the
 * `FOR UPDATE` `order_number_next` is separately claimed against in that same transaction — but
 * the interface this function has to expose (self-contained, `tx`-or-`prisma`, no pre-fetched
 * settings parameter — Task 5 depends on the exact signature) leaves no way to route this read
 * through `tx` instead, the way `createOrder` routes its OWN plant-setting reads by fetching them
 * before the transaction opens.
 */
export async function resolveCertSettings(
  db: Db, customerId: string, partIds: string[],
): Promise<CertResolution> {
  const [customer, parts, requiredDefault, scopeDefault] = await Promise.all([
    db.customer.findFirst({
      where: { id: customerId, deletedAt: null },
      select: { certRequiredDefault: true, certScopeDefault: true },
    }),
    db.part.findMany({
      where: { id: { in: partIds }, deletedAt: null },
      select: { id: true, certRequired: true, certScope: true },
    }),
    getSetting("cert_required_default"),
    getSetting("cert_scope_default"),
  ]);

  const byId = new Map(parts.map((p) => [p.id, p]));

  const certRequired = partIds.some((id) =>
    byId.get(id)?.certRequired ?? customer?.certRequiredDefault ?? requiredDefault);

  const lead = byId.get(partIds[0]);
  const certScope = (lead?.certScope ?? customer?.certScopeDefault ?? scopeDefault) as CertScopeValue;

  return { certRequired, certScope };
}
