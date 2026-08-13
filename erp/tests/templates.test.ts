import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll, templateId, templateVersionId } from "./helpers/db";
import type { Prisma } from "../prisma/generated/prisma/client";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import {
  createTemplate, renameTemplate, openDraft, editDraft, discardDraft, publishDraft,
  setDefault, deleteTemplate, uploadLogo, clearLogo,
  listTemplates, getTemplate, getTemplateVersion,
  LOGO_MAX_BYTES,
} from "@/server/templates";
import { defaultConfigFor, type TemplateConfig } from "@/lib/template-contracts/index";

/**
 * Phase 7 Task 4 — the template service: lifecycle, publish, delete (spec §5.1, §4.1, §7).
 *
 * Concurrency discipline (the unlock-concurrency.test.ts precedent): a passing concurrency test
 * proves nothing on its own. Every service transaction here runs at DEFAULT (Read Committed)
 * isolation — there is no SSI to hide behind — so the ONLY thing that can serialize a competitor
 * against a hand-scripted holder is the template row's `SELECT … FOR UPDATE` claim. Each race
 * below parks the real service call behind a holder that took exactly that claim, proves it is
 * genuinely blocked, then releases and asserts the outcome the claim guarantees. RED-verified by
 * removing the claim from `claimTemplate` (transcripts in the task report).
 */

const STANDARD_TRAVELER = templateId("TRAVELER");

let actor: { id: string; name: string };
let holderUser: { id: string; name: string };

const as = <T>(fn: () => Promise<T>) => runWithContext({ actor, user: null }, fn);

beforeEach(async () => {
  await truncateAll();
  const u = await prisma.user.create({
    data: { username: "temp-actor", displayName: "Template Actor", passwordHash: "x" },
  });
  actor = { id: u.id, name: u.displayName };
  const h = await prisma.user.create({
    data: { username: "temp-holder", displayName: "Holder", passwordHash: "x" },
  });
  holderUser = { id: h.id, name: h.displayName };
});

const TRAVELER_DEFAULT = () => defaultConfigFor("TRAVELER");

/** A traveler config distinguishable by its base font size — the marker the copy tests follow. */
function withBaseSize(config: TemplateConfig, baseSize: number): TemplateConfig {
  return { ...config, fonts: { ...config.fonts, baseSize } };
}

// A real 1×1 PNG and a JPEG SOI prefix (the user-signature.test.ts fixtures) — the sniff (#49)
// checks magic bytes, so garbage declared as an image never reaches the database.
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");
const JPEG_PREFIX = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);

async function draftRowOf(tmplId: string) {
  return prisma.documentTemplateVersion.findFirst({
    where: { templateId: tmplId, status: "DRAFT" },
    select: { id: true, versionNumber: true, config: true, updatedAt: true, logoMimeType: true },
  });
}

/** create → publish, leaving the template published with no draft. Returns the template id. */
async function publishedTemplate(name: string): Promise<string> {
  const { id } = await as(() => createTemplate("TRAVELER", name));
  await as(() => publishDraft(id));
  return id;
}

describe("createTemplate — the template and its v1 DRAFT open in one act (spec §5.1)", () => {
  it("creates the template with a v1 DRAFT pre-filled from DEFAULT_CONFIG", async () => {
    const { id, draft } = await as(() => createTemplate("TRAVELER", "  Skinny  "));
    const template = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(template.name).toBe("Skinny"); // trimmed in the service
    expect(template.docType).toBe("TRAVELER");
    expect(template.isDefault).toBe(false);
    expect(template.publishedVersionId).toBeNull();
    expect(draft.versionNumber).toBe(1);
    const row = await draftRowOf(id);
    expect(row?.versionNumber).toBe(1);
    expect(row?.config).toEqual(TRAVELER_DEFAULT());
  });

  it("refuses an empty (all-whitespace) name", async () => {
    await expect(as(() => createTemplate("TRAVELER", "   ")))
      .rejects.toThrow(/A template name is required/);
  });

  it("refuses a duplicate live name within the docType, allows it across types and after a delete", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Skinny"));
    await expect(as(() => createTemplate("TRAVELER", "Skinny"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already exists/),
    });
    // Same name, different type: fine — uniqueness is per (docType, name).
    await as(() => createTemplate("BOL", "Skinny"));
    // Partial-unique: a soft-deleted row frees the name for a genuinely NEW row.
    await as(() => publishDraft(id));
    await as(() => deleteTemplate(id, "superseded"));
    const again = await as(() => createTemplate("TRAVELER", "Skinny"));
    expect(again.id).not.toBe(id);
  });
});

describe("renameTemplate", () => {
  it("renames under the claim and audits it", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Skinny"));
    await as(() => renameTemplate(id, " Wide "));
    const template = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(template.name).toBe("Wide");
    const entries = await readAudit("documentTemplate", id);
    expect(entries.some((e) => e.action === "update")).toBe(true);
  });

  it("refuses a duplicate live name and writes no junk audit entry for a no-op rename", async () => {
    await as(() => createTemplate("TRAVELER", "Skinny"));
    const { id } = await as(() => createTemplate("TRAVELER", "Wide"));
    await expect(as(() => renameTemplate(id, "Skinny"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already exists/),
    });
    const before = (await readAudit("documentTemplate", id)).length;
    await as(() => renameTemplate(id, "Wide")); // unchanged
    expect((await readAudit("documentTemplate", id)).length).toBe(before);
  });

  it("404s a soft-deleted template", async () => {
    const id = await publishedTemplate("Doomed");
    await as(() => deleteTemplate(id, "cleanup"));
    await expect(as(() => renameTemplate(id, "Zombie"))).rejects.toMatchObject({ status: 404 });
  });
});

describe("openDraft — versionNumber allocated under the claim; config + logo copied forward", () => {
  it("opens v2 on a seeded Standard template, copying the published v1 config", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    expect(draft.versionNumber).toBe(2); // seeded v1 exists (Task 3)
    expect(draft.config).toEqual(TRAVELER_DEFAULT());
    expect(draft.logoMimeType).toBeNull();
  });

  it("refuses while a live DRAFT exists (named 400)", async () => {
    await as(() => openDraft(STANDARD_TRAVELER));
    await expect(as(() => openDraft(STANDARD_TRAVELER))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already has an open draft/),
    });
  });

  it("copies config AND logo from an explicit PUBLISHED source version — the §5.1 revert flow", async () => {
    // v1 published with a logo + marker config; v2 published plain; revert-from-v1 must carry both.
    const { id, draft: v1 } = await as(() => createTemplate("TRAVELER", "Reverting"));
    await as(() => editDraft(id, { config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: v1.updatedAt }));
    await as(() => uploadLogo(id, REAL_PNG, "image/png"));
    await as(() => publishDraft(id));
    await as(() => openDraft(id)); // v2
    await as(() => clearLogo(id)); // v2 diverges: no logo…
    const fresh = await draftRowOf(id); // fresh updatedAt — clearLogo bumped the draft
    await as(() => editDraft(id, {
      config: withBaseSize(TRAVELER_DEFAULT(), 11), updatedAt: fresh!.updatedAt,
    }));
    await as(() => publishDraft(id)); // …and marker 11

    const v3 = await as(() => openDraft(id, { fromVersion: 1 }));
    expect(v3.versionNumber).toBe(3);
    expect((v3.config as TemplateConfig).fonts.baseSize).toBe(10); // v1's marker, not v2's
    expect(v3.logoMimeType).toBe("image/png"); // v1's logo came along
    const bytes = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { templateId: id, versionNumber: 3 }, select: { logoImage: true },
    });
    expect(Buffer.from(bytes.logoImage!).equals(REAL_PNG)).toBe(true);
  });

  it("refuses a fromVersion that is not a PUBLISHED version of THIS template", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Strict Source"));
    await as(() => publishDraft(id)); // v1 published, no draft
    await expect(as(() => openDraft(id, { fromVersion: 9 }))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/not a published version of this template/),
    });
    // A DISCARDED version is not a legal source either.
    const v2 = await as(() => openDraft(id));
    await as(() => discardDraft(id));
    await expect(as(() => openDraft(id, { fromVersion: v2.versionNumber }))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/not a published version of this template/),
    });
    // Another template's published v1 is invisible from here — same refusal, scoped by template.
    await expect(as(() => openDraft(STANDARD_TRAVELER, { fromVersion: 2 }))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/not a published version of this template/),
    });
  });

  it("a discarded draft's number is never reused — the history may carry gaps", async () => {
    await as(() => openDraft(STANDARD_TRAVELER)); // v2
    await as(() => discardDraft(STANDARD_TRAVELER));
    const next = await as(() => openDraft(STANDARD_TRAVELER));
    expect(next.versionNumber).toBe(3);
    const numbers = (await prisma.documentTemplateVersion.findMany({
      where: { templateId: STANDARD_TRAVELER }, select: { versionNumber: true, status: true },
      orderBy: { versionNumber: "asc" },
    }));
    expect(numbers).toEqual([
      { versionNumber: 1, status: "PUBLISHED" },
      { versionNumber: 2, status: "DISCARDED" },
      { versionNumber: 3, status: "DRAFT" },
    ]);
  });
});

describe("editDraft — validated, backfilled, audited, and guarded by the updatedAt precondition", () => {
  it("stores the validated (backfilled) config and returns the new updatedAt", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    // Send a PARTIAL config — scalar knobs absent — and expect the stored row to be COMPLETE
    // (the §5.3 backfill result is what's stored, per the brief).
    const partial = { fonts: { family: "Roboto", baseSize: 10, headingSize: 12, smallSize: 6.5 } };
    const { updatedAt } = await as(() => editDraft(STANDARD_TRAVELER, {
      config: partial, updatedAt: draft.updatedAt,
    }));
    expect(updatedAt.getTime()).toBeGreaterThan(draft.updatedAt.getTime());
    const stored = await draftRowOf(STANDARD_TRAVELER);
    expect(stored?.config).toEqual(withBaseSize(TRAVELER_DEFAULT(), 10));
  });

  it("refuses a stale updatedAt with the named 409 — never a silent merge", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    await as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: draft.updatedAt,
    }));
    // A second save carrying the ORIGINAL updatedAt is someone else's stale editor.
    await expect(as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 11), updatedAt: draft.updatedAt,
    }))).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/changed since you loaded it/),
    });
    // The stale save changed nothing.
    const stored = await draftRowOf(STANDARD_TRAVELER);
    expect((stored?.config as TemplateConfig).fonts.baseSize).toBe(10);
    // A fresh one succeeds.
    await as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 11), updatedAt: stored!.updatedAt,
    }));
    expect(((await draftRowOf(STANDARD_TRAVELER))?.config as TemplateConfig).fonts.baseSize).toBe(11);
  });

  it("maps a TemplateConfigError to a 400 naming the offending element (§5.6 lock refusal)", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    const config = TRAVELER_DEFAULT();
    const header = config.sections.find((s) => s.key === "header")!;
    header.fields.find((f) => f.key === "barcode")!.visible = false;
    await expect(as(() => editDraft(STANDARD_TRAVELER, { config, updatedAt: draft.updatedAt })))
      .rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/"Order barcode" cannot be hidden/),
      });
  });

  it("audits the edit with the real before→after config diff (the house rule: diffs, not actions)", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    const row = await draftRowOf(STANDARD_TRAVELER);
    await as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: draft.updatedAt,
    }));
    const [entry] = await readAudit("documentTemplateVersion", row!.id);
    expect(entry.action).toBe("update");
    const before = entry.before as { config: TemplateConfig };
    const after = entry.after as { config: TemplateConfig };
    expect(before.config.fonts.baseSize).toBe(8);
    expect(after.config.fonts.baseSize).toBe(10);
  });

  it("writes no junk audit entry when the config is unchanged", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    const row = await draftRowOf(STANDARD_TRAVELER);
    await as(() => editDraft(STANDARD_TRAVELER, { config: TRAVELER_DEFAULT(), updatedAt: draft.updatedAt }));
    expect(await readAudit("documentTemplateVersion", row!.id)).toHaveLength(1); // the create only
  });

  it("refuses when no draft is open (named 400)", async () => {
    await expect(as(() => editDraft(STANDARD_TRAVELER, {
      config: TRAVELER_DEFAULT(), updatedAt: new Date(),
    }))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/no open draft/),
    });
  });
});

describe("discardDraft — a status flip, NEVER a delete (spec §4.1)", () => {
  it("flips the draft to DISCARDED; the row, its config, and its history survive", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    await as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: draft.updatedAt,
    }));
    await as(() => discardDraft(STANDARD_TRAVELER));
    const row = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { templateId: STANDARD_TRAVELER, versionNumber: 2 },
      select: { id: true, status: true, config: true },
    });
    expect(row.status).toBe("DISCARDED");
    expect((row.config as TemplateConfig).fonts.baseSize).toBe(10); // config kept, append-only
    const entries = await readAudit("documentTemplateVersion", row.id);
    expect(entries[0].action).toBe("update"); // the flip is audited as an update, never a delete
    expect(entries.map((e) => e.action)).not.toContain("delete");
  });

  it("refuses when no draft is open (named 400)", async () => {
    await expect(as(() => discardDraft(STANDARD_TRAVELER))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/no open draft/),
    });
  });
});

describe("publishDraft — flip + publishedAt/publishedById + pointer move, atomically under the claim", () => {
  it("publishes the draft and moves publishedVersionId to it", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    await as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: draft.updatedAt,
    }));
    const { versionId, versionNumber } = await as(() => publishDraft(STANDARD_TRAVELER));
    expect(versionNumber).toBe(2);
    const template = await prisma.documentTemplate.findUniqueOrThrow({
      where: { id: STANDARD_TRAVELER }, include: { publishedVersion: true },
    });
    expect(template.publishedVersionId).toBe(versionId);
    expect(template.publishedVersion?.status).toBe("PUBLISHED");
    expect(template.publishedVersion?.publishedAt).toBeInstanceOf(Date);
    expect(template.publishedVersion?.publishedById).toBe(actor.id); // the actor from context
    // v1 stays PUBLISHED — history is append-only; only the pointer moved.
    const v1 = await prisma.documentTemplateVersion.findUniqueOrThrow({
      where: { id: templateVersionId("TRAVELER") }, select: { status: true },
    });
    expect(v1.status).toBe("PUBLISHED");
  });

  it("refuses when no draft is open (named 400)", async () => {
    await expect(as(() => publishDraft(STANDARD_TRAVELER))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/no open draft/),
    });
  });
});

describe("setDefault — refuses never-published; exactly one live default per docType, always", () => {
  it("refuses a template with no published version (§4.1's invariant)", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Never Published"));
    await expect(as(() => setDefault(id))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/never been published/),
    });
    const row = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(row.isDefault).toBe(false);
  });

  it("clears the old default and sets the new one in the same transaction, audited both sides", async () => {
    const id = await publishedTemplate("New Default");
    await as(() => setDefault(id));
    const rows = await prisma.documentTemplate.findMany({
      where: { docType: "TRAVELER", deletedAt: null, isDefault: true },
    });
    expect(rows.map((r) => r.id)).toEqual([id]); // exactly one default
    // Both sides audited: the demoted Standard and the promoted newcomer.
    const demoted = await readAudit("documentTemplate", STANDARD_TRAVELER);
    expect(demoted.some((e) => e.action === "update"
      && (e.before as { isDefault: boolean }).isDefault === true
      && (e.after as { isDefault: boolean }).isDefault === false)).toBe(true);
    const promoted = await readAudit("documentTemplate", id);
    expect(promoted.some((e) => e.action === "update"
      && (e.after as { isDefault: boolean }).isDefault === true)).toBe(true);
  });

  it("is a no-op (no junk audit) when the template is already the default", async () => {
    const before = (await readAudit("documentTemplate", STANDARD_TRAVELER)).length;
    await as(() => setDefault(STANDARD_TRAVELER));
    expect((await readAudit("documentTemplate", STANDARD_TRAVELER)).length).toBe(before);
  });
});

describe("deleteTemplate — reasoned, refused for the default, §5.14-blocked-and-named", () => {
  it("requires a trimmed, non-empty reason (enforced in the service)", async () => {
    const id = await publishedTemplate("Doomed");
    await expect(as(() => deleteTemplate(id, "   "))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/reason/i),
    });
  });

  it("refuses to delete the current default until another default is set", async () => {
    await expect(as(() => deleteTemplate(STANDARD_TRAVELER, "cleanup"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/default/),
    });
  });

  it("refuses and NAMES the customers whose live assignments point at it", async () => {
    const id = await publishedTemplate("Assigned");
    const acme = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    const beta = await prisma.customer.create({ data: { code: "BC2", name: "Beta" } });
    await prisma.customerTemplateAssignment.createMany({ data: [
      { customerId: acme.id, docType: "TRAVELER", templateId: id },
      { customerId: beta.id, docType: "TRAVELER", templateId: id },
    ] });
    const err = await as(() => deleteTemplate(id, "cleanup")).then(() => null, (e: Error) => e);
    expect(err).toMatchObject({ status: 400 });
    expect((err as Error).message).toContain("assigned to 2 customer");
    expect((err as Error).message).toContain("AC1 · Acme");
    expect((err as Error).message).toContain("BC2 · Beta");
    const row = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).toBeNull(); // refused — nothing deleted
  });

  it("a soft-deleted (cleared) assignment does not block from the grave", async () => {
    const id = await publishedTemplate("Cleared");
    const acme = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    await prisma.customerTemplateAssignment.create({
      data: { customerId: acme.id, docType: "TRAVELER", templateId: id, deletedAt: new Date() },
    });
    await as(() => deleteTemplate(id, "cleanup"));
    const row = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
  });

  it("soft-deletes with the reason in the audit entry; versions stay untouched (append-only history)", async () => {
    const id = await publishedTemplate("Doomed");
    await as(() => openDraft(id)); // a live draft does not block the template's own delete
    await as(() => deleteTemplate(id, "  superseded by Wide  "));
    const row = await prisma.documentTemplate.findUniqueOrThrow({ where: { id } });
    expect(row.deletedAt).not.toBeNull();
    const entries = await readAudit("documentTemplate", id);
    expect(entries[0].action).toBe("delete");
    expect(entries[0].reason).toBe("superseded by Wide"); // trimmed
    expect(await prisma.documentTemplateVersion.count({ where: { templateId: id } })).toBe(2);
  });
});

describe("logo upload — magic-byte sniffed (#49), 512KB cap, DRAFT-only, byte-free audit", () => {
  it("accepts a PNG and a JPEG whose bytes match the declared MIME", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Logoed"));
    await as(() => uploadLogo(id, REAL_PNG, "image/png"));
    let row = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { templateId: id, status: "DRAFT" }, select: { logoImage: true, logoMimeType: true },
    });
    expect(row.logoMimeType).toBe("image/png");
    expect(Buffer.from(row.logoImage!).equals(REAL_PNG)).toBe(true);
    await as(() => uploadLogo(id, JPEG_PREFIX, "image/jpeg"));
    row = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { templateId: id, status: "DRAFT" }, select: { logoImage: true, logoMimeType: true },
    });
    expect(row.logoMimeType).toBe("image/jpeg");
  });

  it("rejects bytes that do not match the declared MIME (#49's lesson) and undeclared types", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Lied To"));
    await expect(as(() => uploadLogo(id, JPEG_PREFIX, "image/png"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/not a valid image\/png/),
    });
    await expect(as(() => uploadLogo(id, REAL_PNG, "image/jpeg"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/not a valid image\/jpeg/),
    });
    await expect(as(() => uploadLogo(id, REAL_PNG, "image/gif"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/must be one of/),
    });
  });

  it("caps the upload at 512KB", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Too Big"));
    const oversized = Buffer.concat([REAL_PNG, Buffer.alloc(LOGO_MAX_BYTES)]);
    await expect(as(() => uploadLogo(id, oversized, "image/png"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/cannot exceed 512 KB/),
    });
    const exactly = Buffer.concat([REAL_PNG, Buffer.alloc(LOGO_MAX_BYTES - REAL_PNG.length)]);
    await as(() => uploadLogo(id, exactly, "image/png")); // the cap itself is legal
  });

  it("is DRAFT-only: upload and clear both refuse when no draft is open (named 400)", async () => {
    const id = await publishedTemplate("No Draft");
    await expect(as(() => uploadLogo(id, REAL_PNG, "image/png"))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/open draft/),
    });
    await expect(as(() => clearLogo(id))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/open draft/),
    });
  });

  it("clearLogo empties both columns on the draft", async () => {
    const { id } = await as(() => createTemplate("TRAVELER", "Cleared"));
    await as(() => uploadLogo(id, REAL_PNG, "image/png"));
    await as(() => clearLogo(id));
    const row = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { templateId: id, status: "DRAFT" }, select: { logoImage: true, logoMimeType: true },
    });
    expect(row.logoImage).toBeNull();
    expect(row.logoMimeType).toBeNull();
  });

  it("the upload's audit entry carries NO logo bytes (SNAPSHOT_SELECT + a byte-free payload)", async () => {
    const { id, draft } = await as(() => createTemplate("TRAVELER", "Audited"));
    await as(() => uploadLogo(id, REAL_PNG, "image/png"));
    const [entry] = await readAudit("documentTemplateVersion", draft.id);
    expect(entry.action).toBe("update");
    expect(entry.before as object).not.toHaveProperty("logoImage");
    expect(entry.after as object).not.toHaveProperty("logoImage");
    expect((entry.after as { logoMimeType: string }).logoMimeType).toBe("image/png");
    const pngBase64 = REAL_PNG.toString("base64");
    for (const s of [JSON.stringify(entry.before), JSON.stringify(entry.after)]) {
      expect(s).not.toContain('"type":"Buffer"');
      expect(s.includes(pngBase64.slice(0, 24))).toBe(false);
    }
  });
});

describe("version immutability — no service path updates a PUBLISHED row (spec §4.1)", () => {
  it("every mutation against a published-only template refuses, leaving the published row untouched", async () => {
    const { id, draft } = await as(() => createTemplate("TRAVELER", "Frozen"));
    await as(() => uploadLogo(id, REAL_PNG, "image/png"));
    await as(() => publishDraft(id));
    const before = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    expect(before.status).toBe("PUBLISHED");

    await expect(as(() => editDraft(id, { config: TRAVELER_DEFAULT(), updatedAt: before.updatedAt })))
      .rejects.toMatchObject({ status: 400 });
    await expect(as(() => discardDraft(id))).rejects.toMatchObject({ status: 400 });
    await expect(as(() => publishDraft(id))).rejects.toMatchObject({ status: 400 });
    await expect(as(() => uploadLogo(id, JPEG_PREFIX, "image/jpeg"))).rejects.toMatchObject({ status: 400 });
    await expect(as(() => clearLogo(id))).rejects.toMatchObject({ status: 400 });

    const after = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.status).toBe("PUBLISHED");
    expect(after.config).toEqual(before.config);
    expect(after.logoMimeType).toBe("image/png");
    expect(Buffer.from(after.logoImage!).equals(REAL_PNG)).toBe(true);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("grep-level: every version update in the service is keyed on the open draft; none deletes", () => {
    const src = readFileSync(join(process.cwd(), "src/server/templates.ts"), "utf8");
    const updates = src.match(/documentTemplateVersion\.update\s*\(/g) ?? [];
    expect(updates.length).toBeGreaterThan(0);
    const draftKeyed = src.match(
      /documentTemplateVersion\.update\s*\(\s*\{\s*where:\s*\{\s*id:\s*draft\.id\s*\}/g) ?? [];
    expect(draftKeyed.length).toBe(updates.length);
    expect(src).not.toMatch(/documentTemplateVersion\.updateMany/);
    expect(src).not.toMatch(/documentTemplateVersion\.delete/);
  });
});

describe("reads — list, detail (history WITHOUT config bodies), version detail (ONE config)", () => {
  it("lists per docType with the default flag, draft presence, and LIVE assignment counts", async () => {
    const id = await publishedTemplate("Second");
    await as(() => openDraft(id));
    const acme = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    const gone = await prisma.customer.create({ data: { code: "GN1", name: "Gone" } });
    await prisma.customerTemplateAssignment.createMany({ data: [
      { customerId: acme.id, docType: "TRAVELER", templateId: id },
      { customerId: gone.id, docType: "TRAVELER", templateId: id, deletedAt: new Date() },
    ] });
    const all = await listTemplates();
    expect(all.length).toBe(9); // 8 seeded + 1 created
    const travelers = await listTemplates("TRAVELER");
    expect(travelers.map((t) => t.name).sort()).toEqual(["Second", "Standard"]);
    const standard = travelers.find((t) => t.id === STANDARD_TRAVELER)!;
    expect(standard).toMatchObject({
      isDefault: true, publishedVersionNumber: 1, hasDraft: false, assignmentCount: 0,
    });
    const second = travelers.find((t) => t.id === id)!;
    expect(second).toMatchObject({
      isDefault: false, publishedVersionNumber: 1, hasDraft: true, assignmentCount: 1,
    });
  });

  it("detail carries the draft (with config) and the version history WITHOUT config bodies", async () => {
    const draft = await as(() => openDraft(STANDARD_TRAVELER));
    await as(() => editDraft(STANDARD_TRAVELER, {
      config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: draft.updatedAt,
    }));
    const detail = await getTemplate(STANDARD_TRAVELER);
    expect(detail.publishedVersionNumber).toBe(1);
    expect(detail.draft?.versionNumber).toBe(2);
    expect((detail.draft?.config as TemplateConfig).fonts.baseSize).toBe(10);
    expect(detail.versions.map((v) => [v.versionNumber, v.status])).toEqual(
      [[2, "DRAFT"], [1, "PUBLISHED"]]);
    for (const v of detail.versions) expect(v).not.toHaveProperty("config");
  });

  it("a version-detail read returns that one version's stored config", async () => {
    const v1 = await getTemplateVersion(STANDARD_TRAVELER, 1);
    expect(v1.status).toBe("PUBLISHED");
    expect(v1.config).toEqual(TRAVELER_DEFAULT());
    await expect(getTemplateVersion(STANDARD_TRAVELER, 9)).rejects.toMatchObject({ status: 404 });
  });

  it("404s deleted and unknown templates", async () => {
    await expect(getTemplate("nope")).rejects.toMatchObject({ status: 404 });
    const id = await publishedTemplate("Doomed");
    await as(() => deleteTemplate(id, "cleanup"));
    await expect(getTemplate(id)).rejects.toMatchObject({ status: 404 });
  });
});

// ------------------------------------------------------------------------------------------------
// Concurrency — the claim is the guard; every service transaction is Read Committed, so nothing
// else can be. See the file header for the discipline and the task report for the RED transcripts.
// ------------------------------------------------------------------------------------------------

const TIMED_OUT = Symbol("timed out");
async function provesBlocked(competitor: Promise<unknown>): Promise<void> {
  const raceResult = await Promise.race([
    competitor.then(() => "settled" as const, () => "settled" as const),
    new Promise((resolve) => setTimeout(() => resolve(TIMED_OUT), 200)),
  ]);
  expect(raceResult).toBe(TIMED_OUT);
}

describe("concurrency (RED-verified — see task report)", () => {
  it("(a) two concurrent openDraft → exactly one DRAFT and the loser's refusal is the NAMED 400", async () => {
    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The holder: hand-scripted openDraft effect — takes PRECISELY the template-row FOR UPDATE
    // claim, creates the DRAFT v2 the way a winning openDraft would, then holds it uncommitted.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DocumentTemplate" WHERE "id" = ${STANDARD_TRAVELER} FOR UPDATE`;
      await tx.documentTemplateVersion.create({ data: {
        templateId: STANDARD_TRAVELER, versionNumber: 2, status: "DRAFT",
        config: TRAVELER_DEFAULT() as unknown as Prisma.InputJsonValue,
      } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    // The competitor: the REAL openDraft on its own Read Committed transaction (the public path's
    // default) — the claim is the only thing that can serialize it against the holder.
    const competitor = as(() => openDraft(STANDARD_TRAVELER));
    await provesBlocked(competitor);
    mayRelease();
    await holder;

    // The discriminator: parked on the claim, the competitor's fresh read sees the committed
    // draft and refuses with the NAMED 400 — never a torn allocation, never a P2002 surprise.
    await expect(competitor).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/already has an open draft/),
    });
    expect(await prisma.documentTemplateVersion.count({
      where: { templateId: STANDARD_TRAVELER, status: "DRAFT" },
    })).toBe(1);
  });

  it("(b) concurrent publishDraft × 2 → one wins, one named 400, the winner's stamp survives", async () => {
    const { id, draft } = await as(() => createTemplate("TRAVELER", "Race Publish"));

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The holder: hand-scripted publish — the claim, the status flip (stamped with the HOLDER
    // user, so an overwrite by the loser would be visible), the pointer move — held uncommitted.
    const publishedAt = new Date("2026-08-13T00:00:00Z");
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DocumentTemplate" WHERE "id" = ${id} FOR UPDATE`;
      await tx.documentTemplateVersion.update({
        where: { id: draft.id },
        data: { status: "PUBLISHED", publishedAt, publishedById: holderUser.id },
      });
      await tx.documentTemplate.update({ where: { id }, data: { publishedVersionId: draft.id } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    const competitor = as(() => publishDraft(id)); // would stamp actor.id if it ever won
    await provesBlocked(competitor);
    mayRelease();
    await holder;

    await expect(competitor).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/no open draft/),
    });
    // The winner's stamp is intact — the loser re-read under the claim and never overwrote it.
    const row = await prisma.documentTemplateVersion.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.status).toBe("PUBLISHED");
    expect(row.publishedById).toBe(holderUser.id);
    expect(row.publishedAt?.getTime()).toBe(publishedAt.getTime());
  });

  it("(c) publish-vs-openDraft → the new draft copies the JUST-published version, never a stale one", async () => {
    // v1 published with marker 10; draft v2 edited to marker 11, about to be published.
    const { id, draft: v1 } = await as(() => createTemplate("TRAVELER", "Race Open"));
    await as(() => editDraft(id, { config: withBaseSize(TRAVELER_DEFAULT(), 10), updatedAt: v1.updatedAt }));
    await as(() => publishDraft(id));
    const v2 = await as(() => openDraft(id));
    await as(() => editDraft(id, { config: withBaseSize(TRAVELER_DEFAULT(), 11), updatedAt: v2.updatedAt }));
    const v2Row = await draftRowOf(id);

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((resolve) => { hasClaimed = resolve; });
    let mayRelease!: () => void;
    const release = new Promise<void>((resolve) => { mayRelease = resolve; });

    // The holder: hand-scripted publish of v2, held uncommitted.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DocumentTemplate" WHERE "id" = ${id} FOR UPDATE`;
      await tx.documentTemplateVersion.update({
        where: { id: v2Row!.id },
        data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: holderUser.id },
      });
      await tx.documentTemplate.update({ where: { id }, data: { publishedVersionId: v2Row!.id } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    // The competitor: the REAL openDraft. Parked on the claim, it must wake to the published v2
    // and copy ITS config — without the claim it would either refuse (seeing the still-DRAFT v2)
    // or copy v1's config off a stale pointer read; both are wrong, and both went RED.
    const competitor = as(() => openDraft(id));
    await provesBlocked(competitor);
    mayRelease();
    await holder;

    const v3 = await competitor;
    expect(v3.versionNumber).toBe(3);
    expect((v3.config as TemplateConfig).fonts.baseSize).toBe(11); // v2's marker — the fresh copy
    expect(await prisma.documentTemplateVersion.count({ where: { templateId: id, status: "DRAFT" } })).toBe(1);
  });

  it("(d) publish atomicity for readers: no reader ever observes the pointer at a non-PUBLISHED row", async () => {
    const { id, draft: v1 } = await as(() => createTemplate("TRAVELER", "Atomic"));
    await as(() => publishDraft(id));
    await as(() => openDraft(id));
    const v2Row = await draftRowOf(id);

    const tornPointer = async (): Promise<boolean> => {
      const t = await prisma.documentTemplate.findUniqueOrThrow({
        where: { id }, select: { publishedVersion: { select: { status: true } } },
      });
      return t.publishedVersion !== null && t.publishedVersion.status !== "PUBLISHED";
    };

    // Non-vacuity: hand-write the torn state the transaction forbids (pointer moved to the
    // still-DRAFT v2 in an autocommit write) and prove the probe SEES it — then restore.
    await prisma.documentTemplate.update({ where: { id }, data: { publishedVersionId: v2Row!.id } });
    expect(await tornPointer()).toBe(true);
    await prisma.documentTemplate.update({ where: { id }, data: { publishedVersionId: v1.id } });
    expect(await tornPointer()).toBe(false);

    // The real publish, under a concurrent polling reader at ANY isolation (plain reads —
    // §5.1's argument is immutability + atomic commit, not locking; no reader claims anything).
    const observations: boolean[] = [];
    let stop = false;
    const reader = (async () => { while (!stop) observations.push(await tornPointer()); })();
    await as(() => publishDraft(id));
    stop = true;
    await reader;
    expect(observations.length).toBeGreaterThan(0);
    expect(observations.some(Boolean)).toBe(false);

    const t = await prisma.documentTemplate.findUniqueOrThrow({
      where: { id }, select: { publishedVersionId: true, publishedVersion: { select: { status: true } } },
    });
    expect(t.publishedVersionId).toBe(v2Row!.id);
    expect(t.publishedVersion?.status).toBe("PUBLISHED");
  });
});
