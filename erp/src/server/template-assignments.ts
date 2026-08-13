import { Prisma, type TemplateDocType } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { claimTemplate } from "./templates";
import {
  validateConfig, type TemplateConfig, type TemplateDocTypeString,
} from "../lib/template-contracts/index";

/**
 * The customer template-assignment service (Phase 7 spec §4.1, §5.2, §7): the per-(customer,
 * docType) preference pointing future paper at a template, and the print-side resolution walk.
 *
 * CONCURRENCY — `assignTemplate` claims the TEMPLATE row FIRST, through the exported
 * `claimTemplate` (templates.ts — the one claim path, never a second differently-shaped one).
 * That shared claim is what closes the assign-vs-delete race at the services' default (Read
 * Committed) isolation: `deleteTemplate` claims the same row before reading its §5.14 blocker
 * set, so whichever side commits first, the loser wakes to the winner's state — an assign after
 * a delete 404s off the claim's own liveness read; a delete after an assign finds the committed
 * assignment and refuses, named. Nothing here relies on SSI; the row lock is the guard
 * (CLAUDE.md's standing rule; RED-verified race tests in tests/template-assignments.test.ts).
 *
 * Two concurrent assigns for the SAME (customer, docType) naming DIFFERENT templates claim
 * different template rows and do not serialize on them — the partial-unique index on the pair is
 * the backstop (one loses as a P2002, translated by `withDbErrors`), and losing that race is a
 * "try again", not an invariant breach.
 */

type Db = Prisma.TransactionClient;

export type AssignmentRow = {
  id: string; docType: TemplateDocType; templateId: string; templateName: string;
};

export type TemplateName = { id: string; name: string; docType: TemplateDocType };

export type ResolvedTemplate = {
  templateId: string;
  versionId: string;
  /** The published version's stored JSON, parsed through `validateConfig` — i.e. BACKFILLED
   *  (§5.3): a version stored before a knob existed resolves with that knob's contract default,
   *  so old versions keep rendering identically. */
  config: TemplateConfig;
  logoImage: Uint8Array | null;
  logoMimeType: string | null;
};

/**
 * Assigns `templateId` as the customer's template for `docType` — upsert semantics on the
 * partial-unique pair: a live assignment is REPLACED (audited update), else one is created
 * (audited create). Refusals, in claim order: a missing/soft-deleted template 404s via the claim
 * itself; a never-published template gets the named 400 (§4.1's invariant, mirroring
 * `setDefault` — the resolution chain must never dereference a null pointer); a docType mismatch
 * gets a named 400; a missing/soft-deleted customer 404s.
 */
export async function assignTemplate(
  customerId: string, docType: TemplateDocType, templateId: string,
): Promise<{ id: string; customerId: string; docType: TemplateDocType; templateId: string }> {
  return withDbErrors({ entity: "Template assignment", conflictField: "document type" }, () =>
    prisma.$transaction(async (tx) => {
      // The claim FIRST (missing and soft-deleted both 404 inside it) — see the header comment.
      const template = await claimTemplate(tx, templateId);
      if (template.publishedVersionId === null) {
        throw new HttpError(400,
          "This template has never been published — publish a version before assigning it to a customer");
      }
      if (template.docType !== docType) {
        throw new HttpError(400,
          `"${template.name}" is a ${template.docType} template — it cannot be the customer's ${docType} template`);
      }
      const customer = await tx.customer.findFirst({
        where: { id: customerId, deletedAt: null }, select: { id: true },
      });
      if (!customer) throw new HttpError(404, "Customer not found");

      // Never findUnique/upsert on the partial-unique pair (the house rule) — findFirst among
      // live rows, then create or update. Every branch selects exactly the declared return shape,
      // so the PUT route serializes nothing beyond it (Task 5 review, carried).
      const ASSIGNMENT_SELECT = {
        id: true, customerId: true, docType: true, templateId: true,
      } as const;
      const existing = await tx.customerTemplateAssignment.findFirst({
        where: { customerId, docType, deletedAt: null }, select: ASSIGNMENT_SELECT,
      });
      if (existing) {
        if (existing.templateId === templateId) return existing; // unchanged — no junk audit
        // `deletedAt: null` rides in the UPDATE's own where (Task 5 review, carried): a
        // concurrent claim-free `clearAssignment` committing between the findFirst above and
        // this statement must fail the replace (P2025 → the entity's 404 via withDbErrors),
        // never rewrite the DEAD row's templateId — clearAssignment takes no template claim,
        // so this single-statement condition is the only guard (auditedSoftDelete's own
        // updateMany rule, applied to the replace).
        return auditedUpdate("customerTemplateAssignment", existing.id, () =>
          tx.customerTemplateAssignment.update({
            where: { id: existing.id, deletedAt: null }, data: { templateId },
            select: ASSIGNMENT_SELECT,
          }), { tx });
      }
      return auditedCreate("customerTemplateAssignment", { customerId, docType, templateId },
        () => tx.customerTemplateAssignment.create({
          data: { customerId, docType, templateId }, select: ASSIGNMENT_SELECT,
        }), { tx });
    }));
}

/**
 * Clears the customer's assignment for `docType` — soft delete, audited, with NO reason required
 * (§5.17's classification, spec §7: a pure preference — nothing rides along with it, nothing
 * unique is freed, and future paper simply falls back down the §5.2 chain).
 */
export async function clearAssignment(customerId: string, docType: TemplateDocType): Promise<void> {
  await withDbErrors({ entity: "Template assignment" }, () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.customerTemplateAssignment.findFirst({
        where: { customerId, docType, deletedAt: null }, select: { id: true },
      });
      if (!existing) {
        throw new HttpError(404, "No template assignment to clear for that document type");
      }
      await auditedSoftDelete("customerTemplateAssignment", existing.id, undefined, tx);
    }));
}

/** The customer page's live assignments, template names joined (Task 20 consumes). */
export async function listAssignments(customerId: string): Promise<AssignmentRow[]> {
  const rows = await prisma.customerTemplateAssignment.findMany({
    where: { customerId, deletedAt: null },
    select: { id: true, docType: true, templateId: true, template: { select: { name: true } } },
    orderBy: { docType: "asc" },
  });
  return rows.map((r) => ({
    id: r.id, docType: r.docType, templateId: r.templateId, templateName: r.template.name,
  }));
}

/** Live templates' id/name/docType and NOTHING else — the `requireUser`-only names read's
 *  projection (§5.15; served by /api/templates/names for the customer page's picker). */
export async function listTemplateNames(): Promise<TemplateName[]> {
  return prisma.documentTemplate.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, docType: true },
    orderBy: [{ docType: "asc" }, { name: "asc" }],
  });
}

/**
 * Print-time resolution (spec §5.2, ruling 7), on the CALLER's transaction — every print passes
 * its own claimed `tx`, and this function opens none of its own. The chain: starting at the
 * document's customer, walk `parentId` toward the root; the nearest live assignment for
 * `docType` WHOSE TEMPLATE IS ITSELF LIVE wins (both `deletedAt`s filtered — `deleteTemplate`
 * refuses only on LIVE assignments, so a soft-deleted assignment row can still name a deleted
 * template; belt-and-braces, the walk must fall onward, never resolve a template no screen can
 * show); else the docType's live default.
 *
 * The walk SELF-BOUNDS on visited ids: `assertNoCycle` (customers.ts) guards the parentId WRITE
 * path, but a read that spins on corrupt data would take every print down with it — stop on
 * repeat or null, then fall to the default.
 *
 * NEVER null: the seed migration and `truncateAll()` both guarantee every docType a live default
 * with a PUBLISHED v1, and §4.1 keeps never-published templates out of assignments and the
 * default seat — so a missing default or a null published pointer here is a broken DB invariant:
 * a plain Error (a bug for `handle` to 500 on), not an HttpError.
 */
export async function resolveTemplateForPrint(
  tx: Db, docType: TemplateDocType, customerId: string,
): Promise<ResolvedTemplate> {
  const TEMPLATE_SELECT = { id: true, publishedVersionId: true } as const;

  const visited = new Set<string>();
  let current: string | null = customerId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const assignment = await tx.customerTemplateAssignment.findFirst({
      where: { customerId: current, docType, deletedAt: null, template: { deletedAt: null } },
      select: { template: { select: TEMPLATE_SELECT } },
    });
    if (assignment !== null) return dereference(tx, docType, assignment.template);
    // Annotated to break a TS7022 circularity: the generic findFirst return would otherwise be
    // inferred from `current`, whose control-flow narrowing depends on this very assignment.
    const customer: { parentId: string | null } | null = await tx.customer.findFirst({
      where: { id: current }, select: { parentId: true },
    });
    current = customer?.parentId ?? null;
  }

  const dflt = await tx.documentTemplate.findFirst({
    where: { docType, isDefault: true, deletedAt: null }, select: TEMPLATE_SELECT,
  });
  if (dflt === null) {
    throw new Error(
      `No live default ${docType} template exists — the seed invariant (Phase 7 spec §9) is broken`);
  }
  return dereference(tx, docType, dflt);
}

/** Published pointer → version row → the backfilled config + logo. A null pointer or a missing
 *  version row is the §4.1 invariant broken — a plain Error, per the resolver's contract. */
async function dereference(
  tx: Db, docType: TemplateDocType, template: { id: string; publishedVersionId: string | null },
): Promise<ResolvedTemplate> {
  if (template.publishedVersionId === null) {
    throw new Error(
      `Template ${template.id} resolved for a ${docType} print with no published version — the §4.1 invariant is broken`);
  }
  const version = await tx.documentTemplateVersion.findFirst({
    where: { id: template.publishedVersionId },
    select: { id: true, config: true, logoImage: true, logoMimeType: true },
  });
  if (version === null) {
    throw new Error(
      `Template ${template.id}'s published version ${template.publishedVersionId} does not exist — the §4.1 invariant is broken`);
  }
  return {
    templateId: template.id,
    versionId: version.id,
    config: validateConfig(docType as TemplateDocTypeString, version.config),
    logoImage: version.logoImage,
    logoMimeType: version.logoMimeType,
  };
}
