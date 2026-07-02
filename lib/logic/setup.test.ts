import { describe, it, expect } from "vitest";
import { SETUP_CARDS } from "./setup";

describe("SETUP_CARDS canon", () => {
  it("pins the 6 prototype cards verbatim, in order", () => {
    expect(SETUP_CARDS.map((c) => [c.title, c.desc])).toEqual([
      ["Operators & Security", "Operator IDs, roles, module permissions and signatures."],
      ["Plant Setup", "Company info that prints on travelers, certs and invoices."],
      ["Process Masters", "Recipes: standard steps, table keys and equipment."],
      ["Equipment & Areas", "Furnaces, ovens, areas and tracking templates."],
      ["Pricing & Price Keys", "Step pricing, customer overrides and dimensional pricing."],
      ["Certifications & Forms", "Cert formats, defaults and form / message inserts."],
    ]);
  });

  it("pins card targets: 5 links + inert Plant Setup", () => {
    expect(SETUP_CARDS.map((c) => [c.key, c.href])).toEqual([
      ["operators", "/setup/operators"],
      ["plant", null],
      ["process-masters", "/process-masters"],
      ["equipment", "/shop-floor"],
      ["pricing", "/setup/pricing"],
      ["cert-defaults", "/setup/cert-defaults"],
    ]);
  });

  it("keys are unique", () => {
    const keys = SETUP_CARDS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
