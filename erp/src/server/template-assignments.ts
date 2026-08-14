import { Prisma, type TemplateDocType } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { claimTemplate } from "./templates";
import {
  validateConfig, TEMPLATE_DOC_TYPES,
  type TemplateConfig, type TemplateDocTypeString,
} from "../lib/template-contracts/index";
import type { AssignmentDisplay } from "../lib/template-assignment-picker";

/**
 * The customer template-assignment service (Phase 7 spec §4.1, §5.2, §7): the per-(customer,
 * docType) preference pointing future paper at a template, and the print-side resolution walk.
 *
 * CONCURRENCY — `assignTemplate` claims the TEMPLATE row FIRST, through the exported
 * `claimTemplate` (templates.ts — the one claim path, never a second differently-shaped one).
 * That shared claim ORDERS assign against `deleteTemplate` (which claims the same row before
 * reading its §5.14 blocker set): whichever side commits first, the loser wakes to the winner's
 * state. Because `assignTemplate` now runs Serializable (the customer pairing below), the exact
 * SURFACE of the assign-vs-delete-TEMPLATE loser shifted: an assign that loses to a committed
 * template delete no longer 404s off the claim's liveness read — its claimed row was modified and
 * committed after the assign's Serializable snapshot, so the FOR UPDATE re-check raises a
 * serialization abort (P2034 → 409 "retry" via withDbErrors), and the 404 arrives on the retry.
 * The invariant is identical either way — no assignment is ever written against a deleted template.
 * The other direction is unchanged: `deleteTemplate` stays Read Committed, so a delete that loses
 * to a committed assign finds the assignment through its own EPQ-following claim and refuses, named.
 * The row lock is still the ORDERING guard here, not SSI (CLAUDE.md's standing rule; RED-verified
 * race tests in tests/template-assignments.test.ts).
 *
 * Two concurrent assigns for the SAME (customer, docType) naming DIFFERENT templates claim
 * different template rows and do not serialize on them — the partial-unique index on the pair is
 * the backstop (one loses as a P2002, translated by `withDbErrors`), and losing that race is a
 * "try again", not an invariant breach.
 *
 * The template-row claim above closes the assign-vs-delete-TEMPLATE race; a SECOND race —
 * assign-vs-delete-CUSTOMER — has no shared row to claim (the customer row is never locked here),
 * so `assignTemplate` runs Serializable and reads the customer live INSIDE that transaction,
 * SSI-pairing with `deleteCustomer` (customers.ts, itself Serializable — its cascade reads and
 * soft-deletes this customer's live assignments). This is the exact createPart↔deleteCustomer
 * precedent (parts.ts:172-177): without both halves Serializable, an assign and a delete each pass
 * their own pre-check before either commits, orphaning a LIVE assignment on a soft-deleted customer
 * — invisible on the customer page yet blocking that template's §5.14 deletion forever. SSI aborts
 * whichever side no serial ordering allows (P2034 → 409 "retry" via withDbErrors). `clearAssignment`
 * needs no such pairing: a clear-vs-delete-customer race has both sides soft-deleting assignment
 * rows, so either interleaving lands on the same end state (no live row) — benign.
 */

type Db = Prisma.TransactionClient;

export type AssignmentRow = {
  id: string; docType: TemplateDocType; templateId: string; templateName: string;
};

export type TemplateName = {
  id: string; name: string; docType: TemplateDocType;
  /** `publishedVersionId !== null` (Task 20 pre-step): the picker disables a never-published
   *  template with a §5.16 tooltip rather than letting the assign-time 400 surface. */
  published: boolean;
};

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
      // Serializable + in-tx customer read below is the SSI pair with deleteCustomer (header note).
      if (template.publishedVersionId === null) {
        throw new HttpError(400,
          "This template has never been published — publish a version before assigning it to a customer");
      }
      if (template.docType !== docType) {
        throw new HttpError(400,
          `"${template.name}" is a ${template.docType} template — it cannot be the customer's ${docType} template`);
      }
      // This live-customer read is the SSI-conflicting half: deleteCustomer writes this row
      // (soft delete) while its findMany over this customer's assignments conflicts with the
      // create/update below — a two-antidependency cycle Postgres aborts under Serializable.
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
        // this statement must never rewrite the DEAD row's templateId — clearAssignment takes no
        // template claim, so this condition is the guard. Under Serializable (added for the
        // customer pairing), a clear that commits after this tx's snapshot makes the UPDATE a
        // write-write conflict → serialization abort (P2034 → 409 "retry" via withDbErrors) rather
        // than the old P2025 → 404; either way the dead row's templateId is never rewritten.
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }));
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

/** Live templates' id/name/docType + a `published` flag and NOTHING else — the `requireUser`-only
 *  names read's projection (§5.15; served by /api/templates/names for the customer page's picker).
 *  `published` is derived from `publishedVersionId` and NOT exposed raw (the id is internal). */
export async function listTemplateNames(): Promise<TemplateName[]> {
  const rows = await prisma.documentTemplate.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, docType: true, publishedVersionId: true },
    orderBy: [{ docType: "asc" }, { name: "asc" }],
  });
  return rows.map(({ publishedVersionId, ...rest }) => ({
    ...rest, published: publishedVersionId !== null,
  }));
}

/** The §5.2 chain's single source of truth (spec §5.2, ruling 7). Starting at the document's
 *  customer, walk `parentId` toward the root; the nearest live assignment for `docType` WHOSE
 *  TEMPLATE IS ITSELF LIVE wins (both `deletedAt`s filtered — `deleteTemplate` refuses only on LIVE
 *  assignments, so a soft-deleted assignment row can still name a deleted template; belt-and-braces,
 *  the walk must fall onward, never resolve a template no screen can show); else the docType's live
 *  default. `source` distinguishes the STARTING customer's own row (`own`) from an ancestor's
 *  (`inherited`) from the default — that is what the customer-page picker needs to display, and it
 *  is computed HERE so print and picker can never diverge (the picker never reimplements the walk).
 *
 *  SELF-BOUNDS on visited ids: `assertNoCycle` (customers.ts) guards the parentId WRITE path, but a
 *  read that spins on corrupt data would take every print down with it — stop on repeat or null.
 *
 *  NEVER null: the seed migration and `truncateAll()` guarantee every docType a live default with a
 *  PUBLISHED v1, so a missing default is a broken DB invariant — a plain Error (a bug for `handle`
 *  to 500 on), not an HttpError. */
type ResolutionHit = {
  source: "own" | "inherited" | "default";
  /** The ancestor whose assignment matched; null for the default fallback. */
  matchedCustomerId: string | null;
  template: { id: string; publishedVersionId: string | null; name: string };
};

const TEMPLATE_SELECT = { id: true, publishedVersionId: true, name: true } as const;

async function resolveAssignment(
  tx: Db, docType: TemplateDocType, customerId: string,
): Promise<ResolutionHit> {
  const visited = new Set<string>();
  let current: string | null = customerId;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    const assignment = await tx.customerTemplateAssignment.findFirst({
      where: { customerId: current, docType, deletedAt: null, template: { deletedAt: null } },
      select: { template: { select: TEMPLATE_SELECT } },
    });
    if (assignment !== null) {
      return {
        source: current === customerId ? "own" : "inherited",
        matchedCustomerId: current,
        template: assignment.template,
      };
    }
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
  return { source: "default", matchedCustomerId: null, template: dflt };
}

/**
 * Print-time resolution, on the CALLER's transaction — every print passes its own claimed `tx`,
 * and this function opens none of its own. Delegates the §5.2 walk to `resolveAssignment` (above),
 * then dereferences the winning template's published pointer to the backfilled config + logo.
 */
export async function resolveTemplateForPrint(
  tx: Db, docType: TemplateDocType, customerId: string,
): Promise<ResolvedTemplate> {
  const hit = await resolveAssignment(tx, docType, customerId);
  return dereference(tx, docType, hit.template);
}

/**
 * The customer-page picker's DISPLAY resolution (spec §5.2, §5.15): one row per docType (all 8),
 * each never blank, computed by the SAME `resolveAssignment` walk the print resolver uses — so the
 * picker shows exactly what the print would produce, and resolution is never reimplemented (Task 20
 * brief). Runs read-only in ONE RepeatableRead snapshot (the `getTemplate` precedent) so a
 * concurrent assign mid-walk cannot tear the chain across docTypes; no claim — a slightly stale
 * DISPLAY is harmless (§5.1's immutability argument, one step removed).
 */
export async function resolveAssignmentsForCustomer(customerId: string): Promise<AssignmentDisplay[]> {
  return prisma.$transaction(async (tx) => {
    const out: AssignmentDisplay[] = [];
    for (const docType of TEMPLATE_DOC_TYPES) {
      const hit = await resolveAssignment(tx, docType, customerId);
      let inheritedFromCode: string | null = null;
      let inheritedFromName: string | null = null;
      if (hit.source === "inherited" && hit.matchedCustomerId !== null) {
        const anc = await tx.customer.findFirst({
          where: { id: hit.matchedCustomerId }, select: { code: true, name: true },
        });
        inheritedFromCode = anc?.code ?? null;
        inheritedFromName = anc?.name ?? null;
      }
      out.push({
        docType,
        source: hit.source,
        resolvedTemplateName: hit.template.name,
        ownTemplateId: hit.source === "own" ? hit.template.id : null,
        inheritedFromCode,
        inheritedFromName,
      });
    }
    return out;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
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
