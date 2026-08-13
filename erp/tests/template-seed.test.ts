import { describe, it, expect, beforeEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma, truncateAll, templateId } from "./helpers/db";
import { runWithContext } from "@/server/context";
import { auditedUpdate, readAudit, redact } from "@/server/audit";
import {
  TEMPLATE_DOC_TYPES,
  defaultConfigFor,
  type TemplateConfig,
  type TemplateDocTypeString,
} from "@/lib/template-contracts/index";

/**
 * Phase 7 Task 3 — the three-copies drift guard (spec §5.3/§9/§10) plus the seed smoke.
 *
 * The "Standard" template configs exist in three places: the TS `DEFAULT_CONFIG` constants (the
 * canonical copy), the seed migration's hand-written SQL literals, and `truncateAll()`'s re-seed.
 * The re-seed is BUILT from the constants, so only the SQL literal can drift — and the live DB
 * can never witness it, because every test runs after `truncateAll()` re-seeded from those same
 * constants (asserting against the DB would be a tautology; the plan's review caught exactly
 * this). So the guard parses the config literals out of the migration.sql FILE itself and
 * deep-equals them per type.
 */

const MIGRATIONS = join(process.cwd(), "prisma/migrations");
const seedDir = readdirSync(MIGRATIONS).find((d) => d.endsWith("_seed_standard_templates"));
if (seedDir === undefined) throw new Error("no _seed_standard_templates migration directory");
const SQL = readFileSync(join(MIGRATIONS, seedDir, "migration.sql"), "utf8");

// `templateId` (the migration's fixed row ids, and truncateAll's) is imported from ./helpers/db —
// one exported copy of the minting rule (Task 3 review carry), never a second hand-rolled one.

/** The dollar-quoted config literal for one docType, as its RAW text. Each literal carries its
 *  own per-type tag ($traveler_config$ …), so extraction needs no SQL grammar. */
function rawConfigLiteral(docType: TemplateDocTypeString): string {
  const tag = `$${docType.toLowerCase()}_config$`;
  const start = SQL.indexOf(tag);
  expect(start, `the seed migration has no ${tag} literal`).toBeGreaterThanOrEqual(0);
  const end = SQL.indexOf(tag, start + tag.length);
  expect(end, `${tag} literal is unterminated`).toBeGreaterThan(start);
  expect(SQL.indexOf(tag, end + tag.length), `${tag} appears more than once`).toBe(-1);
  return SQL.slice(start + tag.length, end);
}

/** The same literal, JSON-parsed. */
function configLiteral(docType: TemplateDocTypeString): TemplateConfig {
  return JSON.parse(rawConfigLiteral(docType)) as TemplateConfig;
}

/** Every $<key>_default$ COALESCE-fallback literal for one standing-text key, JSON-parsed —
 *  shipper_liability_text legitimately appears twice (SHIPPER and MOS_SHIPPER). */
function fallbackLiterals(key: string): string[] {
  const tag = `$${key}_default$`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = SQL.indexOf(tag, from);
    if (start === -1) break;
    const end = SQL.indexOf(tag, start + tag.length);
    expect(end, `${tag} literal is unterminated`).toBeGreaterThan(start);
    out.push(JSON.parse(SQL.slice(start + tag.length, end)) as string);
    from = end + tag.length;
  }
  return out;
}

function occurrences(needle: string): number {
  return SQL.split(needle).length - 1;
}

describe("the seed migration's SQL literals (drift guard — parses the file, never the DB)", () => {
  it("each docType's config literal deep-equals the TS DEFAULT_CONFIG", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      expect(configLiteral(docType), docType).toEqual(defaultConfigFor(docType));
    }
  });

  it("seeds one Standard template per docType, isDefault, with a v1 PUBLISHED version and the pointer moved onto it", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      const id = templateId(docType);
      expect(SQL).toContain(`VALUES ('${id}', '${docType}', 'Standard', true, now(), now());`);
      expect(SQL).toContain(`'${id}-v1', '${id}', 1, 'PUBLISHED',`);
      expect(SQL).toContain(
        `UPDATE "DocumentTemplate" SET "publishedVersionId" = '${id}-v1' WHERE "id" = '${id}';`);
    }
  });

  it("copies each standing-text key from its live Setting row, COALESCE-falling back to the code default", () => {
    // One subquery per config that carries the key: cert_statement on CERT; the shipper text on
    // BOTH ticket types; the two quote texts on QUOTE.
    const subquery = (key: string) => `(SELECT "value" FROM "Setting" WHERE "key" = '${key}')`;
    expect(occurrences(subquery("cert_statement"))).toBe(1);
    expect(occurrences(subquery("shipper_liability_text"))).toBe(2);
    expect(occurrences(subquery("quote_intro_text"))).toBe(1);
    expect(occurrences(subquery("quote_liability_text"))).toBe(1);

    // Every fallback equals the contract's defaultText — the canonical code default now that the
    // four standing-text Settings retired in Task 14 (they were pinned equal to the registry
    // default while it existed; the contract module is the sole copy today).
    const expectFallbacks = (key: string, docType: TemplateDocTypeString, count: number) => {
      const literals = fallbackLiterals(key);
      expect(literals, key).toHaveLength(count);
      const contractDefault = defaultConfigFor(docType).textBlocks[key];
      for (const literal of literals) {
        expect(literal, key).toBe(contractDefault);
      }
    };
    expectFallbacks("cert_statement", "CERT", 1);
    expectFallbacks("shipper_liability_text", "SHIPPER", 2);
    expectFallbacks("quote_intro_text", "QUOTE", 1);
    expectFallbacks("quote_liability_text", "QUOTE", 1);
  });

  it("pins the five jsonb_set target paths — each copy lands exactly on the key the contracts read", () => {
    // Task 3 review carry: the subquery-count test above proves the copy READS the right Setting
    // rows; this pins where each copy is WRITTEN. An applied migration is frozen, so this is
    // documentation-grade — but a typo'd path ('{textBlocks,cert_statment}') would have seeded
    // the value BESIDE the key every consumer reads, and nothing else in the suite looks at the
    // target path.
    expect(occurrences("'{textBlocks,cert_statement}'")).toBe(1);
    expect(occurrences("'{textBlocks,shipper_liability_text}'")).toBe(2);
    expect(occurrences("'{textBlocks,quote_intro_text}'")).toBe(1);
    expect(occurrences("'{textBlocks,quote_liability_text}'")).toBe(1);
    // …and those five are ALL the jsonb_set calls, so no copy targets an unpinned path.
    expect(occurrences("jsonb_set(")).toBe(5);
  });

  it("quote_liability_text's fallback is a PRESENT key holding the empty string, never an absent key", () => {
    // The owner keys the shop's wording; the builder omits the strip when blank, so "" IS
    // today's paper (Task 2). An absent key would parse fine (.strict() textBlocks would
    // backfill), which is exactly why the guard checks the literal, not the parse result.
    expect(fallbackLiterals("quote_liability_text")).toEqual([""]);
    const quote = configLiteral("QUOTE");
    expect(Object.hasOwn(quote.textBlocks, "quote_liability_text")).toBe(true);
    expect(quote.textBlocks.quote_liability_text).toBe("");
  });

  it("the quote literal alone carries pageFooter: true (its builder prints Page: N of M today)", () => {
    for (const docType of TEMPLATE_DOC_TYPES) {
      expect(configLiteral(docType).pageFooter, docType).toBe(docType === "QUOTE");
    }
  });

  it("the shipper liability literal carries the real \\n\\n paragraph break, JSON-encoded", () => {
    // In the SQL file the dollar-quoted JSON carries backslash-n (two characters); ::jsonb
    // decodes it to a real newline. Both sides pinned: the file's encoding and the parse result.
    expect(SQL).toContain("INCREASED EXPOSURE.\\n\\nNO ADDITIONAL LIABILITY");
    expect(configLiteral("SHIPPER").textBlocks.shipper_liability_text).toContain(
      "INCREASED EXPOSURE.\n\nNO ADDITIONAL LIABILITY");
  });

  it("non-ASCII survives the SQL encoding — the BOL's † and § print verbatim", () => {
    // The BOL's eleven transcribed text blocks are the seed's only non-ASCII carriers (verified
    // by sweeping every literal): the imprint/fibre daggers and the 49 U.S.C. § reference.
    const bol = configLiteral("BOL");
    expect(bol.textBlocks.bol_imprint_text).toContain("†");
    expect(bol.textBlocks.bol_fibre_note).toContain("†");
    expect(bol.textBlocks.bol_liability_note).toContain("§ 14706(c)(1)(A)");
  });

  it("the statement's en-dash aging labels stay OUT of the literal — labels are null overrides, so \"1–30\" keeps flowing from AGING_BUCKET_LABELS", () => {
    // DEFAULT_CONFIG carries label: null for every field (null = the contract's defaultLabel),
    // so no aging label — en-dash or otherwise — is baked into the SQL. That is the anti-drift
    // design: were an ASCII "1-30" ever baked in here as an override, it would silently replace
    // the constant on paper. Pin both: all-null labels, and no baked "1-30"/"1–30" anywhere.
    const statement = configLiteral("STATEMENT");
    for (const section of statement.sections) {
      for (const field of section.fields) expect(field.label, field.key).toBeNull();
    }
    // Scoped to the STATEMENT literal (Task 3 review carry, cosmetic): the risk being pinned is
    // an aging label baked into the statement's own config as an override — the other literals
    // never carried aging labels to begin with.
    const raw = rawConfigLiteral("STATEMENT");
    expect(raw).not.toContain("1-30");
    expect(raw).not.toContain("1–30");
  });
});

describe("truncateAll() re-seeds the eight Standard templates (the BillingConfig precedent)", () => {
  beforeEach(truncateAll);

  it("a raw read sees 8 live Standard templates, each isDefault with a PUBLISHED v1 built from the TS constants", async () => {
    const templates = await prisma.documentTemplate.findMany({
      where: { deletedAt: null },
      include: { publishedVersion: true },
      orderBy: { docType: "asc" },
    });
    expect(templates).toHaveLength(8);
    expect(new Set(templates.map((t) => t.docType)).size).toBe(8);
    for (const template of templates) {
      expect(template.name).toBe("Standard");
      expect(template.isDefault).toBe(true);
      expect(template.publishedVersion, template.docType).not.toBeNull();
      expect(template.publishedVersion?.versionNumber).toBe(1);
      expect(template.publishedVersion?.status).toBe("PUBLISHED");
      expect(template.publishedVersion?.publishedAt).toBeInstanceOf(Date);
      expect(template.publishedVersion?.config).toEqual(
        defaultConfigFor(template.docType as TemplateDocTypeString));
    }
  });
});

describe("audit registration (spec §4.2)", () => {
  beforeEach(truncateAll);

  it("excludes logoImage bytes from version snapshots via SNAPSHOT_SELECT, keeping the config diff", async () => {
    // The signatureImage/fileData precedent: the bytes never leave Postgres for the snapshot
    // query at all — the key is absent, not merely redacted to a placeholder.
    const seeded = await prisma.documentTemplateVersion.findFirstOrThrow({
      where: { template: { docType: "TRAVELER" } },
    });
    const version = await prisma.documentTemplateVersion.create({
      data: {
        templateId: seeded.templateId, versionNumber: 2, status: "DRAFT",
        config: seeded.config ?? {}, logoImage: Buffer.from("fakelogobytes"), logoMimeType: "image/png",
      },
    });
    await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      prisma.$transaction((tx) =>
        auditedUpdate("documentTemplateVersion", version.id, () =>
          tx.documentTemplateVersion.update({
            where: { id: version.id }, data: { status: "DISCARDED" },
          }), { tx }),
      ),
    );
    const [entry] = await readAudit("documentTemplateVersion", version.id);
    const before = entry.before as Record<string, unknown>;
    const after = entry.after as Record<string, unknown>;
    expect(before).not.toHaveProperty("logoImage");
    expect(after).not.toHaveProperty("logoImage");
    // The snapshot still carries what the audit exists for: real before→after diffs.
    expect(before.status).toBe("DRAFT");
    expect(after.status).toBe("DISCARDED");
    expect(before.config).toBeTruthy();
    expect(before.logoMimeType).toBe("image/png");
    // Belt: no raw Buffer serialization survives anywhere in the entry.
    for (const s of [JSON.stringify(entry.before), JSON.stringify(entry.after)]) {
      expect(s).not.toContain('"type":"Buffer"');
      expect(s).not.toContain("fakelogobytes");
    }
  });

  it("redact() scrubs logoImage keys — defense-in-depth behind SNAPSHOT_SELECT", () => {
    expect(redact({ logoImage: "QUJDRA==", nested: { logoImage: "x" } })).toEqual({
      logoImage: "[redacted]", nested: { logoImage: "[redacted]" },
    });
  });

  it("a template snapshot pulls live assignments with customer names, so history never reads a bare cuid", async () => {
    const template = await prisma.documentTemplate.findFirstOrThrow({
      where: { docType: "SHIPPER", deletedAt: null },
    });
    const customer = await prisma.customer.create({ data: { code: "AC1", name: "Acme" } });
    await prisma.customerTemplateAssignment.create({
      data: { customerId: customer.id, docType: "SHIPPER", templateId: template.id },
    });
    // A dead assignment must NOT surface (the partPrice live-rows precedent).
    const gone = await prisma.customer.create({ data: { code: "GONE", name: "Gone Co" } });
    await prisma.customerTemplateAssignment.create({
      data: { customerId: gone.id, docType: "SHIPPER", templateId: template.id, deletedAt: new Date() },
    });
    await runWithContext({ actor: { id: "u0", name: "Admin" }, user: null }, () =>
      prisma.$transaction((tx) =>
        auditedUpdate("documentTemplate", template.id, () =>
          tx.documentTemplate.update({ where: { id: template.id }, data: { name: "Renamed" } }),
          { tx }),
      ),
    );
    const [entry] = await readAudit("documentTemplate", template.id);
    const after = entry.after as { assignments: { customer: { code: string } }[] };
    expect(after.assignments).toHaveLength(1);
    expect(after.assignments[0].customer).toEqual({ code: "AC1", name: "Acme" });
  });
});
