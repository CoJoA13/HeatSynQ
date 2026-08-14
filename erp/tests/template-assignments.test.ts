import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll, templateId, templateVersionId } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import type { Prisma, TemplateDocType } from "../prisma/generated/prisma/client";
import { runWithContext } from "@/server/context";
import { readAudit } from "@/server/audit";
import { HttpError } from "@/server/errors";
import {
  assignTemplate, clearAssignment, listAssignments, resolveTemplateForPrint,
  resolveAssignmentsForCustomer,
} from "@/server/template-assignments";
import { createTemplate, publishDraft, deleteTemplate, uploadLogo } from "@/server/templates";
import { deleteCustomer } from "@/server/customers";
import { defaultConfigFor, TEMPLATE_DOC_TYPES } from "@/lib/template-contracts/index";
import {
  GET as listAssignmentsRoute, PUT as assignRoute, DELETE as clearRoute,
} from "@/app/api/customers/[id]/template-assignments/route";
import { GET as resolvedRoute } from "@/app/api/customers/[id]/template-assignments/resolved/route";
import { GET as namesRoute } from "@/app/api/templates/names/route";

/**
 * Phase 7 Task 5 — assignment + print-time resolution (spec §4.1, §5.2, §7).
 *
 * Concurrency discipline (the templates.test.ts precedent): every service transaction here runs
 * at DEFAULT (Read Committed) isolation — no SSI to hide behind — so the ONLY thing that can
 * serialize `assignTemplate` against `deleteTemplate` is the shared template-row
 * `SELECT … FOR UPDATE` claim (`claimTemplate`, the one claim path both route through). The two
 * races below park the real service call behind a hand-scripted holder that took exactly that
 * claim, prove it is genuinely blocked, then release and assert the outcome the claim
 * guarantees. RED-verified by removing the claim from `claimTemplate` (transcript in the task
 * report).
 */

const STANDARD_TRAVELER = templateId("TRAVELER");

let actor: { id: string; name: string };

const as = <T>(fn: () => Promise<T>) => runWithContext({ actor, user: null }, fn);

beforeEach(async () => {
  await truncateAll();
  const u = await prisma.user.create({
    data: { username: "ta-actor", displayName: "Assignment Actor", passwordHash: "x" },
  });
  actor = { id: u.id, name: u.displayName };
});

// A real 1×1 PNG (the user-signature.test.ts fixture) — the sniff (#49) checks magic bytes.
const REAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64");

async function makeCustomer(code: string, parentId: string | null = null): Promise<string> {
  const c = await prisma.customer.create({
    data: { code, name: `${code} Incorporated`, parentId }, select: { id: true },
  });
  return c.id;
}

/** create → publish, leaving a live published TRAVELER template. Returns the template id. */
async function publishedTemplate(name: string, docType: TemplateDocType = "TRAVELER"): Promise<string> {
  const { id } = await as(() => createTemplate(docType, name));
  await as(() => publishDraft(id));
  return id;
}

async function assignmentRow(customerId: string, docType: TemplateDocType) {
  return prisma.customerTemplateAssignment.findFirst({
    where: { customerId, docType, deletedAt: null },
  });
}

/** The print-side entry point, exactly as its callers will use it: on their own transaction. */
const resolve = (docType: TemplateDocType, customerId: string) =>
  prisma.$transaction((tx) => resolveTemplateForPrint(tx, docType, customerId));

describe("assignTemplate — assign / replace / no-op", () => {
  it("creates a live assignment and audits the create", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Skinny");
    const created = await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    const row = await assignmentRow(cust, "TRAVELER");
    expect(row?.id).toBe(created.id);
    expect(row?.templateId).toBe(tmpl);
    const entries = await readAudit("customerTemplateAssignment", created.id);
    const create = entries.find((e) => e.action === "create");
    expect(create).toBeDefined();
    expect(create?.after).toMatchObject({ customerId: cust, docType: "TRAVELER", templateId: tmpl });
  });

  it("REPLACES the live assignment for the pair (same row, audited update with before→after ids)", async () => {
    const cust = await makeCustomer("AC1");
    const a = await publishedTemplate("Skinny");
    const b = await publishedTemplate("Wide");
    const first = await as(() => assignTemplate(cust, "TRAVELER", a));
    const second = await as(() => assignTemplate(cust, "TRAVELER", b));
    expect(second.id).toBe(first.id); // replaced, not a second live row
    const row = await assignmentRow(cust, "TRAVELER");
    expect(row?.templateId).toBe(b);
    expect(await prisma.customerTemplateAssignment.count({
      where: { customerId: cust, docType: "TRAVELER" },
    })).toBe(1);
    const update = (await readAudit("customerTemplateAssignment", first.id))
      .find((e) => e.action === "update");
    expect((update?.before as { templateId: string }).templateId).toBe(a);
    expect((update?.after as { templateId: string }).templateId).toBe(b);
  });

  it("re-assigning the SAME template is a no-op — no junk audit entry", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Skinny");
    const created = await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    const before = (await readAudit("customerTemplateAssignment", created.id)).length;
    await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    expect((await readAudit("customerTemplateAssignment", created.id)).length).toBe(before);
  });

  it("one customer can hold assignments for several docTypes at once", async () => {
    const cust = await makeCustomer("AC1");
    const t = await publishedTemplate("Skinny");
    const s = await publishedTemplate("Ticket B", "SHIPPER");
    await as(() => assignTemplate(cust, "TRAVELER", t));
    await as(() => assignTemplate(cust, "SHIPPER", s));
    expect((await listAssignments(cust)).length).toBe(2);
  });
});

describe("assignTemplate — refusals", () => {
  it("refuses a template that has never been published (the setDefault mirror, named 400)", async () => {
    const cust = await makeCustomer("AC1");
    const { id } = await as(() => createTemplate("TRAVELER", "Unpublished"));
    await expect(as(() => assignTemplate(cust, "TRAVELER", id))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/never been published/),
    });
  });

  it("refuses a docType mismatch with a named 400", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Skinny"); // a TRAVELER template
    await expect(as(() => assignTemplate(cust, "SHIPPER", tmpl))).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/TRAVELER.*SHIPPER/),
    });
  });

  it("refuses a soft-deleted template (404 via the claim) and an unknown template id", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Doomed");
    await as(() => deleteTemplate(tmpl, "superseded"));
    await expect(as(() => assignTemplate(cust, "TRAVELER", tmpl))).rejects.toMatchObject({
      status: 404, message: expect.stringMatching(/Template not found/),
    });
    await expect(as(() => assignTemplate(cust, "TRAVELER", "nope"))).rejects.toMatchObject({
      status: 404,
    });
  });

  it("refuses a soft-deleted customer and an unknown customer (404)", async () => {
    const tmpl = await publishedTemplate("Skinny");
    const cust = await makeCustomer("AC1");
    await as(() => deleteCustomer(cust, "closed shop"));
    await expect(as(() => assignTemplate(cust, "TRAVELER", tmpl))).rejects.toMatchObject({
      status: 404, message: expect.stringMatching(/Customer not found/),
    });
    await expect(as(() => assignTemplate("nope", "TRAVELER", tmpl))).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe("clearAssignment", () => {
  it("soft-deletes the live assignment, audited, with NO reason required (§5.17)", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Skinny");
    const created = await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    await as(() => clearAssignment(cust, "TRAVELER"));
    expect(await assignmentRow(cust, "TRAVELER")).toBeNull();
    const dead = await prisma.customerTemplateAssignment.findUniqueOrThrow({ where: { id: created.id } });
    expect(dead.deletedAt).not.toBeNull();
    const del = (await readAudit("customerTemplateAssignment", created.id))
      .find((e) => e.action === "delete");
    expect(del).toBeDefined();
    expect(del?.reason ?? null).toBeNull(); // a pure preference — nothing rides along (§5.17)
  });

  it("404s when no live assignment exists for the pair (including a double clear)", async () => {
    const cust = await makeCustomer("AC1");
    await expect(as(() => clearAssignment(cust, "TRAVELER"))).rejects.toMatchObject({ status: 404 });
    const tmpl = await publishedTemplate("Skinny");
    await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    await as(() => clearAssignment(cust, "TRAVELER"));
    await expect(as(() => clearAssignment(cust, "TRAVELER"))).rejects.toMatchObject({ status: 404 });
  });

  it("a cleared pair re-assigns as a genuinely NEW row (partial-unique, no revival)", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Skinny");
    const first = await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    await as(() => clearAssignment(cust, "TRAVELER"));
    const second = await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    expect(second.id).not.toBe(first.id);
    expect(await prisma.customerTemplateAssignment.count({
      where: { customerId: cust, docType: "TRAVELER" },
    })).toBe(2); // the dead row stays as history
  });
});

describe("listAssignments", () => {
  it("returns live assignments with template names; cleared rows drop out", async () => {
    const cust = await makeCustomer("AC1");
    const t = await publishedTemplate("Skinny");
    const s = await publishedTemplate("Ticket B", "SHIPPER");
    await as(() => assignTemplate(cust, "TRAVELER", t));
    await as(() => assignTemplate(cust, "SHIPPER", s));
    const rows = await listAssignments(cust);
    expect(rows).toHaveLength(2);
    const traveler = rows.find((r) => r.docType === "TRAVELER");
    expect(traveler).toMatchObject({ templateId: t, templateName: "Skinny" });
    await as(() => clearAssignment(cust, "SHIPPER"));
    expect(await listAssignments(cust)).toHaveLength(1);
  });
});

describe("resolveTemplateForPrint — the §5.2 walk-to-root chain", () => {
  it("no assignment anywhere → the docType's Standard default, backfill-parsed config", async () => {
    const cust = await makeCustomer("AC1");
    const resolved = await resolve("TRAVELER", cust);
    expect(resolved.templateId).toBe(STANDARD_TRAVELER);
    expect(resolved.versionId).toBe(templateVersionId("TRAVELER"));
    expect(resolved.config).toEqual(defaultConfigFor("TRAVELER"));
    expect(resolved.logoImage).toBeNull();
    expect(resolved.logoMimeType).toBeNull();
  });

  it("own assignment wins over the parent's and the default", async () => {
    const parent = await makeCustomer("PAR");
    const child = await makeCustomer("CHI", parent);
    const forParent = await publishedTemplate("Parent Style");
    const forChild = await publishedTemplate("Child Style");
    await as(() => assignTemplate(parent, "TRAVELER", forParent));
    await as(() => assignTemplate(child, "TRAVELER", forChild));
    expect((await resolve("TRAVELER", child)).templateId).toBe(forChild);
  });

  it("a division with no assignment falls to its parent's", async () => {
    const parent = await makeCustomer("PAR");
    const child = await makeCustomer("CHI", parent);
    const forParent = await publishedTemplate("Parent Style");
    await as(() => assignTemplate(parent, "TRAVELER", forParent));
    expect((await resolve("TRAVELER", child)).templateId).toBe(forParent);
  });

  it("a grandchild walks grandparent-then-root in a 3-deep tree", async () => {
    const root = await makeCustomer("ROOT");
    const mid = await makeCustomer("MID", root);
    const leaf = await makeCustomer("LEAF", mid);
    const forRoot = await publishedTemplate("Root Style");
    await as(() => assignTemplate(root, "TRAVELER", forRoot));
    expect((await resolve("TRAVELER", leaf)).templateId).toBe(forRoot);
    // The nearer ancestor wins once it has its own.
    const forMid = await publishedTemplate("Mid Style");
    await as(() => assignTemplate(mid, "TRAVELER", forMid));
    expect((await resolve("TRAVELER", leaf)).templateId).toBe(forMid);
  });

  it("resolution is per docType — a TRAVELER assignment never answers a SHIPPER print", async () => {
    const cust = await makeCustomer("AC1");
    const t = await publishedTemplate("Skinny");
    await as(() => assignTemplate(cust, "TRAVELER", t));
    expect((await resolve("SHIPPER", cust)).templateId).toBe(templateId("SHIPPER"));
  });

  it("a soft-deleted (cleared) assignment is ignored — the walk falls onward", async () => {
    const parent = await makeCustomer("PAR");
    const child = await makeCustomer("CHI", parent);
    const forParent = await publishedTemplate("Parent Style");
    const forChild = await publishedTemplate("Child Style");
    await as(() => assignTemplate(parent, "TRAVELER", forParent));
    await as(() => assignTemplate(child, "TRAVELER", forChild));
    await as(() => clearAssignment(child, "TRAVELER"));
    expect((await resolve("TRAVELER", child)).templateId).toBe(forParent);
  });

  it("an assignment whose TEMPLATE is soft-deleted is skipped (both deletedAts filtered)", async () => {
    // No service path produces a live assignment on a dead template (deleteTemplate is
    // §5.14-blocked by live assignments; assign claims the row) — hand-write the state raw,
    // belt-and-braces per the plan.
    const parent = await makeCustomer("PAR");
    const child = await makeCustomer("CHI", parent);
    const forParent = await publishedTemplate("Parent Style");
    const forChild = await publishedTemplate("Child Style");
    await as(() => assignTemplate(parent, "TRAVELER", forParent));
    await as(() => assignTemplate(child, "TRAVELER", forChild));
    await prisma.documentTemplate.update({
      where: { id: forChild }, data: { deletedAt: new Date() },
    });
    expect((await resolve("TRAVELER", child)).templateId).toBe(forParent);
  });

  it("terminates on a hand-written parentId cycle and falls to the default", async () => {
    // updateCustomer's assertNoCycle guards the write path; the read must self-bound anyway.
    const a = await makeCustomer("CYA");
    const b = await makeCustomer("CYB", a);
    await prisma.customer.update({ where: { id: a }, data: { parentId: b } });
    const resolved = await resolve("TRAVELER", a);
    expect(resolved.templateId).toBe(STANDARD_TRAVELER);
  });

  it("config is the BACKFILLED parse of the stored JSON — a stripped key comes back as its default", async () => {
    const cust = await makeCustomer("AC1");
    const stored = defaultConfigFor("TRAVELER") as unknown as Record<string, unknown>;
    delete stored.pageFooter; // simulate a version stored before the knob existed
    await prisma.documentTemplateVersion.update({
      where: { id: templateVersionId("TRAVELER") },
      data: { config: stored as unknown as Prisma.InputJsonValue },
    });
    const resolved = await resolve("TRAVELER", cust);
    expect(resolved.config.pageFooter).toBe(false); // the contract default, backfilled at parse
  });

  it("carries the published version's logo bytes and mime type", async () => {
    const cust = await makeCustomer("AC1");
    const { id } = await as(() => createTemplate("TRAVELER", "Logoed"));
    await as(() => uploadLogo(id, REAL_PNG, "image/png"));
    await as(() => publishDraft(id));
    await as(() => assignTemplate(cust, "TRAVELER", id));
    const resolved = await resolve("TRAVELER", cust);
    expect(resolved.logoMimeType).toBe("image/png");
    expect(resolved.logoImage).not.toBeNull();
    expect(Buffer.from(resolved.logoImage!).equals(REAL_PNG)).toBe(true);
  });

  it("NEVER returns null — a missing default is a broken invariant and throws a plain Error", async () => {
    const cust = await makeCustomer("AC1");
    await prisma.documentTemplate.update({
      where: { id: STANDARD_TRAVELER }, data: { isDefault: false },
    });
    const failure = await resolve("TRAVELER", cust).then(() => null, (e: unknown) => e);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(HttpError); // a bug, not an expected failure
    expect((failure as Error).message).toMatch(/default/);
  });
});

describe("resolveAssignmentsForCustomer — the customer-page display resolution (Task 20)", () => {
  it("returns one row per docType (all 8), each never blank, defaulting when nothing is assigned", async () => {
    const cust = await makeCustomer("AC1");
    const rows = await resolveAssignmentsForCustomer(cust);
    expect(rows.map((r) => r.docType).sort()).toEqual([...TEMPLATE_DOC_TYPES].sort());
    for (const r of rows) {
      expect(r.source).toBe("default");           // nothing assigned anywhere
      expect(r.resolvedTemplateName).toBe("Standard"); // the seeded default
      expect(r.ownTemplateId).toBeNull();
      expect(r.inheritedFromCode).toBeNull();
    }
  });

  it("reports OWN when the customer has its own assignment (carries the own template id)", async () => {
    const cust = await makeCustomer("AC1");
    const t = await publishedTemplate("Fancy Traveler");
    await as(() => assignTemplate(cust, "TRAVELER", t));
    const trav = (await resolveAssignmentsForCustomer(cust)).find((r) => r.docType === "TRAVELER")!;
    expect(trav.source).toBe("own");
    expect(trav.ownTemplateId).toBe(t);
    expect(trav.resolvedTemplateName).toBe("Fancy Traveler");
    expect(trav.inheritedFromCode).toBeNull();
  });

  it("reports INHERITED from the nearest ancestor, naming it — and carries NO own template id", async () => {
    const root = await makeCustomer("ROOT");
    const mid = await makeCustomer("MID", root);
    const leaf = await makeCustomer("LEAF", mid);
    const forRoot = await publishedTemplate("Root Style");
    const forMid = await publishedTemplate("Mid Style");
    await as(() => assignTemplate(root, "TRAVELER", forRoot));
    await as(() => assignTemplate(mid, "TRAVELER", forMid));
    const trav = (await resolveAssignmentsForCustomer(leaf)).find((r) => r.docType === "TRAVELER")!;
    expect(trav.source).toBe("inherited");
    expect(trav.ownTemplateId).toBeNull();          // the leaf owns nothing — the select falls to "use default"
    expect(trav.resolvedTemplateName).toBe("Mid Style"); // the NEARER ancestor wins (matches the print walk)
    expect(trav.inheritedFromCode).toBe("MID");
    expect(trav.inheritedFromName).toBe("MID Incorporated");
  });

  it("matches resolveTemplateForPrint's own→ancestor→default order (shared walk, not reimplemented)", async () => {
    // The display resolver and the print resolver are driven by the SAME `resolveAssignment` walk,
    // so the displayed resolved template must be the one the print would actually use.
    const parent = await makeCustomer("PAR");
    const child = await makeCustomer("CHI", parent);
    const forParent = await publishedTemplate("Parent Style");
    await as(() => assignTemplate(parent, "TRAVELER", forParent));
    const display = (await resolveAssignmentsForCustomer(child)).find((r) => r.docType === "TRAVELER")!;
    const printed = await resolve("TRAVELER", child);
    expect(display.source).toBe("inherited");
    expect(display.resolvedTemplateName).toBe("Parent Style");
    expect(printed.templateId).toBe(forParent); // same template the print resolves
  });
});

describe("deleteCustomer cascades template assignments", () => {
  it("soft-deletes each live assignment, audited per row; the cascaded row no longer resolves", async () => {
    const cust = await makeCustomer("AC1");
    const t = await publishedTemplate("Skinny");
    const s = await publishedTemplate("Ticket B", "SHIPPER");
    const a1 = await as(() => assignTemplate(cust, "TRAVELER", t));
    const a2 = await as(() => assignTemplate(cust, "SHIPPER", s));
    await as(() => deleteCustomer(cust, "closed shop"));
    for (const id of [a1.id, a2.id]) {
      const row = await prisma.customerTemplateAssignment.findUniqueOrThrow({ where: { id } });
      expect(row.deletedAt).not.toBeNull();
      const del = (await readAudit("customerTemplateAssignment", id)).find((e) => e.action === "delete");
      expect(del?.reason).toBe("parent customer deleted");
    }
    // The cascaded-away assignment no longer answers a print — resolution falls to the default.
    expect((await resolve("TRAVELER", cust)).templateId).toBe(STANDARD_TRAVELER);
  });
});

// ------------------------------------------------------------------------------------------------
// Concurrency — the delete-vs-assign race (RED-verified, carried from Task 4; see the task report)
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
  it("assign-after-delete: parked on the claim, the assign wakes to the committed delete → 404, no row", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Doomed");

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((r) => { hasClaimed = r; });
    let mayRelease!: () => void;
    const release = new Promise<void>((r) => { mayRelease = r; });

    // The holder: hand-scripted deleteTemplate effect — PRECISELY the template-row FOR UPDATE
    // claim, then the soft delete, held uncommitted.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DocumentTemplate" WHERE "id" = ${tmpl} FOR UPDATE`;
      await tx.documentTemplate.update({ where: { id: tmpl }, data: { deletedAt: new Date() } });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    // The competitor: the REAL assignTemplate on its own Read Committed transaction — the claim
    // is the only thing that can serialize it against the holder.
    const competitor = as(() => assignTemplate(cust, "TRAVELER", tmpl));
    await provesBlocked(competitor);
    mayRelease();
    await holder;

    // The loser sees the winner's state: the deleted template 404s, and no assignment row —
    // live or dead — was ever written against it.
    await expect(competitor).rejects.toMatchObject({
      status: 404, message: expect.stringMatching(/Template not found/),
    });
    expect(await prisma.customerTemplateAssignment.count({ where: { templateId: tmpl } })).toBe(0);
  });

  it("delete-after-assign: parked on the claim, the delete wakes to the committed assignment → §5.14 blocked-and-named", async () => {
    const cust = await makeCustomer("AC1");
    const tmpl = await publishedTemplate("Wanted");

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((r) => { hasClaimed = r; });
    let mayRelease!: () => void;
    const release = new Promise<void>((r) => { mayRelease = r; });

    // The holder: hand-scripted assignTemplate effect — the same claim, then the assignment
    // create, held uncommitted.
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "DocumentTemplate" WHERE "id" = ${tmpl} FOR UPDATE`;
      await tx.customerTemplateAssignment.create({
        data: { customerId: cust, docType: "TRAVELER", templateId: tmpl },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    // The competitor: the REAL deleteTemplate. Without the shared claim its findBlockers would
    // read an empty set and delete a template the commit order says is assigned.
    const competitor = as(() => deleteTemplate(tmpl, "cleanup"));
    await provesBlocked(competitor);
    mayRelease();
    await holder;

    await expect(competitor).rejects.toMatchObject({
      status: 400, message: expect.stringMatching(/assigned to 1 customer.*AC1/),
    });
    const template = await prisma.documentTemplate.findUniqueOrThrow({ where: { id: tmpl } });
    expect(template.deletedAt).toBeNull(); // the winner's assignment kept the template alive
    expect(await prisma.customerTemplateAssignment.count({
      where: { templateId: tmpl, deletedAt: null },
    })).toBe(1);
  });

  it("replace-vs-clear: a row cleared mid-flight refuses the stale replace → 404, dead row untouched", async () => {
    const cust = await makeCustomer("AC1");
    const a = await publishedTemplate("Old Style");
    const b = await publishedTemplate("New Style");
    const first = await as(() => assignTemplate(cust, "TRAVELER", a));

    let hasClaimed!: () => void;
    const claimed = new Promise<void>((r) => { hasClaimed = r; });
    let mayRelease!: () => void;
    const release = new Promise<void>((r) => { mayRelease = r; });

    // The holder: hand-scripted clearAssignment effect — the ASSIGNMENT row locked and
    // soft-deleted, held uncommitted. clearAssignment takes no template claim, so no shared
    // claim serializes the replace against it — the replace UPDATE's own `deletedAt: null`
    // where is the only guard (the Task 5 review's carried fix).
    const holder = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomerTemplateAssignment" WHERE "id" = ${first.id} FOR UPDATE`;
      await tx.customerTemplateAssignment.update({
        where: { id: first.id }, data: { deletedAt: new Date() },
      });
      hasClaimed();
      await release;
    }, { timeout: 20000 });
    await claimed;

    // The competitor: the REAL assignTemplate. Its findFirst still sees the live row (the
    // holder's delete is uncommitted), so it takes the REPLACE branch — and parks its UPDATE
    // on the holder's row lock.
    const competitor = as(() => assignTemplate(cust, "TRAVELER", b));
    await provesBlocked(competitor);
    mayRelease();
    await holder;

    // The guarded update wakes to the committed clear, matches no live row, and refuses — it
    // must NOT rewrite the dead row's templateId (the audit-trail smudge the guard prevents).
    await expect(competitor).rejects.toMatchObject({
      status: 404, message: expect.stringMatching(/Template assignment not found/),
    });
    const dead = await prisma.customerTemplateAssignment.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(dead.deletedAt).not.toBeNull();
    expect(dead.templateId).toBe(a); // never rewritten
  });
});

// ------------------------------------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------------------------------------

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function getReq(url: string, cookie?: string): Request {
  return new Request(url, { headers: cookie ? { cookie } : {} });
}
function bodyReq(url: string, method: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function noBodyReq(url: string, method: string, cookie?: string): Request {
  return new Request(url, { method, headers: cookie ? { cookie } : {} });
}

describe("routes — /api/customers/[id]/template-assignments and /api/templates/names", () => {
  let owner: string;          // customers.view + edit + the edit_templates special
  let viewer: string;         // customers.view only
  let editorNoSpecial: string; // customers.edit WITHOUT action.edit_templates
  let bare: string;           // a session with NO permissions at all
  let cust: string;
  let tmpl: string;

  beforeEach(async () => {
    owner = await signInWith(
      ["customers.view", "customers.edit", "action.edit_templates"], "ta-owner");
    viewer = await signInWith(["customers.view"], "ta-viewer");
    editorNoSpecial = await signInWith(["customers.view", "customers.edit"], "ta-editor");
    bare = await signInWith([], "ta-bare");
    cust = await makeCustomer("RT1");
    tmpl = await publishedTemplate("Route Style");
  });

  it("GET lists for customers.view; 401 without a session", async () => {
    await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    const res = await listAssignmentsRoute(
      getReq(`http://t/api/customers/${cust}/template-assignments`, viewer), withParams({ id: cust }));
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ docType: "TRAVELER", templateId: tmpl, templateName: "Route Style" });
    const anon = await listAssignmentsRoute(
      getReq(`http://t/api/customers/${cust}/template-assignments`), withParams({ id: cust }));
    expect(anon.status).toBe(401);
  });

  it("GET is 403 for a session without customers.view (the Task 5 review's missing case)", async () => {
    const res = await listAssignmentsRoute(
      getReq(`http://t/api/customers/${cust}/template-assignments`, bare), withParams({ id: cust }));
    expect(res.status).toBe(403);
  });

  it("PUT assigns with customers.edit + edit_templates; 403 without either", async () => {
    const ok = await assignRoute(
      bodyReq(`http://t/api/customers/${cust}/template-assignments`, "PUT", owner,
        { docType: "TRAVELER", templateId: tmpl }),
      withParams({ id: cust }));
    expect(ok.status).toBe(200);
    expect((await assignmentRow(cust, "TRAVELER"))?.templateId).toBe(tmpl);

    for (const cookie of [viewer, editorNoSpecial]) {
      const res = await assignRoute(
        bodyReq(`http://t/api/customers/${cust}/template-assignments`, "PUT", cookie,
          { docType: "SHIPPER", templateId: tmpl }),
        withParams({ id: cust }));
      expect(res.status).toBe(403);
    }
  });

  it("PUT is .strict(): an extra key and a bad docType are both 400", async () => {
    const extra = await assignRoute(
      bodyReq(`http://t/api/customers/${cust}/template-assignments`, "PUT", owner,
        { docType: "TRAVELER", templateId: tmpl, sneaky: true }),
      withParams({ id: cust }));
    expect(extra.status).toBe(400);
    const bad = await assignRoute(
      bodyReq(`http://t/api/customers/${cust}/template-assignments`, "PUT", owner,
        { docType: "NOPE", templateId: tmpl }),
      withParams({ id: cust }));
    expect(bad.status).toBe(400);
  });

  it("DELETE clears with the same gates; docType comes from the query; 400 when absent", async () => {
    await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    const forbidden = await clearRoute(
      noBodyReq(`http://t/api/customers/${cust}/template-assignments?docType=TRAVELER`, "DELETE", editorNoSpecial),
      withParams({ id: cust }));
    expect(forbidden.status).toBe(403);
    const missing = await clearRoute(
      noBodyReq(`http://t/api/customers/${cust}/template-assignments`, "DELETE", owner),
      withParams({ id: cust }));
    expect(missing.status).toBe(400);
    const ok = await clearRoute(
      noBodyReq(`http://t/api/customers/${cust}/template-assignments?docType=TRAVELER`, "DELETE", owner),
      withParams({ id: cust }));
    expect(ok.status).toBe(200);
    expect(await assignmentRow(cust, "TRAVELER")).toBeNull();
  });

  it("GET .../template-assignments/resolved lists for customers.view; 403 without it; 401 anonymous", async () => {
    await as(() => assignTemplate(cust, "TRAVELER", tmpl));
    const res = await resolvedRoute(
      getReq(`http://t/api/customers/${cust}/template-assignments/resolved`, viewer),
      withParams({ id: cust }));
    expect(res.status).toBe(200);
    const rows = await res.json() as { docType: string; source: string; ownTemplateId: string | null }[];
    expect(rows).toHaveLength(TEMPLATE_DOC_TYPES.length); // one per docType, never blank (§5.15)
    const trav = rows.find((r) => r.docType === "TRAVELER")!;
    expect(trav).toMatchObject({ source: "own", ownTemplateId: tmpl, resolvedTemplateName: "Route Style" });

    const forbidden = await resolvedRoute(
      getReq(`http://t/api/customers/${cust}/template-assignments/resolved`, bare),
      withParams({ id: cust }));
    expect(forbidden.status).toBe(403);
    const anon = await resolvedRoute(
      getReq(`http://t/api/customers/${cust}/template-assignments/resolved`),
      withParams({ id: cust }));
    expect(anon.status).toBe(401);
  });

  it("GET /api/templates/names is 200 for a BARE session (§5.15 — no area gate), 401 anonymous", async () => {
    const res = await namesRoute(getReq("http://t/api/templates/names", bare), withParams({}));
    expect(res.status).toBe(200);
    const rows = await res.json() as Record<string, unknown>[];
    expect(rows.length).toBe(9); // 8 seeded Standards + "Route Style"
    // The projection is EXACTLY {id, name, docType, published} — no configs, no counts, nothing else.
    // `published` (Task 20 pre-step) lets the picker disable a never-published template with its
    // §5.16 tooltip instead of surfacing the assign-time 400 — still the narrowest read.
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(["docType", "id", "name", "published"]);
    for (const row of rows) expect(typeof row.published).toBe("boolean");
    const anon = await namesRoute(getReq("http://t/api/templates/names"), withParams({}));
    expect(anon.status).toBe(401);
  });

  it("GET /api/templates/names carries published=false for a never-published template", async () => {
    // A fresh template with an open draft but no published version — assign refuses it, so the
    // picker must be able to disable it before the user tries (published:false).
    const { id: unpub } = await as(() => createTemplate("TRAVELER", "Never Published"));
    const res = await namesRoute(getReq("http://t/api/templates/names", bare), withParams({}));
    const rows = await res.json() as { id: string; published: boolean }[];
    expect(rows.find((r) => r.id === unpub)?.published).toBe(false);
    expect(rows.find((r) => r.id === tmpl)?.published).toBe(true); // "Route Style" is published
  });

  it("GET /api/templates/names serves LIVE templates only", async () => {
    await as(() => deleteTemplate(tmpl, "superseded"));
    const res = await namesRoute(getReq("http://t/api/templates/names", bare), withParams({}));
    const rows = await res.json() as { id: string }[];
    expect(rows.some((r) => r.id === tmpl)).toBe(false);
    expect(rows.length).toBe(8);
  });
});
