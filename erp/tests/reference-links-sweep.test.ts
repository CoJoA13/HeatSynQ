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

/** Every `model.column -> kind` foreign key in `schemaText` that targets a reference table,
 *  keyed `"model.column"` and mapped to the target's kind. Pure — takes the schema text as a
 *  parameter rather than reading prisma/schema.prisma itself, so both the missing-registration
 *  and wrong-targetKind failure modes can be exercised against a small inline fixture without
 *  ever mutating the real schema file (see the bite-proof tests below).
 *
 *  A Prisma relation field looks like:
 *    glAccount  GlAccount? @relation(fields: [glAccountId], references: [id])
 *  Prisma also requires a relation *name* before `fields:` whenever a model holds two FKs to the
 *  same target model, e.g. `@relation("CustomerHierarchy", fields: [parentId], ...)` at
 *  prisma/schema.prisma:260, and Prisma accepts `@relation(...)`'s named arguments in ANY order
 *  (`references` before `fields`, or vice versa) — capturing the whole argument list and then
 *  pulling `fields: [...]` out of it independently, instead of anchoring on `fields:` being
 *  first, is what makes both shapes visible to the sweep.
 *
 *  One limit remains: a bare `materialId String?` scalar with NO `@relation` field has no
 *  DB-level FK at all, so it is invisible to any schema walk, this one included. Only a real
 *  Prisma relation field is caught.
 *
 *  `onDelete: Cascade` marks an owned-child relation (the row dies with its parent), not a
 *  usage reference that needs app-level delete protection — e.g. `ProcessStepFieldDef.codeId`
 *  cascades with its `ProcessStepCode` and is managed entirely by the step-code service
 *  (`setStepFields`), never by this registry. This is the same distinction the design spec
 *  draws for the 2C-3 models themselves (no `onDelete: Cascade` anywhere in that chain,
 *  specifically so cascades stay confined to true ownership). The exemption is scoped to
 *  relations TARGETING `processStepCode` or `surcharge` only — those are the two targets this
 *  sweep knows have a legitimate owned-child FK today: `SurchargeStepCode.surchargeId` (Task 6)
 *  is the replace-grid row itself, managed entirely by `setSurchargeStepCodes`, the same shape
 *  as `ProcessStepFieldDef.codeId` one target over — without the annotation, a surcharge's own
 *  step-code list would block its own deletion, a self-referential dead end. A cascade relation
 *  targeting a genuine `ReferenceKind` (`material`, `terms`, ...) is not exempted: that shape is
 *  exactly the failure mode this sweep exists to catch (a real usage FK slipping in
 *  unregistered), so it still fails as unregistered — see the bite-proof fixtures below. */
export function schemaLinks(schemaText: string): Map<string, string> {
  const kinds = new Set<string>(REFERENCE_KINDS);
  // "processStepCode" is a BlockerTarget (src/lib/reference-links.ts), not a ReferenceKind — it
  // is the one non-reference target the delete guard also covers, so an unregistered FK aimed at
  // ProcessStepCode (e.g. a future model) must still fail this sweep.
  kinds.add("processStepCode");
  // "surcharge" (Task 6) is also a BlockerTarget, not a ReferenceKind — a surcharge is a
  // maintained table with a delete guard, exactly like a step code, so an unregistered FK aimed
  // at it (customerSurcharge.surchargeId, invoiceLine.surchargeId) must fail the sweep too.
  kinds.add("surcharge");
  // "endingStatement" needs no add here since Phase 6 Task 2: it is a genuine ReferenceKind
  // (ruling 13), so REFERENCE_KINDS already carries it into `kinds` above.
  // "documentTemplate" (Phase 7 Task 3) is also a BlockerTarget, not a ReferenceKind — a
  // template is a maintained row with a guarded delete (Task 4's service; spec §4.1: deleting a
  // template with live customer assignments is refused-and-named), so an unregistered FK aimed
  // at it (customerTemplateAssignment.templateId) must fail the sweep too.
  kinds.add("documentTemplate");
  const out = new Map<string, string>();

  for (const [modelName, body] of models(schemaText)) {
    for (const m of body.matchAll(/^\s*\w+\s+(\w+)(\[\])?\??\s+@relation\(([^)]*)\)/gm)) {
      const [, targetModel, isList, args] = m;
      if (isList) continue;                                       // back-relation, holds no FK
      const fields = /fields:\s*\[([^\]]+)\]/.exec(args);          // order-independent
      if (!fields || !kinds.has(toKind(targetModel))) continue;    // no FK here, or not a reference table
      // Owned-child exemption, scoped to processStepCode, surcharge, and documentTemplate only
      // (see the doc comment above) — a cascade relation targeting any OTHER kind in `kinds` is
      // a real usage FK and must still be reported as unregistered. documentTemplate joined in
      // Phase 7: DocumentTemplateVersion.templateId is the owned-child real example (a version
      // lives and dies with its template — spec §4.1's append-only history; registering it would
      // instead make every template's own versions block its deletion, a self-referential dead
      // end, the SurchargeStepCode shape one target over).
      const ownedChildTarget = toKind(targetModel) === "processStepCode" || toKind(targetModel) === "surcharge"
        || toKind(targetModel) === "documentTemplate";
      if (ownedChildTarget && /onDelete:\s*Cascade/.test(args)) continue;
      const column = fields[1].split(",")[0].trim();
      out.set(`${toKind(modelName)}.${column}`, toKind(targetModel));
    }
  }

  return out;
}

/** Every `model.column -> kind` foreign key in `schemaText` that targets a reference kind but
 *  is absent from `registered` (the "model.column" keys already in REFERENCE_LINKS). */
export function unregisteredLinks(schemaText: string, registered: Set<string>): string[] {
  const offenders: string[] = [];
  for (const [key, kind] of schemaLinks(schemaText)) {
    if (!registered.has(key)) offenders.push(`${key} -> ${kind}`);
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
      "billingConfig.arGlAccountId -> glAccount",        // sorts before certChargeStepCodeId
      "billingConfig.certChargeStepCodeId -> processStepCode",
      "billingConfig.discountGlAccountId -> glAccount",  // between certChargeStepCodeId and freightGlAccountId
      "billingConfig.freightGlAccountId -> glAccount",
      "billingConfig.otherChargeGlAccountId -> glAccount",
      "billingConfig.salesTaxGlAccountId -> glAccount",
      "billingConfig.writeOffGlAccountId -> glAccount",  // after salesTaxGlAccountId
      "certRequirement.inspectionCodeId -> inspectionCode",
      "certRequirement.scaleId -> inspectionScale",
      "customer.termsId -> terms",
      // `surcharge` is a BlockerTarget (Task 6, kinds.add above) — this FK is now visible too.
      "customerSurcharge.surchargeId -> surcharge",
      // Phase 7: `documentTemplate` is a BlockerTarget (kinds.add above) — the assignment's
      // template FK is the one new usage reference. DocumentTemplateVersion.templateId is an
      // owned-child cascade (exempt, see schemaLinks); the other Phase 7 FKs
      // (publishedVersionId, templateVersionId, publishedById, customerId) target non-kinds.
      "customerTemplateAssignment.templateId -> documentTemplate",
      "glPosting.glAccountId -> glAccount",              // after customerSurcharge.*/customerTemplateAssignment.*, before invoiceLine.*
      "inspectionCode.defaultScaleId -> inspectionScale",
      // onDelete: SetNull, not Cascade — the exemption in schemaLinks covers cascades only, so
      // these three stay visible to the sweep, which is what forces them into REFERENCE_LINKS.
      "invoiceLine.glAccountId -> glAccount",
      "invoiceLine.processStepCodeId -> processStepCode",
      "invoiceLine.surchargeId -> surcharge",
      "orderContainer.typeId -> containerType",
      "part.materialId -> material",
      "partInspection.inspectionCodeId -> inspectionCode",
      "partInspection.scaleId -> inspectionScale",
      "partPrice.processStepCodeId -> processStepCode",
      "partProcessStep.codeId -> processStepCode",
      "partSpecification.specificationId -> specification",
      // Phase 5B: the one new A/R FK that targets a reference table. Payment's other FKs and every
      // Application FK point at non-reference models (ReceiptBatch/Customer/Invoice/Payment), so the
      // sweep never surfaces them — they are outside the delete-guard registry by design.
      "payment.paymentTypeId -> paymentType",
      "paymentType.glAccountId -> glAccount",
      "processStepCode.glAccountId -> glAccount",
      "processTemplateStep.codeId -> processStepCode",
      // Phase 6: the two quoting FKs that target guarded kinds. QuoteLine.partId and
      // OrderLine.quoteLineId exist too but target Part/QuoteLine — not reference kinds, not
      // BlockerTargets — so the sweep never surfaces them; their delete guards are the
      // hand-built blocker lists (parts.ts's order+quote guards — Task 15/Task 7 — and Task 4's
      // quote delete), outside this registry. That absence is a decision: those hand-built
      // lists ARE the enforcement, with no sweep behind them (tests/parts.test.ts and
      // tests/quotes.test.ts pin the behavior the sweep can't).
      "quote.endingStatementId -> endingStatement",
      "quotePrice.processStepCodeId -> processStepCode",
      "shipper.carrierId -> carrier",
      "surcharge.glAccountId -> glAccount",
      "surchargeStepCode.processStepCodeId -> processStepCode",
    ]);
  });

  // Local, not the shared `kinds` inside schemaLinks: a BlockerTarget, not just a ReferenceKind
  // — REFERENCE_LINKS now carries the two processStepCode entries from §7 of the design spec.
  it("every registered link targets a real reference kind", () => {
    const kinds = new Set<string>([...REFERENCE_KINDS, "processStepCode", "surcharge", "documentTemplate"]);
    expect(REFERENCE_LINKS.filter((l) => !kinds.has(l.targetKind)).map((l) => l.targetKind)).toEqual([]);
  });

  // Reverse direction of the main sweep above: a registry entry naming a model/column the
  // schema no longer has is not caught by "every schema FK is registered" (that only walks
  // schema -> registry). Left unchecked, such an entry makes findBlockers throw at runtime
  // inside deleteReference the first time anyone deletes a row of that kind.
  it("every registered link exists in the schema", () => {
    const links = schemaLinks(SCHEMA);
    const missing = REFERENCE_LINKS
      .filter((l) => !links.has(`${l.model}.${l.column}`))
      .map((l) => `${l.model}.${l.column}`);
    expect(missing, `These REFERENCE_LINKS entries name a model/column the schema does not have.
findBlockers would throw at runtime the first time anyone deletes a row of that kind. Fix or
remove the entry.`).toEqual([]);
  });

  // The gap this whole sweep exists to close (final-branch-review item 1): `registered` used to
  // be built from `model.column` alone, so `targetKind` never entered the comparison. Registering
  // a real FK against the WRONG kind — e.g. inspectionCode.defaultScaleId with
  // targetKind: "material" instead of "inspectionScale" — went undetected by every other check
  // here (the column exists, and "material" is a real reference kind), while
  // deleteReference("inspectionScale", id) would find no blockers and delete a scale that live
  // inspection codes still point at. This is the check that makes that mistake fail loudly
  // instead of shipping quietly.
  it("every registered link's targetKind matches the schema's actual relation target", () => {
    const links = schemaLinks(SCHEMA);
    const mismatches = REFERENCE_LINKS
      .filter((l) => links.get(`${l.model}.${l.column}`) !== l.targetKind)
      .map((l) => `${l.model}.${l.column} registered as -> ${l.targetKind}, ` +
        `but the schema's relation targets -> ${links.get(`${l.model}.${l.column}`)}`);
    expect(mismatches).toEqual([]);
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

  // The onDelete: Cascade exemption in schemaLinks is scoped to relations targeting
  // `processStepCode` only. A cascade relation targeting a genuine ReferenceKind is exactly the
  // failure mode the sweep exists to catch (a real usage FK slipping in unregistered) — it must
  // still be reported, cascade or not.
  it("still names an unregistered cascade FK when it targets a genuine reference kind (bite-proof fixture)", () => {
    const fixture = `
model Material {
  id   String @id
}

model Part {
  id         String    @id
  materialId String?
  material   Material? @relation(fields: [materialId], references: [id], onDelete: Cascade)
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual(["part.materialId -> material"]);
  });

  // The narrow case the exemption exists for: ProcessStepFieldDef.codeId is the real example —
  // an owned-child FK (dies with its ProcessStepCode) guarded by the step-code service, not this
  // registry (design spec §6). It must NOT be reported.
  it("does not name a cascade FK that targets ProcessStepCode (bite-proof fixture)", () => {
    const fixture = `
model ProcessStepCode {
  id   String @id
}

model ProcessStepFieldDef {
  id     String          @id
  codeId String
  code   ProcessStepCode @relation(fields: [codeId], references: [id], onDelete: Cascade)
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual([]);
  });

  // Task 6's own real example: SurchargeStepCode.surchargeId is the replace-grid row itself,
  // owned by its Surcharge and managed entirely by setSurchargeStepCodes — the same shape as
  // ProcessStepFieldDef.codeId one target over. Without the exemption this would register as a
  // usage FK, and a surcharge's own step-code list would block its own deletion.
  it("does not name a cascade FK that targets Surcharge (bite-proof fixture)", () => {
    const fixture = `
model Surcharge {
  id   String @id
}

model SurchargeStepCode {
  id          String    @id
  surchargeId String
  surcharge   Surcharge @relation(fields: [surchargeId], references: [id], onDelete: Cascade)
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual([]);
  });

  // Phase 7's own real example: DocumentTemplateVersion.templateId is an owned-child FK (a
  // version lives and dies with its template, spec §4.1) guarded by the template service, not
  // this registry — the ProcessStepFieldDef.codeId / SurchargeStepCode.surchargeId shape one
  // target over. It must NOT be reported.
  it("does not name a cascade FK that targets DocumentTemplate (bite-proof fixture)", () => {
    const fixture = `
model DocumentTemplate {
  id   String @id
}

model DocumentTemplateVersion {
  id         String           @id
  templateId String
  template   DocumentTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual([]);
  });

  // And the reverse for the same target: a non-cascade FK targeting DocumentTemplate
  // (customerTemplateAssignment.templateId in the real schema) is a genuine usage reference and
  // must still be reported — the exemption is keyed off the Cascade annotation, not the kind.
  it("still names an unregistered non-cascade foreign key targeting DocumentTemplate (bite-proof fixture)", () => {
    const fixture = `
model DocumentTemplate {
  id   String @id
}

model CustomerTemplateAssignment {
  id         String           @id
  deletedAt  DateTime?
  templateId String
  template   DocumentTemplate @relation(fields: [templateId], references: [id])
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual([
      "customerTemplateAssignment.templateId -> documentTemplate",
    ]);
  });

  // The reverse: a non-cascade FK targeting Surcharge (customerSurcharge.surchargeId,
  // invoiceLine.surchargeId in the real schema) is a genuine usage reference and must still be
  // reported — the exemption is keyed off the Cascade annotation, not the target kind alone.
  it("still names an unregistered non-cascade foreign key targeting Surcharge (bite-proof fixture)", () => {
    const fixture = `
model Surcharge {
  id   String @id
}

model CustomerSurcharge {
  id          String    @id
  surchargeId String
  surcharge   Surcharge @relation(fields: [surchargeId], references: [id])
}
`;
    expect(unregisteredLinks(fixture, new Set())).toEqual(["customerSurcharge.surchargeId -> surcharge"]);
  });
});
