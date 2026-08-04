import type { Prisma } from "../../prisma/generated/prisma/client";

/**
 * Task 6's file. `createCert` (certs.ts) already calls `seedRequirements` unconditionally right
 * after writing the bare `Cert` row (spec §6.2/§6.3), but Task 6 — which owns the seeding logic,
 * `replaceResults`, and the pass/fail computation/override handling — has not landed yet.
 *
 * This is a genuine no-op, not a partial implementation: it creates nothing and reads nothing.
 * Task 5's own report names this explicitly. Building even a half-shaped seeder here (guessing at
 * how Task 6 wants to walk `PartInspection` rows, in what order, with what min/max rounding)
 * would leave Task 6 untangling this task's choices instead of making its own — an honest no-op
 * is the smaller footprint.
 *
 * When Task 6 fills this in, spec §6.3 is the contract: one `CertRequirement` per LIVE
 * `PartInspection` of each order line's part, in the part's own `sort` order, lines in
 * order-line `position` order, with `min`/`max`/`sampleQty`/`location` copied from
 * `PartInspection` (frozen — a later part edit must not rewrite a cert already in progress) and
 * `inspectionCodeId`/`scaleId` referenced. `CertRequirementDetail`/`CertReadingDetail` are
 * declared in `certs.ts`, not here — this file imports them from there once it builds real rows.
 */
export async function seedRequirements(tx: Prisma.TransactionClient, certId: string): Promise<void> {
  void tx;
  void certId;
}
