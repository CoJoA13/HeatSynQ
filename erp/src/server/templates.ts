import { z } from "zod";
import { Prisma, type TemplateDocType } from "../../prisma/generated/prisma/client";
import { prisma } from "./db";
import { HttpError } from "./errors";
import { withDbErrors } from "./db-errors";
import { auditedCreate, auditedUpdate, auditedSoftDelete } from "./audit";
import { currentActor } from "./context";
import { findBlockers } from "./reference-blockers";
import { TARGET_LABELS } from "../lib/reference-links";
import { matchesDeclaredImage } from "./image-sniff";
import {
  validateConfig, defaultConfigFor, TemplateConfigError,
  type TemplateConfig, type TemplateDocTypeString,
} from "../lib/template-contracts/index";

/**
 * The document-template service (Phase 7 spec §5.1, §4.1, §7): lifecycle (create-with-v1-draft →
 * edit → publish → re-draft), the §5.1 revert flow, set-default, the reasoned §5.14-guarded
 * delete, and the per-draft logo.
 *
 * CONCURRENCY — the claim is the guard, not isolation (CLAUDE.md's standing rule). Every mutation
 * claims the DocumentTemplate row with `SELECT … FOR UPDATE` FIRST (`claimTemplate`, the
 * `claimQuote`/`lockCurrentRevision` shape) and only then reads the state it acts on: the live
 * draft, the version-number high-water mark, the published pointer, the default flag, the §5.14
 * blocker set. All of that state lives on or under the claimed row, so the claim serializes
 * every pair of template mutators at ANY caller isolation — the transactions here all run at the
 * default (Read Committed) level, and nothing relies on SSI. `setDefault` is the one multi-row
 * writer and claims every live template of the docType in ONE ordered statement (the
 * `claimOrdersInOrder` rule): two concurrent set-defaults for one type must serialize with EACH
 * OTHER, not just with mutations of their own row, or both could demote the old default and
 * leave two new ones standing.
 *
 * PUBLISH vs PRINT is deliberately not a claim relationship (spec §5.1): prints resolve
 * `publishedVersionId` under their own transactions, correct at any isolation BY IMMUTABILITY —
 * publish commits the pointer and the (immutable, never-deleted) PUBLISHED row atomically, so
 * any committed pointer a reader dereferences yields a complete published config. No print locks
 * the template row and none needs to; the reader-atomicity test in templates.test.ts pins the
 * testable half.
 *
 * VERSION IMMUTABILITY (spec §4.1): a PUBLISHED row is frozen and a DISCARDED row is history —
 * every `documentTemplateVersion.update` in this file is keyed on the open DRAFT resolved under
 * the claim (`requireDraft`), and there is no version delete path at all. templates.test.ts
 * enforces that shape grep-level.
 */

type Db = Prisma.TransactionClient;

const DRAFT = "DRAFT";
const PUBLISHED = "PUBLISHED";
const DISCARDED = "DISCARDED";
export type TemplateVersionStatus = "DRAFT" | "PUBLISHED" | "DISCARDED";

export const LOGO_MAX_BYTES = 512 * 1024; // spec §4.1 — a header logo, not an archive
export const LOGO_MIME = ["image/png", "image/jpeg"] as const;

const NAME = z.string().trim().min(1, "A template name is required").max(200);

/** Prisma's enum values are 1:1 with the contract registry's string union (Task 3's report) —
 *  this is the single sanctioned crossing between the two types. */
function contractType(docType: TemplateDocType): TemplateDocTypeString {
  return docType as TemplateDocTypeString;
}

// Every scalar EXCEPT logoImage — the SNAPSHOT_SELECT rule (audit.ts) applied to service reads:
// the logo bytes never leave Postgres for a code path that only needs the row's identity/config.
const VERSION_SELECT = {
  id: true, templateId: true, versionNumber: true, status: true, config: true,
  logoMimeType: true, publishedAt: true, publishedById: true, createdAt: true, updatedAt: true,
} satisfies Prisma.DocumentTemplateVersionSelect;

export type DraftDetail = {
  id: string; versionNumber: number; config: TemplateConfig; updatedAt: Date;
  logoMimeType: string | null;
};

export type VersionSummary = {
  versionNumber: number; status: TemplateVersionStatus; publishedAt: Date | null;
  publishedBy: string | null; hasLogo: boolean; createdAt: Date; updatedAt: Date;
};

export type VersionDetail = VersionSummary & { config: TemplateConfig };

export type TemplateListRow = {
  id: string; docType: TemplateDocType; name: string; isDefault: boolean;
  publishedVersionNumber: number | null; hasDraft: boolean; assignmentCount: number;
  updatedAt: Date;
};

export type TemplateDetail = {
  id: string; docType: TemplateDocType; name: string; isDefault: boolean;
  publishedVersionNumber: number | null;
  draft: DraftDetail | null;
  /** Newest first, WITHOUT config bodies — a template accumulates versions forever, and the
   *  history list never needs their payloads. One config comes from `getTemplateVersion`. */
  versions: VersionSummary[];
};

/**
 * Claims the DocumentTemplate row for the rest of the caller's OWN transaction — the `claimQuote`
 * shape (quotes.ts): raw because Prisma has no `FOR UPDATE`, id only, with the full row read back
 * through the ordinary client once the lock is held (so a waiter that unblocks reads the state
 * its rival just committed, not the state it queued behind). Missing and soft-deleted templates
 * both 404.
 *
 * Exported for Task 5's assignment writer: assigning a template to a customer must claim the
 * template row through THIS function before writing (plan Global Constraints — that shared claim
 * is what closes the assign-vs-delete race, whose test lands with that writer). One claim path,
 * never a second differently-shaped one.
 */
export async function claimTemplate(tx: Db, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "DocumentTemplate" WHERE "id" = ${id} FOR UPDATE`;
  const row = await tx.documentTemplate.findFirst({ where: { id } });
  if (!row || row.deletedAt !== null) throw new HttpError(404, "Template not found");
  return row;
}

/** The template's one live DRAFT, read UNDER the caller's claim — or the caller's named 400.
 *  (At most one exists: `openDraft` refuses under the same claim.) */
async function requireDraft(tx: Db, templateId: string, refusal: string) {
  const draft = await tx.documentTemplateVersion.findFirst({
    where: { templateId, status: DRAFT }, select: VERSION_SELECT,
  });
  if (!draft) throw new HttpError(400, refusal);
  return draft;
}

/** jsonb normalizes key order, so a stored config and a freshly validated one can be identical in
 *  content yet differ under a naive stringify. Canonicalize (sort keys, recursively) before
 *  comparing, so an unchanged save is skipped instead of writing a before===after audit entry. */
function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort()
        .map((k) => [k, sort((v as Record<string, unknown>)[k])]));
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

function toDraftDetail(row: {
  id: string; versionNumber: number; config: unknown; updatedAt: Date; logoMimeType: string | null;
}): DraftDetail {
  return {
    id: row.id, versionNumber: row.versionNumber,
    config: row.config as TemplateConfig, updatedAt: row.updatedAt, logoMimeType: row.logoMimeType,
  };
}

// ------------------------------------------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------------------------------------------

/**
 * Creates the template AND opens its v1 DRAFT in one transaction (spec §5.1) — a template is
 * never draftless-and-unpublished from the outside; `publishedVersionId` stays null only until
 * that draft first publishes (§4.1). Config pre-fills from the type's DEFAULT_CONFIG. Name
 * uniqueness is per (docType, name) among LIVE rows — partial unique, so the `findFirst`
 * pre-check gives the friendly 400 and the index (surfacing as P2002 through `withDbErrors`) is
 * the racing-writer backstop; never `findUnique` on a partial column (CLAUDE.md).
 */
export async function createTemplate(
  docType: TemplateDocType, rawName: string,
): Promise<{ id: string; draft: { id: string; versionNumber: number; updatedAt: Date } }> {
  const name = NAME.parse(rawName);
  const config = defaultConfigFor(contractType(docType));
  return withDbErrors({ entity: "Template", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      const dup = await tx.documentTemplate.findFirst({
        where: { docType, name, deletedAt: null }, select: { id: true },
      });
      if (dup) throw new HttpError(400, "A template with that name already exists for this document type");
      const template = await auditedCreate("documentTemplate", { docType, name, isDefault: false },
        () => tx.documentTemplate.create({ data: { docType, name } }), { tx });
      const draft = await auditedCreate("documentTemplateVersion",
        { templateId: template.id, versionNumber: 1, status: DRAFT, config },
        () => tx.documentTemplateVersion.create({
          data: {
            templateId: template.id, versionNumber: 1, status: DRAFT,
            config: config as unknown as Prisma.InputJsonValue,
          },
          select: VERSION_SELECT,
        }), { tx });
      return { id: template.id, draft: { id: draft.id, versionNumber: draft.versionNumber, updatedAt: draft.updatedAt } };
    }));
}

export async function renameTemplate(id: string, rawName: string): Promise<void> {
  const name = NAME.parse(rawName);
  await withDbErrors({ entity: "Template", conflictField: "name" }, () =>
    prisma.$transaction(async (tx) => {
      const template = await claimTemplate(tx, id);
      if (template.name === name) return; // nothing changes — no junk audit entry
      const dup = await tx.documentTemplate.findFirst({
        where: { docType: template.docType, name, deletedAt: null, NOT: { id } }, select: { id: true },
      });
      if (dup) throw new HttpError(400, "A template with that name already exists for this document type");
      await auditedUpdate("documentTemplate", id, () =>
        tx.documentTemplate.update({ where: { id }, data: { name } }), { tx });
    }));
}

/**
 * Opens the next draft under the claim: refuses while a live DRAFT exists, allocates
 * `versionNumber` = max(existing) + 1 (a discarded draft's number is never reused — the history
 * may carry gaps, §4.1), and copies config AND logo from the source version:
 *
 *   - `fromVersion` (the §5.1 revert flow): an explicit version of THIS template, which must be
 *     PUBLISHED — a DRAFT never was paper and a DISCARDED one was abandoned; "restoring an old
 *     version" means publishing a copy of a config that once printed;
 *   - else the current published version (the ordinary edit-after-publish path);
 *   - else the type's DEFAULT_CONFIG (a never-published template whose v1 draft was discarded).
 *
 * The copy is VERBATIM — the §5.3 backfill happens at parse time (every edit validates, every
 * consumer parses), not by rewriting stored history at copy time.
 */
export async function openDraft(
  id: string, opts: { fromVersion?: number } = {},
): Promise<DraftDetail> {
  return withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      const template = await claimTemplate(tx, id);
      const existing = await tx.documentTemplateVersion.findFirst({
        where: { templateId: id, status: DRAFT }, select: { versionNumber: true },
      });
      if (existing) {
        throw new HttpError(400,
          `This template already has an open draft (version ${existing.versionNumber}) — publish or discard it first`);
      }
      const max = await tx.documentTemplateVersion.aggregate({
        where: { templateId: id }, _max: { versionNumber: true },
      });
      const versionNumber = (max._max.versionNumber ?? 0) + 1;

      const SOURCE_SELECT = { status: true, config: true, logoImage: true, logoMimeType: true } as const;
      let source: { status: string; config: unknown; logoImage: Uint8Array | null; logoMimeType: string | null } | null = null;
      if (opts.fromVersion !== undefined) {
        const from = await tx.documentTemplateVersion.findFirst({
          where: { templateId: id, versionNumber: opts.fromVersion }, select: SOURCE_SELECT,
        });
        if (!from || from.status !== PUBLISHED) {
          throw new HttpError(400, `Version ${opts.fromVersion} is not a published version of this template`);
        }
        source = from;
      } else if (template.publishedVersionId !== null) {
        source = await tx.documentTemplateVersion.findFirst({
          where: { id: template.publishedVersionId }, select: SOURCE_SELECT,
        });
      }
      const config = source !== null ? source.config : defaultConfigFor(contractType(template.docType));
      const logoImage = source?.logoImage ?? null;
      const logoMimeType = source?.logoMimeType ?? null;

      // Audit payload: the create's own data, logo BYTES excluded (the SNAPSHOT_SELECT rule —
      // never hand the audit layer a payload it would only have to scrub).
      const draft = await auditedCreate("documentTemplateVersion",
        {
          templateId: id, versionNumber, status: DRAFT, config, logoMimeType,
          ...(opts.fromVersion !== undefined ? { copiedFromVersion: opts.fromVersion } : {}),
        },
        () => tx.documentTemplateVersion.create({
          data: {
            templateId: id, versionNumber, status: DRAFT,
            config: config as Prisma.InputJsonValue,
            logoImage: logoImage === null ? null : new Uint8Array(logoImage), logoMimeType,
          },
          select: VERSION_SELECT,
        }), { tx });
      return toDraftDetail(draft);
    }));
}

/**
 * Saves the draft's config. The `updatedAt` PRECONDITION (spec §5.1's draft concurrency): the one
 * live draft is shared, so the caller sends the `updatedAt` it loaded, and a mismatch is a named
 * 409 — never a silent merge (the notes-pair lesson). Checked BEFORE validation: a stale editor
 * deserves the truthful "someone else changed this", not a config nitpick. The config is
 * validated against the type's contract and the BACKFILLED result is what's stored;
 * `TemplateConfigError` (a §5.6 lock, a width budget, a duplicate key) maps to a 400 naming the
 * offending element, and shape problems stay ZodError for `handle`'s translation.
 */
export async function editDraft(
  id: string, input: { config: unknown; updatedAt: Date },
): Promise<{ updatedAt: Date }> {
  return withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      const template = await claimTemplate(tx, id);
      const draft = await requireDraft(tx, id, "This template has no open draft to edit — open one first");
      if (draft.updatedAt.getTime() !== input.updatedAt.getTime()) {
        throw new HttpError(409, "The draft changed since you loaded it — reload the editor and re-apply your changes");
      }
      let config: TemplateConfig;
      try {
        config = validateConfig(contractType(template.docType), input.config);
      } catch (err) {
        if (err instanceof TemplateConfigError) throw new HttpError(400, err.message);
        throw err;
      }
      if (canonicalJson(config) === canonicalJson(draft.config)) {
        return { updatedAt: draft.updatedAt }; // unchanged — no write, no junk audit entry
      }
      const updated = await auditedUpdate("documentTemplateVersion", draft.id, () =>
        tx.documentTemplateVersion.update({ where: { id: draft.id },
          data: { config: config as unknown as Prisma.InputJsonValue },
          select: { updatedAt: true },
        }), { tx });
      return { updatedAt: updated.updatedAt };
    }));
}

/** A status flip to DISCARDED — NEVER a delete (spec §4.1): the row, its config, and its logo
 *  stay as append-only history, and its number is never reused. */
export async function discardDraft(id: string): Promise<void> {
  await withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      await claimTemplate(tx, id);
      const draft = await requireDraft(tx, id, "This template has no open draft to discard");
      await auditedUpdate("documentTemplateVersion", draft.id, () =>
        tx.documentTemplateVersion.update({ where: { id: draft.id },
          data: { status: DISCARDED }, select: { id: true },
        }), { tx });
    }));
}

/**
 * Publishes the draft under the claim, atomically: the status flip (+ `publishedAt`/
 * `publishedById`, the actor from context) and the `publishedVersionId` pointer move commit
 * together or not at all — that atomicity is the whole §5.1 immutability argument's premise, and
 * the reader-atomicity test pins it. The loser of a double publish re-reads under the claim,
 * finds no draft, and gets the named 400 — it never re-stamps the winner's publish.
 */
export async function publishDraft(id: string): Promise<{ versionId: string; versionNumber: number }> {
  return withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      await claimTemplate(tx, id);
      const draft = await requireDraft(tx, id, "This template has no open draft to publish");
      await auditedUpdate("documentTemplateVersion", draft.id, () =>
        tx.documentTemplateVersion.update({ where: { id: draft.id },
          data: { status: PUBLISHED, publishedAt: new Date(), publishedById: currentActor().id },
          select: { id: true },
        }), { tx });
      await auditedUpdate("documentTemplate", id, () =>
        tx.documentTemplate.update({ where: { id }, data: { publishedVersionId: draft.id } }), { tx });
      return { versionId: draft.id, versionNumber: draft.versionNumber };
    }));
}

/**
 * Makes this template its docType's default — refusing a template with NO published version
 * (§4.1's invariant: a never-published template can be neither the default nor assigned, so the
 * print-resolution chain never dereferences a null pointer).
 *
 * Claims EVERY live template of the docType in ONE ordered statement, not just the target (the
 * `claimOrdersInOrder` rule, and the one place this file locks more than one row): "exactly one
 * live default per docType, always" is an invariant ACROSS rows, so two concurrent set-defaults
 * for one type must serialize with each other — each claiming only its own row, both would
 * demote the old default and leave two new ones standing. Demote-then-promote inside the one
 * transaction (the address-default precedent), each side audited.
 */
export async function setDefault(id: string): Promise<void> {
  await withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      const peek = await tx.documentTemplate.findFirst({
        where: { id, deletedAt: null }, select: { docType: true },
      });
      if (!peek) throw new HttpError(404, "Template not found");
      await tx.$queryRaw`
        SELECT "id" FROM "DocumentTemplate"
        WHERE "docType" = ${peek.docType}::"TemplateDocType" AND "deletedAt" IS NULL
        ORDER BY "id" FOR UPDATE`;
      // Re-read the target UNDER the claim — the peek predates it and may be stale (a concurrent
      // delete that beat the claim leaves the row unclaimable and this read catches it).
      const template = await tx.documentTemplate.findFirst({ where: { id, deletedAt: null } });
      if (!template) throw new HttpError(404, "Template not found");
      if (template.publishedVersionId === null) {
        throw new HttpError(400,
          "This template has never been published — publish a version before making it the default");
      }
      if (template.isDefault) return; // already the default — nothing to change, no junk audit
      const old = await tx.documentTemplate.findMany({
        where: { docType: template.docType, isDefault: true, deletedAt: null, NOT: { id } },
        select: { id: true },
      });
      for (const row of old) {
        await auditedUpdate("documentTemplate", row.id, () =>
          tx.documentTemplate.update({ where: { id: row.id }, data: { isDefault: false } }), { tx });
      }
      await auditedUpdate("documentTemplate", id, () =>
        tx.documentTemplate.update({ where: { id }, data: { isDefault: true } }), { tx });
    }));
}

/**
 * Reasoned soft delete (§5.17: it retires a whole version history from view and frees a name for
 * reuse), under the claim. Refused while the template is its type's current default (the seeded
 * invariant: a docType always has a live default), and §5.14-blocked-AND-NAMED while live
 * customer assignments point at it — the blocker a person can act on is the CUSTOMER
 * (reference-links.ts's registry entry; the Excel export rides on the same `findBlockers`).
 *
 * Default isolation, deliberately: Task 5's assignment writer claims this same template row
 * before writing, so assign-vs-delete serializes on the claim — the row lock is the guard, not
 * SSI (its race test lands with that writer). Versions are untouched: append-only history.
 */
export async function deleteTemplate(id: string, rawReason: string): Promise<void> {
  const reason = rawReason.trim();
  if (reason === "") throw new HttpError(400, "A reason is required to delete a template");
  const label = TARGET_LABELS.documentTemplate;
  await withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      const template = await claimTemplate(tx, id);
      if (template.isDefault) {
        throw new HttpError(400,
          `"${template.name}" is the current default ${label} for its document type — set another default first`);
      }
      const blockers = await findBlockers("documentTemplate", id, tx);
      if (blockers.length > 0) {
        const shown = blockers.slice(0, 5).map((b) => b.name).join(", ");
        const more = blockers.length > 5 ? ` and ${blockers.length - 5} more` : "";
        throw new HttpError(400,
          `That ${label} is assigned to ${blockers.length} customer(s): ${shown}${more} — clear the assignments on the customer pages first`);
      }
      await auditedSoftDelete("documentTemplate", id, reason, tx);
    }));
}

// ------------------------------------------------------------------------------------------------
// Logo (spec §4.1/§6.3) — per-VERSION bytes, DRAFT-only writes, the #49 sniff shared with the
// signature upload (image-sniff.ts). The caps and checks run before the transaction opens, the
// setSignature shape.
// ------------------------------------------------------------------------------------------------

export async function uploadLogo(id: string, data: Buffer, mimeType: string): Promise<void> {
  if (!(LOGO_MIME as readonly string[]).includes(mimeType)) {
    throw new HttpError(400, `Logo images must be one of: ${LOGO_MIME.join(", ")}`);
  }
  if (data.byteLength > LOGO_MAX_BYTES) {
    throw new HttpError(400, `Logo images cannot exceed ${LOGO_MAX_BYTES / 1024} KB`);
  }
  if (!matchesDeclaredImage(mimeType, data)) {
    throw new HttpError(400, `The uploaded file is not a valid ${mimeType} image`);
  }
  await withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      await claimTemplate(tx, id);
      const draft = await requireDraft(tx, id,
        "A logo can only be uploaded to an open draft — open one first");
      // `new Uint8Array(data)`: Prisma's Bytes input rejects Node's Buffer type (the
      // storeDocument/setSignature precedent).
      await auditedUpdate("documentTemplateVersion", draft.id, () =>
        tx.documentTemplateVersion.update({ where: { id: draft.id },
          data: { logoImage: new Uint8Array(data), logoMimeType: mimeType }, select: { id: true },
        }), { tx });
    }));
}

export async function clearLogo(id: string): Promise<void> {
  await withDbErrors({ entity: "Template" }, () =>
    prisma.$transaction(async (tx) => {
      await claimTemplate(tx, id);
      const draft = await requireDraft(tx, id,
        "A logo can only be cleared from an open draft — open one first");
      await auditedUpdate("documentTemplateVersion", draft.id, () =>
        tx.documentTemplateVersion.update({ where: { id: draft.id },
          data: { logoImage: null, logoMimeType: null }, select: { id: true },
        }), { tx });
    }));
}

// ------------------------------------------------------------------------------------------------
// Reads
// ------------------------------------------------------------------------------------------------

/** Live templates (optionally one docType): default flag, published version number, draft
 *  presence, and the LIVE assignment count (a cleared assignment does not count from the grave —
 *  the filtered relation count matches the §5.14 guard's own liveWhere). */
export async function listTemplates(docType?: TemplateDocType): Promise<TemplateListRow[]> {
  const rows = await prisma.documentTemplate.findMany({
    where: { deletedAt: null, ...(docType !== undefined ? { docType } : {}) },
    select: {
      id: true, docType: true, name: true, isDefault: true, updatedAt: true,
      publishedVersion: { select: { versionNumber: true } },
      versions: { where: { status: DRAFT }, select: { id: true } },
      _count: { select: { assignments: { where: { deletedAt: null } } } },
    },
    orderBy: [{ docType: "asc" }, { name: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id, docType: r.docType, name: r.name, isDefault: r.isDefault, updatedAt: r.updatedAt,
    publishedVersionNumber: r.publishedVersion?.versionNumber ?? null,
    hasDraft: r.versions.length > 0,
    assignmentCount: r._count.assignments,
  }));
}

function toVersionSummary(v: {
  versionNumber: number; status: string; publishedAt: Date | null; logoMimeType: string | null;
  createdAt: Date; updatedAt: Date; publishedBy: { displayName: string } | null;
}): VersionSummary {
  return {
    versionNumber: v.versionNumber, status: v.status as TemplateVersionStatus,
    publishedAt: v.publishedAt, publishedBy: v.publishedBy?.displayName ?? null,
    // logoMimeType stands proxy for the bytes — the two columns are only ever written together —
    // so the history list never pulls a single logo byte out of Postgres.
    hasLogo: v.logoMimeType !== null, createdAt: v.createdAt, updatedAt: v.updatedAt,
  };
}

const SUMMARY_SELECT = {
  versionNumber: true, status: true, publishedAt: true, logoMimeType: true,
  createdAt: true, updatedAt: true, publishedBy: { select: { displayName: true } },
} satisfies Prisma.DocumentTemplateVersionSelect;

/** Template detail: the published pointer, the open draft (WITH its config — the editor's
 *  working copy), and the version history WITHOUT config bodies (see `TemplateDetail`).
 *
 *  The two reads (the template + its history, then the open draft) run in ONE `RepeatableRead`
 *  transaction so they see a single snapshot — the aging.ts precedent (carried Task-4 review
 *  minor a, made live by Task 16's detail pane, which renders the version history and the
 *  draft-vs-published state side by side). Two autocommit reads would tear: a publish committing
 *  between them can leave the history listing a version as DRAFT while the draft read (after the
 *  flip to PUBLISHED) returns null — self-healing on refresh, but confusing on screen. A plain
 *  `$transaction` at the default Read Committed level would NOT fix it (each statement gets a
 *  fresh snapshot); RepeatableRead pins one snapshot for both. Read-only, no lock, no retry. */
export async function getTemplate(id: string): Promise<TemplateDetail> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.documentTemplate.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true, docType: true, name: true, isDefault: true,
        publishedVersion: { select: { versionNumber: true } },
        versions: { orderBy: { versionNumber: "desc" }, select: SUMMARY_SELECT },
      },
    });
    if (!row) throw new HttpError(404, "Template not found");
    const draft = await tx.documentTemplateVersion.findFirst({
      where: { templateId: id, status: DRAFT }, select: VERSION_SELECT,
    });
    return {
      id: row.id, docType: row.docType, name: row.name, isDefault: row.isDefault,
      publishedVersionNumber: row.publishedVersion?.versionNumber ?? null,
      draft: draft === null ? null : toDraftDetail(draft),
      versions: row.versions.map(toVersionSummary),
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

/** One version's stored config, VERBATIM — history is frozen; the §5.3 backfill belongs to the
 *  consumers that parse it, never to a read that would silently rewrite what a version says. */
export async function getTemplateVersion(templateId: string, versionNumber: number): Promise<VersionDetail> {
  const template = await prisma.documentTemplate.findFirst({
    where: { id: templateId, deletedAt: null }, select: { id: true },
  });
  if (!template) throw new HttpError(404, "Template not found");
  const v = await prisma.documentTemplateVersion.findFirst({
    where: { templateId, versionNumber },
    select: { ...SUMMARY_SELECT, config: true },
  });
  if (!v) throw new HttpError(404, "Version not found");
  return { ...toVersionSummary(v), config: v.config as TemplateConfig };
}
