// The two BLOCKING order-entry install signals, pulled into their own leaf so the createOrder gate
// (T7), the order-entry UI notice (T8), and the full install-readiness rollup (T9) all read ONE
// source and orders.ts never grows an import cycle (the invoice-guards.ts "lift the cross-module
// question into a leaf before the cycle exists" precedent). Reuses only the {label, href} SHAPE of
// gl-mapping.ts's ReadinessGap — NOT its GL-export `kind` union, whose meaning is unrelated. Pure
// read: no claim, no audit, no Serializable (spec §8).
import type { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { getSetting } from "./settings";
import { getBillingConfig } from "./billing-config";

export type SetupGap = { label: string; href: string };
export type OrderEntryReadiness = { ready: boolean; gaps: SetupGap[] };

/**
 * The order-entry gate predicate (§5.6): real order entry is blocked until company identity AND a
 * chart of accounts are configured. Threadable on a caller's client so the gate (T7) can read it
 * pre-transaction on the plain `prisma`, and the rollup (T9) can compose it.
 */
export async function orderEntryReadiness(
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<OrderEntryReadiness> {
  const [name, address, phone, config, glCount] = await Promise.all([
    getSetting("company_name", db),
    getSetting("company_address", db),
    getSetting("company_phone", db),
    getBillingConfig(db),
    db.glAccount.count({ where: { deletedAt: null } }),
  ]);

  const gaps: SetupGap[] = [];
  // Company identity — all three letterhead fields; the "" default is the true "unset" signal.
  if (![name, address, phone].every((v) => v.trim() !== "")) {
    gaps.push({ label: "Company identity (name, address, phone) is not set", href: "/admin/settings" });
  }
  // Chart of accounts — at least one live GL account AND the A/R control account set.
  if (glCount === 0) {
    gaps.push({ label: "No GL accounts have been created (chart of accounts)", href: "/admin/reference" });
  }
  if (config.arGlAccountId == null) {
    gaps.push({ label: "The A/R control account is not set", href: "/admin/billing" });
  }

  return { ready: gaps.length === 0, gaps };
}
