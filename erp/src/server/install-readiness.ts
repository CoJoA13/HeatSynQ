import { prisma } from "./db";
import { getSetting } from "./settings";
import { getBillingConfig } from "./billing-config";
import { getSetupState } from "./setup-state";
import { verifyPassword } from "./password";

// The first-run setup checklist's rollup (Phase 8B §5.5): the dependency-ordered configuration
// steps, each a live-derived signal EXCEPT the two facts that cannot be derived (starting numbers
// confirmed, checklist dismissed), which come from SetupState (T4). It REUSES the {label, href}
// shape of gl-mapping.ts's ReadinessGap but computes its OWN signals — it does NOT extend
// readinessGaps, whose logic is GL-export-period-scoped. Pure read (no claim, no audit).
//
// `blocking` marks the two signals the order-entry gate enforces (company identity, chart of
// accounts — order-entry-readiness.ts); everything else is a recommendation. The password step is
// §5.7's recommended item, a live signal (the seeded admin still verifies "admin").

export type SetupStep = { key: string; label: string; href: string; complete: boolean; blocking: boolean };
export type InstallReadiness = { steps: SetupStep[]; dismissed: boolean; complete: boolean };

export async function installReadiness(): Promise<InstallReadiness> {
  const [
    name, address, phone, config, setup,
    glCount, stepCount, custCount, partCount,
    termsCount, carrierCount, containerCount, materialCount, admin,
  ] = await Promise.all([
    getSetting("company_name"),
    getSetting("company_address"),
    getSetting("company_phone"),
    getBillingConfig(),
    getSetupState(),
    prisma.glAccount.count({ where: { deletedAt: null } }),
    prisma.processStepCode.count({ where: { deletedAt: null } }),
    prisma.customer.count({ where: { deletedAt: null } }),
    prisma.part.count({ where: { deletedAt: null } }),
    prisma.terms.count({ where: { deletedAt: null } }),
    prisma.carrier.count({ where: { deletedAt: null } }),
    prisma.containerType.count({ where: { deletedAt: null } }),
    prisma.material.count({ where: { deletedAt: null } }),
    prisma.user.findFirst({ where: { username: "admin", deletedAt: null }, select: { passwordHash: true } }),
  ]);

  // §5.7: the seeded admin/admin still verifies "admin" → the change-password step is incomplete.
  // No such user (renamed/deleted) → nothing to nudge, so the step reads complete.
  const passwordStillDefault = admin ? await verifyPassword(admin.passwordHash, "admin") : false;
  const companyComplete = [name, address, phone].every((v) => v.trim() !== "");
  const chartComplete = glCount > 0 && config.arGlAccountId != null;

  const steps: SetupStep[] = [
    { key: "password", label: "Change the admin password", href: "/admin/users", complete: !passwordStillDefault, blocking: false },
    { key: "company", label: "Company identity (name, address, phone)", href: "/admin/settings", complete: companyComplete, blocking: true },
    { key: "numbers", label: "Confirm starting document numbers", href: "/admin/settings", complete: setup.numbersConfirmedAt != null, blocking: false },
    { key: "chart", label: "Chart of accounts (GL accounts + A/R control account)", href: "/admin/reference", complete: chartComplete, blocking: true },
    { key: "stepCodes", label: "Process step codes and surcharges", href: "/admin/step-codes", complete: stepCount > 0, blocking: false },
    { key: "references", label: "Reference tables (terms, carriers, containers, materials)", href: "/admin/reference", complete: termsCount > 0 && carrierCount > 0 && containerCount > 0 && materialCount > 0, blocking: false },
    { key: "customers", label: "Customers", href: "/customers", complete: custCount > 0, blocking: false },
    { key: "parts", label: "Parts", href: "/parts", complete: partCount > 0, blocking: false },
  ];

  return {
    steps,
    dismissed: setup.checklistDismissedAt != null,
    complete: steps.every((s) => s.complete),
  };
}
