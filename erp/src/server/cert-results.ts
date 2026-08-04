import { z } from "zod";
import { Prisma } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedUpdate } from "./audit";
import { assertRefExists } from "./reference-guards";
import { decimalField } from "./decimal-field";
import { computePassed } from "../lib/pass-fail";
import { claimCertsOrder, readCertDetail, type CertDetail } from "./certs";

type Db = Prisma.TransactionClient;

/**
 * Spec §6.3: one `CertRequirement` per LIVE `PartInspection` of each order line's part, lines in
 * their own `position` order, inspections within a line in the part's own `sort` order — one
 * running `position` across the whole cert, since that is what orders the printed document
 * (`CertRequirement.position`'s own schema comment). `min`/`max`/`sampleQty`/`location` are
 * COPIED from `PartInspection` and frozen here; editing the part next month must not rewrite a
 * cert already being filled in. A part with no live inspections contributes no rows.
 *
 * Called from `createCert` (certs.ts) inside its own transaction — `tx` genuinely threads
 * through, never opens a second connection. `assertRefExists("inspectionCode"/"inspectionScale",
 * …, tx)` per row is the registered-FK writer pattern (reference-guards.ts) and is why the
 * enclosing transaction has to be Serializable: the target has to still be live in the SAME
 * transaction that inserts the FK, not in a snapshot taken before it.
 */
export async function seedRequirements(tx: Db, certId: string): Promise<void> {
  const cert = await tx.cert.findFirst({ where: { id: certId }, select: { orderId: true } });
  if (!cert) return; // seedRequirements is only ever called right after createCertInTx's own insert

  const lines = await tx.orderLine.findMany({
    where: { orderId: cert.orderId },
    orderBy: { position: "asc" },
    select: { id: true, partId: true },
  });
  if (lines.length === 0) return;

  // One query for every named part's live inspections (the resolveCertSettings precedent,
  // certs.ts, for avoiding a query per line) — `sort` ascending makes each part's own rows arrive
  // in the part's own print order, and grouping below preserves that relative order per part.
  const inspections = await tx.partInspection.findMany({
    where: { partId: { in: lines.map((l) => l.partId) }, deletedAt: null },
    orderBy: { sort: "asc" },
  });
  const byPart = new Map<string, typeof inspections>();
  for (const insp of inspections) {
    const arr = byPart.get(insp.partId);
    if (arr) arr.push(insp); else byPart.set(insp.partId, [insp]);
  }

  let position = 0;
  for (const line of lines) {
    for (const insp of byPart.get(line.partId) ?? []) {
      position += 1;
      await assertRefExists("inspectionCode", insp.inspectionCodeId, tx);
      if (insp.scaleId !== null) await assertRefExists("inspectionScale", insp.scaleId, tx);
      await tx.certRequirement.create({
        data: {
          certId, orderLineId: line.id, position,
          inspectionCodeId: insp.inspectionCodeId, scaleId: insp.scaleId,
          min: insp.min, max: insp.max, sampleQty: insp.sampleQty, location: insp.location,
        },
      });
    }
  }
}

// -------------------------------------------------------------------------------------------
// Results — many readings per requirement, computed-but-overridable pass/fail (spec §6.3).
// -------------------------------------------------------------------------------------------

const READING = z.object({
  value: decimalField(10, 4),
  passed: z.boolean().nullable().optional(),
  overridden: z.boolean().optional().default(false),
  note: z.string().max(500).optional().default(""),
}).strict();

const REQUIREMENT_PATCH = z.object({
  id: z.string().min(1),
  readings: z.array(READING).max(500), // the owner's real sample carries 27 under one requirement
}).strict();

const REPLACE = z.object({
  requirements: z.array(REQUIREMENT_PATCH),
}).strict();

/**
 * Full replace of the READINGS under whichever requirements are named in `input` — requirement
 * rows themselves are never added, removed or re-derived here (`seedRequirements` owns that, once,
 * at cert creation; the frozen copy is the point). A requirement id that does not belong to this
 * cert is a 400 naming it, so a stale client payload fails loudly rather than silently writing
 * nothing.
 *
 * `passed` is computed per reading with `computePassed` against the requirement's own frozen
 * min/max UNLESS the row sets `overridden: true`, in which case the supplied `passed` is stored
 * verbatim (§6.3) — the override itself is what carries into the audit diff, not printed (§3.21).
 *
 * `withDbErrors` → Serializable `$transaction` → `claimCertsOrder` (the same order-row-lock
 * discipline `updateCert`/`voidCert` already use, certs.ts) → `auditedUpdate("cert", …)` wrapping
 * a delete-and-recreate of each named requirement's readings. Refuses once `printedAt` is set
 * unless `opts.afterPrint` — the caller (Task 11's route) passes
 * `canDo(user, "edit_cert_results_after_print")`.
 */
export async function replaceResults(
  certId: string, input: unknown, opts: { afterPrint: boolean },
): Promise<CertDetail> {
  const data = REPLACE.parse(input);

  return withDbErrors({ entity: "Cert" }, () => prisma.$transaction(async (tx) => {
    await claimCertsOrder(tx, certId);
    const cert = await tx.cert.findFirst({ where: { id: certId } });
    if (!cert || cert.deletedAt !== null) throw new HttpError(404, "Certification not found");
    if (cert.printedAt !== null && !opts.afterPrint) {
      throw new HttpError(400, "This certification has already been printed");
    }

    // Every named requirement must belong to THIS cert — validated up front, before any write,
    // so a stale/foreign id refuses the whole call rather than partially applying it.
    const requirements = await tx.certRequirement.findMany({
      where: { certId }, select: { id: true, min: true, max: true },
    });
    const byId = new Map(requirements.map((r) => [r.id, r]));
    for (const patch of data.requirements) {
      if (!byId.has(patch.id)) {
        throw new HttpError(400, `Requirement ${patch.id} does not belong to this certification`);
      }
    }

    await auditedUpdate("cert", certId, async () => {
      for (const patch of data.requirements) {
        const req = byId.get(patch.id)!;
        const min = req.min === null ? null : req.min.toNumber();
        const max = req.max === null ? null : req.max.toNumber();

        await tx.certReading.deleteMany({ where: { requirementId: patch.id } });
        if (patch.readings.length === 0) continue;
        await tx.certReading.createMany({
          data: patch.readings.map((r, i) => {
            const value = r.value ?? null;
            const passed = r.overridden ? (r.passed ?? null) : computePassed(value, min, max);
            return {
              requirementId: patch.id, position: i + 1, value,
              passed, overridden: r.overridden, note: r.note,
            };
          }),
        });
      }
    }, { tx });

    return readCertDetail(tx, certId);
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
}
