import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REFERENCE_LINKS } from "@/lib/reference-links";
import { REFERENCE_KINDS } from "@/lib/reference-constants";

const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

/** Every `model X { … }` block, as [name, body]. */
function models(schemaText: string): [string, string][] {
  return [...schemaText.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]);
}

/** `GlAccount` → `glAccount`. Prisma model names are PascalCase; reference kinds are the
 *  same word camelCased, which is what makes this mapping safe rather than a guess. */
function toKind(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

/** Every `model.column -> kind` foreign key in `schemaText` that targets a reference kind but
 *  is absent from `registered` (the "model.column" keys already in REFERENCE_LINKS). Pure —
 *  takes the schema text as a parameter rather than reading prisma/schema.prisma itself, so the
 *  guard's failure mode can be exercised against a small inline fixture without ever mutating
 *  the real schema file (see the bite-proof test below). */
export function unregisteredLinks(schemaText: string, registered: Set<string>): string[] {
  const kinds = new Set<string>(REFERENCE_KINDS);
  const offenders: string[] = [];

  for (const [modelName, body] of models(schemaText)) {
    // A Prisma relation field looks like:
    //   glAccount  GlAccount? @relation(fields: [glAccountId], references: [id])
    // Prisma also requires a relation *name* before `fields:` whenever a model holds two FKs
    // to the same target model, e.g. `@relation("CustomerHierarchy", fields: [parentId], ...)`
    // at prisma/schema.prisma:260 — the optional `(?:"[^"]*"\s*,\s*)?` group accounts for that
    // so such an FK isn't invisible to the sweep the day it targets a reference table.
    // Capture the target model and the FK column it names.
    for (const m of body.matchAll(/^\s*\w+\s+(\w+)\??\s+@relation\((?:"[^"]*"\s*,\s*)?fields:\s*\[(\w+)\]/gm)) {
      const [, targetModel, column] = m;
      if (!kinds.has(toKind(targetModel))) continue;   // not a reference table
      const key = `${toKind(modelName)}.${column}`;
      if (!registered.has(key)) offenders.push(`${key} -> ${toKind(targetModel)}`);
    }
  }

  return offenders;
}

describe("reference links sweep", () => {
  // The registry is what gives a foreign key its delete protection and its name resolution.
  // A new FK that nobody registers gets neither — silently. Phase 2C-2 adds four of them to
  // Part, which is exactly when this needs to bite.
  it("every schema foreign key pointing at a reference table is registered", () => {
    const registered = new Set(REFERENCE_LINKS.map((l) => `${l.model}.${l.column}`));
    const offenders = unregisteredLinks(SCHEMA, registered);

    expect(offenders, `These foreign keys point at a reference table but are missing from
REFERENCE_LINKS in src/lib/reference-links.ts. Unregistered means no delete protection and no
name resolution — both fail silently. Add an entry per offender.`).toEqual([]);
  });

  // Guards the sweep against passing vacuously: if the model-block regex ever stops matching,
  // there's nothing left to scan and this would go green while checking nothing.
  it("the sweep actually parses the schema", () => {
    expect(models(SCHEMA).length).toBeGreaterThan(15);
    expect(REFERENCE_LINKS.length).toBeGreaterThanOrEqual(4);
  });

  // Exercises the relation regex itself against the real schema, not just the model-block regex
  // above: with an empty registry, every FK the schema actually holds against a reference table
  // must be reported. If the relation matching ever breaks (e.g. a schema reformat changes how
  // a `@relation(...)` line is written), this drops toward [] and fails here — instead of
  // letting the main sweep above pass while silently checking nothing.
  it("finds every known reference FK when nothing is registered", () => {
    expect(unregisteredLinks(SCHEMA, new Set()).sort()).toEqual([
      "customer.termsId -> terms",
      "inspectionCode.defaultScaleId -> inspectionScale",
      "paymentType.glAccountId -> glAccount",
      "processStepCode.glAccountId -> glAccount",
    ]);
  });

  it("every registered link targets a real reference kind", () => {
    const kinds = new Set<string>(REFERENCE_KINDS);
    expect(REFERENCE_LINKS.filter((l) => !kinds.has(l.targetKind)).map((l) => l.targetKind)).toEqual([]);
  });

  // Proves the sweep actually bites — permanently, in CI, on every run — without ever touching
  // prisma/schema.prisma. Mutating the real schema and reverting it by hand would prove this
  // exactly once; this fixture proves it every time the suite runs.
  it("names an unregistered foreign key pointing at a reference table (bite-proof fixture)", () => {
    const fixture = `
model Carrier {
  id   String @id
}

model Customer {
  id        String   @id
  carrierId String?
  carrier   Carrier? @relation(fields: [carrierId], references: [id])
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual(["customer.carrierId -> carrier"]);
  });

  // Prisma requires a relation *name* whenever a model holds two FKs to the same target model
  // (Customer.parentId at prisma/schema.prisma:260 is the real example). The first time a model
  // needs two references to the *same reference table*, its FK is declared exactly this way —
  // this proves that shape is not invisible to the sweep.
  it("names an unregistered foreign key declared with a named relation (bite-proof fixture)", () => {
    const fixture = `
model Material {
  id   String @id
}

model Part {
  id                String    @id
  deletedAt         DateTime?
  primaryMaterialId String?
  primaryMaterial   Material? @relation("PrimaryMaterial", fields: [primaryMaterialId], references: [id])
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual(["part.primaryMaterialId -> material"]);
  });
});
