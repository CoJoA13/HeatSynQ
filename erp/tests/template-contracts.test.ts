import { describe, expect, it } from "vitest";
import {
  CONTENT_WIDTH,
  NEGATIVE_STYLES,
  TemplateConfigError,
  configSchema,
  defaultConfig,
  lockedElements,
  validateContractConfig,
  type TemplateConfig,
  type TemplateContract,
  type TemplateDocTypeString,
} from "@/lib/template-contracts/types";
import {
  BOL_CONTRACT,
  BOL_DEFAULT_CONFIG,
  CERT_CONTRACT,
  CERT_DEFAULT_CONFIG,
  CONTRACTS,
  INVOICE_CONTRACT,
  INVOICE_DEFAULT_CONFIG,
  MOS_SHIPPER_CONTRACT,
  QUOTE_CONTRACT,
  QUOTE_DEFAULT_CONFIG,
  SHIPPER_CONTRACT,
  SHIPPER_DEFAULT_CONFIG,
  STATEMENT_CONTRACT,
  STATEMENT_DEFAULT_CONFIG,
  TRAVELER_CONTRACT,
  TRAVELER_DEFAULT_CONFIG,
  contractFor,
  defaultConfigFor,
  validateConfig,
} from "@/lib/template-contracts";
import { AGING_BUCKET_LABELS } from "@/lib/ar-constants";
// Type-only, erased at runtime — the frozen-columns walk pins the invoice contract's field keys
// against the builder's own input type without loading any server module into this pure test.
import type { InvoicePdfData } from "@/server/pdf/invoice";

// Pure module, no DB: the Phase 7 template-contract machinery (spec §5.3) — contract-driven zod
// config schemas, the default backfill, locked-element refusal (§5.6), and the 564pt column-width
// guardrail (ruling 3). The FIXTURE contract below exercises the machinery in isolation; the four
// real order-side contracts are tested further down against the builders' own hardcoded values.

const ALPHA_LOCK = "spec §5.6 fixture: alpha prints in a fixed place and cannot be quietly omitted";
const FIELD_LOCK = "spec §5.6 fixture: the locked field is automatic";

const FIXTURE: TemplateContract = {
  docType: "TRAVELER",
  name: "Fixture",
  sections: [
    {
      key: "alpha", name: "Alpha", hideable: false, reorderable: false, lockReason: ALPHA_LOCK,
      fields: [
        {
          key: "a_locked", name: "Locked field", defaultLabel: "Locked", removable: false,
          lockReason: FIELD_LOCK, column: { table: "t", defaultWidth: 100 },
        },
        {
          key: "a_free", name: "Free field", defaultLabel: "Free", removable: true,
          column: { table: "t", defaultWidth: "*" },
        },
      ],
    },
    {
      key: "beta", name: "Beta", hideable: true, reorderable: true,
      fields: [
        {
          key: "b_one", name: "One", defaultLabel: "One", removable: true,
          column: { table: "t", defaultWidth: 200 },
        },
        { key: "b_plain", name: "Plain", defaultLabel: "Plain", removable: true },
      ],
    },
  ],
  textBlocks: [{ key: "fixture_text", name: "Fixture text", defaultText: "The default text." }],
  formats: { thousandsSeparator: true, dateFormat: "YYYY-MM-DD" },
  fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
};

/** A deep JSON copy — "an old stored config" for the backfill tests, and the purity idiom. */
function roundTrip(config: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(config)) as TemplateConfig;
}

describe("defaultConfig", () => {
  it("produces a complete config that validates against its own contract, unchanged", () => {
    const config = defaultConfig(FIXTURE);
    expect(validateContractConfig(FIXTURE, config)).toEqual(config);
  });

  it("is plain data — survives JSON round-tripping deep-equal", () => {
    const config = defaultConfig(FIXTURE);
    expect(roundTrip(config)).toEqual(config);
  });

  it("carries every section and field in contract order, visible, with null overrides", () => {
    const config = defaultConfig(FIXTURE);
    expect(config.sections.map((s) => s.key)).toEqual(["alpha", "beta"]);
    expect(config.sections[0].fields).toEqual([
      { key: "a_locked", visible: true, label: null, width: null },
      { key: "a_free", visible: true, label: null, width: null },
    ]);
    expect(config.formats).toEqual({ thousandsSeparator: true, dateFormat: "YYYY-MM-DD" });
    expect(config.fonts).toEqual({ family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 });
    expect(config.textBlocks).toEqual({ fixture_text: "The default text." });
    expect(config.logo).toBeNull();
    expect(config.pageFooter).toBe(false);
  });
});

describe("the §5.3 default backfill", () => {
  it("fills a stripped format knob back in from the contract default", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    delete (old.formats as Record<string, unknown>).thousandsSeparator;
    expect(validateContractConfig(FIXTURE, old).formats.thousandsSeparator).toBe(true);
  });

  it("fills whole absent top-level keys (formats, fonts, textBlocks, logo, pageFooter)", () => {
    const parsed = validateContractConfig(FIXTURE, { sections: defaultConfig(FIXTURE).sections });
    expect(parsed).toEqual(defaultConfig(FIXTURE));
  });

  it("parses {} to the complete default config", () => {
    expect(validateContractConfig(FIXTURE, {})).toEqual(defaultConfig(FIXTURE));
  });

  it("re-inserts a missing section at its contract position with default visibility", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    old.sections = old.sections.filter((s) => s.key !== "beta");
    const parsed = validateContractConfig(FIXTURE, old);
    expect(parsed.sections.map((s) => s.key)).toEqual(["alpha", "beta"]);
    expect(parsed.sections[1].visible).toBe(true);
    expect(parsed.sections[1].fields.map((f) => f.key)).toEqual(["b_one", "b_plain"]);
  });

  it("re-inserts a missing field at its contract position with defaults", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    old.sections[1].fields = old.sections[1].fields.filter((f) => f.key !== "b_one");
    const parsed = validateContractConfig(FIXTURE, old);
    expect(parsed.sections[1].fields).toEqual([
      { key: "b_one", visible: true, label: null, width: null },
      { key: "b_plain", visible: true, label: null, width: null },
    ]);
  });

  it("a config stored before a synthetic knob existed picks up the new knob's default", () => {
    // The spec §5.3 evolution case: the contract GROWS a knob after configs were stored. The old
    // config must keep parsing, and the parse must return the new knob's default.
    const old = roundTrip(defaultConfig(FIXTURE));
    const extended: TemplateContract = {
      ...FIXTURE,
      formats: { ...FIXTURE.formats, negativeStyle: "PARENTHESES", priceDecimals: 3 },
    };
    const parsed = validateContractConfig(extended, old);
    expect(parsed.formats.negativeStyle).toBe("PARENTHESES");
    expect(parsed.formats.priceDecimals).toBe(3);
    expect(parsed.formats.thousandsSeparator).toBe(true);
  });

  it("a config stored before a synthetic field existed picks the field up with defaults", () => {
    const old = roundTrip(defaultConfig(FIXTURE));
    const extended: TemplateContract = {
      ...FIXTURE,
      sections: [
        FIXTURE.sections[0],
        {
          ...FIXTURE.sections[1],
          fields: [
            ...FIXTURE.sections[1].fields,
            { key: "b_new", name: "New", defaultLabel: "New", removable: true },
          ],
        },
      ],
    };
    const parsed = validateContractConfig(extended, old);
    expect(parsed.sections[1].fields.map((f) => f.key)).toEqual(["b_one", "b_plain", "b_new"]);
  });

  it("is idempotent: validating a validated config changes nothing", () => {
    const once = validateContractConfig(FIXTURE, {});
    expect(validateContractConfig(FIXTURE, roundTrip(once))).toEqual(once);
  });
});

describe("locked elements (§5.6)", () => {
  it("refuses hiding a locked section, naming the lock's reason", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].visible = false;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(ALPHA_LOCK);
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(TemplateConfigError);
  });

  it("refuses hiding a locked field, naming the lock's reason", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].fields[0].visible = false;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(FIELD_LOCK);
  });

  it("refuses reordering a non-reorderable section away from its contract position", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections.reverse();
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(ALPHA_LOCK);
  });

  it("allows hiding an unlocked section and an unlocked field", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].visible = false;
    config.sections[0].fields[1].visible = false;
    expect(validateContractConfig(FIXTURE, config).sections[1].visible).toBe(false);
  });

  it("lockedElements lists exactly the locked keys with their reasons", () => {
    expect(lockedElements(FIXTURE)).toEqual([
      { key: "alpha", reason: ALPHA_LOCK },
      { key: "a_locked", reason: FIELD_LOCK },
    ]);
  });
});

describe("section-hide counts as hiding its fields (the Task 1 review carry)", () => {
  // The latent bypass: FIXTURE's alpha section is non-hideable, so hiding it is refused for the
  // SECTION's own sake — but nothing refused hiding a *hideable* section sheltering a
  // non-removable field, which hides the locked field just as thoroughly. Task 1's contracts
  // compensated by pinning such sections non-hideable; the machinery must enforce the pairing.
  const SHELTER_LOCK = "spec §5.6 fixture: the sheltered field is automatic and cannot be hidden";
  const sheltering: TemplateContract = {
    docType: "TRAVELER",
    name: "Sheltering fixture",
    sections: [
      {
        key: "gamma", name: "Gamma", hideable: true, reorderable: true,
        fields: [
          {
            key: "g_locked", name: "Sheltered locked field", defaultLabel: "", removable: false,
            lockReason: SHELTER_LOCK,
          },
          { key: "g_free", name: "Free field", defaultLabel: "Free", removable: true },
        ],
      },
    ],
    textBlocks: [],
    formats: {},
    fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6 },
  };

  it("refuses hiding a hideable section that shelters a non-removable field, quoting the FIELD's lock", () => {
    const config = roundTrip(defaultConfig(sheltering));
    config.sections[0].visible = false;
    expect(() => validateContractConfig(sheltering, config)).toThrow(TemplateConfigError);
    expect(() => validateContractConfig(sheltering, config)).toThrow(SHELTER_LOCK);
    expect(() => validateContractConfig(sheltering, config)).toThrow(/Sheltered locked field/);
  });

  it("the same section hides fine once the contract no longer carries the locked field", () => {
    const unlocked: TemplateContract = {
      ...sheltering,
      sections: [{
        ...sheltering.sections[0],
        fields: sheltering.sections[0].fields.filter((f) => f.key !== "g_locked"),
      }],
    };
    const config = roundTrip(defaultConfig(unlocked));
    config.sections[0].visible = false;
    expect(validateContractConfig(unlocked, config).sections[0].visible).toBe(false);
  });

  it("a hidden hideable section with only removable fields still hides fine (no over-refusal)", () => {
    // FIXTURE's beta section: hideable, both fields removable — the fix must not refuse it.
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].visible = false;
    expect(validateContractConfig(FIXTURE, config).sections[1].visible).toBe(false);
  });
});

describe("column widths (ruling 3's guardrail)", () => {
  it("refuses visible column widths totalling past the 564pt content width", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].fields[1].width = 465; // 100 (a_locked default) + 465 + 200 (b_one) = 765
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(`${CONTENT_WIDTH}pt`);
  });

  it("hidden columns do not count against the budget", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].fields[0].visible = false; // b_one's 200pt leaves the table
    config.sections[0].fields[1].width = 460; // 100 + 460 = 560 <= 564
    expect(validateContractConfig(FIXTURE, config).sections[0].fields[1].width).toBe(460);
  });

  it("a hidden section's columns do not count against the budget", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].visible = false;
    config.sections[0].fields[1].width = 460;
    expect(validateContractConfig(FIXTURE, config).sections[1].visible).toBe(false);
  });

  it("honors a contract's per-table width budget override", () => {
    const budgeted: TemplateContract = { ...FIXTURE, tableBudgets: { t: 300 } };
    expect(validateContractConfig(budgeted, defaultConfig(budgeted))).toBeTruthy(); // 100 + 200 = 300
    const config = roundTrip(defaultConfig(budgeted));
    config.sections[1].fields[0].width = 201; // 100 + 201 = 301 > 300
    expect(() => validateContractConfig(budgeted, config)).toThrow("300pt");
  });

  it("refuses a width override on a field that is not a table column", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].fields[1].width = 100; // b_plain has no column membership
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });

  it("refuses a single width past the content width outright", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[1].fields[0].width = CONTENT_WIDTH + 1;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });
});

describe("strictness (§5.3's .strict() at every level)", () => {
  it("refuses an unknown top-level key", () => {
    expect(() => validateContractConfig(FIXTURE, { ...defaultConfig(FIXTURE), zzz: 1 })).toThrow();
  });

  it("refuses an unknown key inside a section entry", () => {
    const config = roundTrip(defaultConfig(FIXTURE)) as unknown as {
      sections: Record<string, unknown>[];
    };
    config.sections[1].zzz = 1;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/zzz/);
  });

  it("refuses an unknown section key and an unknown field key", () => {
    const base = defaultConfig(FIXTURE);
    expect(() => validateContractConfig(FIXTURE, {
      ...base, sections: [...base.sections, { key: "gamma", visible: true, fields: [] }],
    })).toThrow(/gamma/);
    const config = roundTrip(base);
    config.sections[1].fields.push({ key: "nope", visible: true, label: null, width: null });
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/nope/);
  });

  it("refuses a duplicate section entry and a duplicate field entry", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections.push(roundTrip(defaultConfig(FIXTURE)).sections[1]);
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/duplicate/i);
    const config2 = roundTrip(defaultConfig(FIXTURE));
    config2.sections[1].fields.push({ key: "b_one", visible: true, label: null, width: null });
    expect(() => validateContractConfig(FIXTURE, config2)).toThrow(/duplicate/i);
  });

  it("refuses an unknown font family (never falls through to a default)", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.fonts as Record<string, unknown>).family = "Comic Sans";
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });

  it("refuses a date format outside the fixed set", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.formats as Record<string, unknown>).dateFormat = "DD.MM.YYYY";
    expect(() => validateContractConfig(FIXTURE, config)).toThrow();
  });

  it("refuses a format knob the contract does not declare", () => {
    // The knob SURFACE is per-contract (spec §5.3): FIXTURE declares no price knob, so a config
    // carrying one is an unknown key, not a silently-accepted no-op.
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.formats as Record<string, unknown>).priceDecimals = 2;
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/priceDecimals/);
  });

  it("refuses an unknown text-block key", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    (config.textBlocks as Record<string, unknown>).rogue_text = "x";
    expect(() => validateContractConfig(FIXTURE, config)).toThrow(/rogue_text/);
  });

  it("refuses an unknown logo placement and an oversized logo width", () => {
    const base = defaultConfig(FIXTURE);
    expect(() => validateContractConfig(FIXTURE, {
      ...base, logo: { placement: "footer-left", width: 100 },
    })).toThrow();
    expect(() => validateContractConfig(FIXTURE, {
      ...base, logo: { placement: "header-left", width: CONTENT_WIDTH + 1 },
    })).toThrow();
  });

  it("configSchema alone refuses unknown keys too (the editor-side schema)", () => {
    expect(configSchema(FIXTURE).safeParse({ zzz: 1 }).success).toBe(false);
  });
});

describe("override round-trips", () => {
  it("label, width, format, font, text, logo and pageFooter overrides survive validate → serialize → validate", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    config.sections[0].fields[0].label = "Renamed";
    config.sections[1].fields[0].width = 150;
    config.formats.thousandsSeparator = false;
    config.formats.dateFormat = "MM/DD/YYYY";
    config.fonts = { family: "Liberation Serif", baseSize: 9, headingSize: 14, smallSize: 5 };
    config.textBlocks.fixture_text = "Overridden text.";
    config.logo = { placement: "header-right", width: 120 };
    config.pageFooter = true;

    const once = validateContractConfig(FIXTURE, config);
    const twice = validateContractConfig(FIXTURE, roundTrip(once));
    expect(twice).toEqual(once);
    expect(twice.sections[0].fields[0].label).toBe("Renamed");
    expect(twice.sections[1].fields[0].width).toBe(150);
    expect(twice.fonts.family).toBe("Liberation Serif");
    expect(twice.logo).toEqual({ placement: "header-right", width: 120 });
    expect(twice.pageFooter).toBe(true);
  });

  it("reordering reorderable sections is preserved", () => {
    const config = roundTrip(defaultConfig(FIXTURE));
    // Only beta is reorderable, and alpha is pinned to index 0 — so swap beta's FIELDS instead
    // and keep the section order; both orders must come back exactly as sent.
    config.sections[1].fields.reverse();
    const parsed = validateContractConfig(FIXTURE, config);
    expect(parsed.sections[1].fields.map((f) => f.key)).toEqual(["b_plain", "b_one"]);
  });
});

// ---------------------------------------------------------------------------------------------
// The eight real contracts — the order side (Task 1, from the Phase 3/4 builders) and the
// billing side (Task 2, from the Phase 4–6 builders). Every pinned value below is today's
// hardcoded builder value — a mismatch means the contract drifted from the paper it claims to
// describe.
// ---------------------------------------------------------------------------------------------

const REGISTERED = [
  "TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE",
] as const;

/** Every field of a contract, flattened, keyed for the sweep assertions. */
function allFields(contract: TemplateContract) {
  return contract.sections.flatMap((s) => s.fields);
}

function columnWidths(contract: TemplateContract, sectionKey: string, table: string) {
  const section = contract.sections.find((s) => s.key === sectionKey);
  return (section?.fields ?? [])
    .filter((f) => f.column?.table === table)
    .map((f) => ({ key: f.key, label: f.defaultLabel, width: f.column?.defaultWidth }));
}

describe("the contract registry", () => {
  it("registers exactly the eight contracts, under their own docTypes", () => {
    expect(Object.keys(CONTRACTS).sort()).toEqual([...REGISTERED].sort());
    for (const docType of REGISTERED) expect(CONTRACTS[docType]?.docType).toBe(docType);
  });

  it("throws a clear error for an unregistered docType — never returns undefined", () => {
    // All eight of §8's types are registered now, so the error path needs a value outside the
    // union — the posting register, spec §2's explicit ninth-document refusal, is the honest cast.
    const notADocType = "POSTING_REGISTER" as TemplateDocTypeString;
    expect(() => contractFor(notADocType)).toThrow(/POSTING_REGISTER/);
    expect(() => validateConfig(notADocType, {})).toThrow(TemplateConfigError);
    expect(() => validateConfig(notADocType, {})).toThrow(/POSTING_REGISTER/);
  });

  it("every registered contract has unique section keys, unique field keys, unique text-block keys", () => {
    for (const docType of REGISTERED) {
      const contract = contractFor(docType);
      const sectionKeys = contract.sections.map((s) => s.key);
      expect(new Set(sectionKeys).size).toBe(sectionKeys.length);
      const fieldKeys = allFields(contract).map((f) => f.key);
      expect(new Set(fieldKeys).size).toBe(fieldKeys.length);
      const textKeys = contract.textBlocks.map((t) => t.key);
      expect(new Set(textKeys).size).toBe(textKeys.length);
    }
  });

  it("every non-hideable section and non-removable field carries a lock reason", () => {
    for (const docType of REGISTERED) {
      const contract = contractFor(docType);
      for (const s of contract.sections) {
        if (!s.hideable || !s.reorderable) expect(s.lockReason, `${docType} ${s.key}`).toBeTruthy();
        for (const f of s.fields) {
          if (!f.removable) expect(f.lockReason, `${docType} ${f.key}`).toBeTruthy();
        }
      }
    }
  });

  it("each DEFAULT_CONFIG validates against its own contract, unchanged, and is plain data", () => {
    for (const docType of REGISTERED) {
      const config = defaultConfigFor(docType);
      expect(validateConfig(docType, config), docType).toEqual(config);
      expect(roundTrip(config), docType).toEqual(config);
      // The quote's builder already prints "Page: N of M" (its footer callback) — golden
      // compatibility means its default reproduces THAT; no other Phase 3–6 paper prints one.
      expect(config.pageFooter, docType).toBe(docType === "QUOTE");
      expect(config.logo, docType).toBeNull();        // no builder prints a logo today
    }
  });
});

describe("the traveler contract", () => {
  it("declares the builder's seven blocks in stack order", () => {
    expect(TRAVELER_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "lines", "quantities", "process", "inspections", "steps", "footer",
    ]);
  });

  it("locks the steps section and its typed-field rendering with the §15 Step-fields ruling", () => {
    const steps = TRAVELER_CONTRACT.sections.find((s) => s.key === "steps");
    expect(steps?.hideable).toBe(false);
    expect(steps?.reorderable).toBe(false);
    expect(steps?.lockReason).toMatch(/cannot be quietly omitted/);
    for (const key of ["step_position", "step_code", "step_instruction", "step_values"]) {
      const field = steps?.fields.find((f) => f.key === key);
      expect(field?.removable, key).toBe(false);
      expect(field?.lockReason, key).toMatch(/cannot be quietly omitted/);
    }
  });

  it("locks the barcode (and the header that carries it)", () => {
    const header = TRAVELER_CONTRACT.sections.find((s) => s.key === "header");
    expect(header?.hideable).toBe(false);
    const barcode = header?.fields.find((f) => f.key === "barcode");
    expect(barcode?.removable).toBe(false);
    expect(barcode?.lockReason).toMatch(/barcode/i);
  });

  it("refuses a config that hides the steps, hides the barcode, or moves the steps", () => {
    const hideSteps = roundTrip(TRAVELER_DEFAULT_CONFIG);
    hideSteps.sections[5].visible = false;
    expect(() => validateConfig("TRAVELER", hideSteps)).toThrow(/cannot be quietly omitted/);

    const hideBarcode = roundTrip(TRAVELER_DEFAULT_CONFIG);
    const barcode = hideBarcode.sections[0].fields.find((f) => f.key === "barcode");
    if (barcode) barcode.visible = false;
    expect(() => validateConfig("TRAVELER", hideBarcode)).toThrow(TemplateConfigError);

    const moveSteps = roundTrip(TRAVELER_DEFAULT_CONFIG);
    [moveSteps.sections[5], moveSteps.sections[6]] = [moveSteps.sections[6], moveSteps.sections[5]];
    expect(() => validateConfig("TRAVELER", moveSteps)).toThrow(/reordered/);
  });

  it("reproduces the lines table exactly: labels and [78, *, 78, 88]", () => {
    expect(columnWidths(TRAVELER_CONTRACT, "lines", "lines")).toEqual([
      { key: "line_qty", label: "Part Quantity", width: 78 },
      { key: "line_part", label: "Part Number / Part Name / Description", width: "*" },
      { key: "line_each_weight", label: "Part Weight", width: 78 },
      { key: "line_weight", label: "Line Weight", width: 88 },
    ]);
  });

  it("reproduces the quantity table exactly: labels and [78, 78, *, 88, 78, 88]", () => {
    expect(columnWidths(TRAVELER_CONTRACT, "quantities", "quantities")).toEqual([
      { key: "order_qty", label: "Order Quantity", width: 78 },
      { key: "load_qty", label: "Load Quantity", width: 78 },
      { key: "container", label: "Container", width: "*" },
      { key: "container_qty", label: "Container Quantity", width: 88 },
      { key: "tare_weight", label: "Tare Weight", width: 78 },
      { key: "gross_weight", label: "Gross Weight", width: 88 },
    ]);
  });

  it("reproduces the inspections table [*, 55, 48, 48, 72, *] and the steps table [16, 62, *, 34, 30, 46]", () => {
    expect(columnWidths(TRAVELER_CONTRACT, "inspections", "inspections").map((c) => c.width))
      .toEqual(["*", 55, 48, 48, 72, "*"]);
    expect(columnWidths(TRAVELER_CONTRACT, "steps", "steps").map((c) => c.width))
      .toEqual([16, 62, "*", 34, 30, 46]);
  });

  it("declares the Process: slot (ruling 4 binds part.processName in a later task)", () => {
    const process = TRAVELER_CONTRACT.sections.find((s) => s.key === "process");
    const slot = process?.fields.find((f) => f.key === "process");
    expect(slot?.defaultLabel).toBe("Process:");
    expect(slot?.removable).toBe(true);
  });

  it("declares today's formats and fonts: grouped thousands, Roboto 8/12/6.5, no date knob", () => {
    expect(TRAVELER_CONTRACT.formats).toEqual({ thousandsSeparator: true });
    expect(TRAVELER_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6.5,
    });
    expect(TRAVELER_CONTRACT.textBlocks).toEqual([]);
    // The traveler prints no dates, so a dateFormat knob in its config is an unknown key.
    const config = roundTrip(TRAVELER_DEFAULT_CONFIG);
    (config.formats as Record<string, unknown>).dateFormat = "M/D/YYYY";
    expect(() => validateConfig("TRAVELER", config)).toThrow(/dateFormat/);
  });

  it("refuses a lines-table width total past 564pt through the registry entry point", () => {
    const config = roundTrip(TRAVELER_DEFAULT_CONFIG);
    const linePart = config.sections[1].fields.find((f) => f.key === "line_part");
    if (linePart) linePart.width = 400; // 78 + 400 + 78 + 88 = 644 > 564
    expect(() => validateConfig("TRAVELER", config)).toThrow(/564pt/);
  });

  it("round-trips label and width overrides through validateConfig", () => {
    const config = roundTrip(TRAVELER_DEFAULT_CONFIG);
    const orderNumber = config.sections[0].fields.find((f) => f.key === "order_number");
    if (orderNumber) orderNumber.label = "Order #";
    const lineQty = config.sections[1].fields.find((f) => f.key === "line_qty");
    if (lineQty) lineQty.width = 90;
    const once = validateConfig("TRAVELER", config);
    expect(validateConfig("TRAVELER", roundTrip(once))).toEqual(once);
    expect(once.sections[0].fields.find((f) => f.key === "order_number")?.label).toBe("Order #");
    expect(once.sections[1].fields.find((f) => f.key === "line_qty")?.width).toBe(90);
  });
});

describe("the shipping-ticket contracts", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(SHIPPER_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "parties", "field_strip", "lines", "containers", "serials", "liability",
      "totals", "tear_off",
    ]);
  });

  it("MOS shipper starts structurally identical to the shipper — distinct docTypes free to diverge (spec §4.1)", () => {
    expect(MOS_SHIPPER_CONTRACT.docType).toBe("MOS_SHIPPER");
    expect(MOS_SHIPPER_CONTRACT.sections).toEqual(SHIPPER_CONTRACT.sections);
    expect(MOS_SHIPPER_CONTRACT.textBlocks).toEqual(SHIPPER_CONTRACT.textBlocks);
    expect(MOS_SHIPPER_CONTRACT.formats).toEqual(SHIPPER_CONTRACT.formats);
    expect(MOS_SHIPPER_CONTRACT.fonts).toEqual(SHIPPER_CONTRACT.fonts);
    expect(MOS_SHIPPER_CONTRACT.tableBudgets).toEqual(SHIPPER_CONTRACT.tableBudgets);
  });

  it("reproduces the field strip [*, *, 110, 70, 85] and lines [70, *, 90] exactly", () => {
    expect(columnWidths(SHIPPER_CONTRACT, "field_strip", "field_strip")).toEqual([
      { key: "po_number", label: "Purchase Order Number", width: "*" },
      { key: "packing_list_no", label: "Packing List No", width: "*" },
      { key: "customer_job_no", label: "Customer Job No", width: 110 },
      { key: "route", label: "Route", width: 70 },
      { key: "carrier", label: "Carrier", width: 85 },
    ]);
    expect(columnWidths(SHIPPER_CONTRACT, "lines", "lines")).toEqual([
      { key: "line_qty", label: "Quantity", width: 70 },
      // Double-spaced exactly as the builder prints it.
      { key: "line_part", label: "Part No.  /  Part Name  /  Part Description", width: "*" },
      { key: "line_pounds", label: "Pounds", width: 90 },
    ]);
  });

  it("gives the folded container table a half-width budget of 282pt", () => {
    expect(columnWidths(SHIPPER_CONTRACT, "containers", "containers")).toEqual([
      { key: "container_type", label: "Container Type", width: 80 },
      { key: "container_count", label: "# Of Containers", width: "*" },
      { key: "cust_cont_id", label: "Cust Cont Id", width: 62 },
    ]);
    expect(SHIPPER_CONTRACT.tableBudgets).toEqual({ containers: 282 });
    const config = roundTrip(SHIPPER_DEFAULT_CONFIG);
    const type = config.sections[4].fields.find((f) => f.key === "container_type");
    if (type) type.width = 221; // 221 + 62 = 283 > 282
    expect(() => validateConfig("SHIPPER", config)).toThrow(/282pt/);
  });

  it("carries shipper_liability_text with the settings default verbatim", () => {
    expect(SHIPPER_CONTRACT.textBlocks.map((t) => t.key)).toEqual(["shipper_liability_text"]);
    const text = SHIPPER_DEFAULT_CONFIG.textBlocks.shipper_liability_text;
    expect(text.startsWith("Above pricing is based on American Heat Treating - Alabama")).toBe(true);
    // The source sample's own "AMERICAN HEAT TREAT - ALABAMA" (missing "ING") is preserved.
    expect(text).toContain("AMERICAN HEAT TREAT - ALABAMA TERMS AND CONDITIONS");
    expect(text).toContain("\n\n"); // the two-paragraph split the builder renders on
    expect(text.endsWith("SIGNED BY A PRINCIPAL OWNER OF AMERICAN HEAT TREATING - ALABAMA.")).toBe(true);
  });

  it("declares today's formats and fonts: grouped thousands, M/D/YYYY, Roboto 8/16/5.5", () => {
    expect(SHIPPER_CONTRACT.formats).toEqual({ thousandsSeparator: true, dateFormat: "M/D/YYYY" });
    expect(SHIPPER_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 8, headingSize: 16, smallSize: 5.5,
    });
  });

  it("titles the document 'Shipping Ticket' and locks nothing (spec §5.6 locks are traveler-only)", () => {
    const header = SHIPPER_CONTRACT.sections.find((s) => s.key === "header");
    expect(header?.fields.find((f) => f.key === "title")?.defaultLabel).toBe("Shipping Ticket");
    expect(lockedElements(SHIPPER_CONTRACT)).toEqual([]);
    expect(lockedElements(MOS_SHIPPER_CONTRACT)).toEqual([]);
  });
});

describe("the bill-of-lading contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(BOL_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "carrier", "received", "consigned", "trv", "delivering_carrier", "freight",
      "bottom",
    ]);
  });

  it("carries the eleven UDSBL legal constants as text blocks, transcription quirks intact", () => {
    expect(BOL_CONTRACT.textBlocks.map((t) => t.key)).toEqual([
      "bol_received_text", "bol_property_text", "bol_certifies_text", "bol_section_7_text",
      "bol_no_delivery_text", "bol_imprint_text", "bol_water_note", "bol_value_note",
      "bol_declared_value_text", "bol_liability_note", "bol_fibre_note",
    ]);
    const texts = BOL_DEFAULT_CONFIG.textBlocks;
    expect(texts.bol_received_text.startsWith("RECEIVED, subject to individually determined")).toBe(true);
    expect(texts.bol_property_text).toContain("here under");   // the sample's own spacing, preserved
    expect(texts.bol_property_text).toContain("(I) in Official, Southern, Western");
    expect(texts.bol_imprint_text).toContain("Comerce");        // the sample's own typo, preserved
    expect(texts.bol_liability_note).toContain("49 U.S.C.");
    expect(texts.bol_fibre_note.startsWith("†The fibre boxes")).toBe(true);
    expect(texts.bol_water_note).toContain("carrier's or shipper's weight");
    expect(texts.bol_declared_value_text.endsWith("not exceeding")).toBe(true);
  });

  it("reproduces the freight table [40, *, 62, 44, 42] with its 386pt beside-the-sidebar budget", () => {
    expect(columnWidths(BOL_CONTRACT, "freight", "freight")).toEqual([
      { key: "package_count", label: "No. Packages", width: 40 },
      { key: "freight_description", label: "Kind Of Package, Description of Articles", width: "*" },
      { key: "freight_weight", label: "*Weight (Subject to Correction)", width: 62 },
      { key: "freight_class", label: "Class or Rate", width: 44 },
      { key: "check_column", label: "Check Column", width: 42 },
    ]);
    expect(BOL_CONTRACT.tableBudgets).toEqual({ freight: 386 });
    const config = roundTrip(BOL_DEFAULT_CONFIG);
    const weight = config.sections[6].fields.find((f) => f.key === "freight_weight");
    if (weight) weight.width = 261; // 40 + 261 + 44 + 42 = 387 > 386
    expect(() => validateConfig("BOL", config)).toThrow(/386pt/);
  });

  it("reproduces the form labels exactly — including the spec's own 'Car or Vehicle Initials' spelling", () => {
    const labels = Object.fromEntries(allFields(BOL_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.original_label).toBe("Original - Not Negotiable");
    expect(labels.title).toBe("STRAIGHT BILL OF LADING");
    expect(labels.pro_number).toBe("Carrier's Pro No.");
    expect(labels.bol_number).toBe("Shipper's Bill of Lading No.");
    expect(labels.consignee_ref).toBe("Consignee's Ref/PO No.");
    expect(labels.scac_code).toBe("Carrier's Code (SCAC)");
    expect(labels.carrier_name).toBe("(Name of Carrier)");
    expect(labels.trv_no).toBe("TRV NO.");
    expect(labels.vehicle_initials).toBe("Car or Vehicle Initials");
    expect(labels.collect_checkbox).toBe("CHECK BOX IF COLLECT");
  });

  it("declares today's formats and fonts: grouped thousands, MMM - DD - YYYY, Roboto 7/15/5.5", () => {
    expect(BOL_CONTRACT.formats).toEqual({
      thousandsSeparator: true, dateFormat: "MMM - DD - YYYY",
    });
    expect(BOL_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 7, headingSize: 15, smallSize: 5.5,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The billing-side contracts (Task 2), derived from the Phase 4/5A/5B/6 builders.
// ---------------------------------------------------------------------------------------------

describe("the cert contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(CERT_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "parties", "parts", "statement", "requirements", "serials", "freeform",
      "signature", "footer",
    ]);
  });

  it("internal no-print notes NEVER appear — no field, no section, no text block offers them", () => {
    // Spec §5.6: "not in the contract at all (nothing to lock — the field list never offers
    // them)". §3.21's other exclusions (min/max/pass/fail/override) are enforced by the
    // builder's INPUT TYPE (CertPdfData carries none of them); the contract must not offer a
    // slot the data layer deliberately never collects.
    const keys = [
      ...CERT_CONTRACT.sections.map((s) => s.key),
      ...allFields(CERT_CONTRACT).map((f) => f.key),
      ...CERT_CONTRACT.textBlocks.map((t) => t.key),
    ];
    const names = [
      ...CERT_CONTRACT.sections.map((s) => s.name),
      ...allFields(CERT_CONTRACT).map((f) => f.name),
    ];
    expect(keys).not.toContain("internal_notes");
    expect(keys).not.toContain("internalNotes");
    for (const text of [...keys, ...names]) {
      expect(text, text).not.toMatch(/internal/i);
    }
  });

  it("carries cert_statement as a text block, defaulting to the settings code default verbatim", () => {
    expect(CERT_CONTRACT.textBlocks.map((t) => t.key)).toEqual(["cert_statement"]);
    expect(CERT_DEFAULT_CONFIG.textBlocks.cert_statement).toBe(
      "We certify that the listed Parts / Materials were heat treated in accordance with " +
      "American Heat Treating - Alabama, LLC. Quality Assurance Manual 08/01/22 and customer " +
      "requirements as follows:",
    );
    // The statement renders as its own zero-field section (the shipper liability precedent).
    const statement = CERT_CONTRACT.sections.find((s) => s.key === "statement");
    expect(statement?.fields).toEqual([]);
    expect(statement?.hideable).toBe(true);
  });

  it("reproduces the parts table exactly: labels and [70, *, 90]", () => {
    expect(columnWidths(CERT_CONTRACT, "parts", "parts")).toEqual([
      { key: "part_qty", label: "Quantity", width: 70 },
      // Double-spaced exactly as the builder prints it.
      { key: "part_identity", label: "Part Number  /  Part Name  /  Part Description", width: "*" },
      { key: "part_pounds", label: "Pounds", width: 90 },
    ]);
  });

  it("reproduces the header and parties labels exactly", () => {
    const labels = Object.fromEntries(allFields(CERT_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.title).toBe("Certification");
    expect(labels.order_no).toBe("Order No.:");
    expect(labels.print_date).toBe("Date:");
    expect(labels.entry_date).toBe("Entry Date:");
    expect(labels.to).toBe("To:");
    expect(labels.po_number).toBe("Purchase Order No.:");
    expect(labels.packing_list_no).toBe("Packing List No.:");
    expect(labels.material).toBe("Material:");
    expect(labels.footer_phone).toBe("Phone:");
  });

  it("declares the signature block as a section with its printed pieces (Task 11 consumes)", () => {
    const signature = CERT_CONTRACT.sections.find((s) => s.key === "signature");
    expect(signature?.fields.map((f) => f.key)).toEqual([
      "signature_mark", "signer_name", "signer_title", "signer_company",
    ]);
  });

  it("declares today's formats and fonts: grouped thousands, MM/DD/YYYY, Roboto 9/19/7.5 — and no price knobs", () => {
    expect(CERT_CONTRACT.formats).toEqual({ thousandsSeparator: true, dateFormat: "MM/DD/YYYY" });
    expect(CERT_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 19, smallSize: 7.5,
    });
    // No money ever prints on a cert, so the price knobs are off its surface entirely.
    const config = roundTrip(CERT_DEFAULT_CONFIG);
    (config.formats as Record<string, unknown>).priceDecimals = 2;
    expect(() => validateConfig("CERT", config)).toThrow(/priceDecimals/);
  });

  it("locks nothing — the cert's §5.6 protection is omission, not a lock", () => {
    expect(lockedElements(CERT_CONTRACT)).toEqual([]);
  });
});

describe("the invoice contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(INVOICE_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "identity", "parties", "column_header", "order_strip", "parts", "price",
      "totals", "footer",
    ]);
  });

  // The frozen-columns walk (spec §5.3): every field key maps onto `InvoicePdfData`, the
  // builder's own input — which is built exclusively from the invoice row's FROZEN snapshot
  // columns plus the two sanctioned live identity reads (company / remitTo, spec §4.2: identity,
  // not layout). The map's VALUES are compile-time checked against the type (`satisfies`), so a
  // field claiming a source the data layer does not collect fails `tsc`; the runtime walk fails
  // on any contract key with no entry here — a new field cannot land without naming its source.
  // "(label-only)" marks the fields that print nothing but their own overridable label.
  const INVOICE_FIELD_SOURCE = {
    title: "title",
    company_name: "company",
    invoice_no: "documentNumber",
    invoice_date: "invoiceDate",
    terms: "termsName",
    remit_to: "remitTo",
    bill_to: "billTo",
    ship_to: "shipTo",
    col_qty: "(label-only)",
    col_info: "(label-only)",
    col_each_weight: "(label-only)",
    col_amount: "(label-only)",
    our_order_no: "orderNumber",
    your_po: "poNumber",
    material: "materialName",
    process: "processNames",
    parts_heading: "(label-only)",
    part_qty: "parts",
    part_identity: "parts",
    part_each_weight: "parts",
    part_total_weight: "parts",
    price_heading: "(label-only)",
    price_description: "priceRows",
    price_amount: "priceRows",
    quote_source: "priceRows",
    price_per: "priceRows",
    minimum_charge: "priceRows",
    setup_charge: "priceRows",
    subtotal: "subtotal",
    surcharge_rows: "surchargeRows",
    charge_rows: "chargeRows",
    cert_row: "certRow",
    freight_row: "freightRow",
    tax_row: "taxRow",
    total: "total",
    footer_address: "company",
    footer_contact: "(label-only)",
    footer_phone: "company",
  } as const satisfies Record<string, keyof InvoicePdfData | "(label-only)">;

  it("every field maps to a frozen InvoicePdfData source — and only to one", () => {
    const contractKeys = allFields(INVOICE_CONTRACT).map((f) => f.key).sort();
    expect(contractKeys).toEqual(Object.keys(INVOICE_FIELD_SOURCE).sort());
  });

  it("reproduces the column-header strip exactly: labels and [52, *, 66, 84]", () => {
    expect(columnWidths(INVOICE_CONTRACT, "column_header", "columns")).toEqual([
      { key: "col_qty", label: "Quantity", width: 52 },
      {
        key: "col_info",
        label: "Order Information / Part No. / Description / Pricing Information", width: "*",
      },
      { key: "col_each_weight", label: "Each weight", width: 66 },
      { key: "col_amount", label: "Total Wt / Price", width: 84 },
    ]);
  });

  it("reproduces the form labels exactly", () => {
    const labels = Object.fromEntries(allFields(INVOICE_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.invoice_no).toBe("Invoice No.:");
    expect(labels.invoice_date).toBe("Invoice Date:");
    expect(labels.terms).toBe("Terms:");
    expect(labels.remit_to).toBe("Remit To");
    expect(labels.bill_to).toBe("Billto:");   // the sample's own spelling
    expect(labels.ship_to).toBe("Shipto:");   // the sample's own spelling
    expect(labels.our_order_no).toBe("Our Order #:");
    expect(labels.your_po).toBe("Your PO #:");
    expect(labels.material).toBe("Material:");
    expect(labels.process).toBe("Process:");
    expect(labels.parts_heading).toBe("PARTS");
    expect(labels.price_heading).toBe("PRICE");
    expect(labels.quote_source).toBe("Quote");
    expect(labels.price_per).toBe("Price per");
    expect(labels.minimum_charge).toBe("Minimum Charge:");
    expect(labels.setup_charge).toBe("Setup Charge:");
    expect(labels.subtotal).toBe("Sub Total Amount:");
    expect(labels.total).toBe("Total Amount Due:");
    expect(labels.footer_contact).toBe("Contact: Accounts Receivable");
    expect(labels.title).toBe("");            // "Invoice" / "Credit" is DATA (the row's own kind)
  });

  it("declares ruling 3's negative style — today's $-937.44 (sign after symbol) as the default of a three-option picker", () => {
    // 5A's ruling: the sign sits between the "$" and the digits. Credits are covered by this
    // contract (spec §4.1) — a credit's negative amounts are what this knob formats.
    expect(NEGATIVE_STYLES).toEqual(["SIGN_AFTER_SYMBOL", "LEADING_MINUS", "PARENTHESES"]);
    expect(INVOICE_CONTRACT.formats).toEqual({
      negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
      dateFormat: "MMM D, YYYY",
    });
  });

  it("the negative-style knob is editable and an unknown style is refused", () => {
    const config = roundTrip(INVOICE_DEFAULT_CONFIG);
    config.formats.negativeStyle = "PARENTHESES";
    const once = validateConfig("INVOICE", config);
    expect(once.formats.negativeStyle).toBe("PARENTHESES");
    expect(validateConfig("INVOICE", roundTrip(once))).toEqual(once);
    (config.formats as Record<string, unknown>).negativeStyle = "RED_INK";
    expect(() => validateConfig("INVOICE", config)).toThrow();
  });

  it("declares today's fonts (Roboto 9/20/7.5), no text blocks, and no locks", () => {
    expect(INVOICE_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 7.5,
    });
    expect(INVOICE_CONTRACT.textBlocks).toEqual([]);
    expect(lockedElements(INVOICE_CONTRACT)).toEqual([]);
  });
});

describe("the statement contract", () => {
  it("declares the builder's blocks in stack order — the finance-charge line and aging strip are sections", () => {
    expect(STATEMENT_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "identity", "open_items", "aging", "finance_charge", "total",
    ]);
    const financeCharge = STATEMENT_CONTRACT.sections.find((s) => s.key === "finance_charge");
    expect(financeCharge?.hideable).toBe(true);
    expect(financeCharge?.fields.map((f) => f.key)).toEqual(["finance_charge"]);
    expect(STATEMENT_CONTRACT.sections.find((s) => s.key === "aging")?.hideable).toBe(true);
  });

  it("takes the aging labels from ar-constants — the lib constant, never a duplicated string", () => {
    const labels = Object.fromEntries(allFields(STATEMENT_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.aging_current).toBe(AGING_BUCKET_LABELS.CURRENT);
    expect(labels.aging_1_30).toBe(AGING_BUCKET_LABELS.D1_30);
    expect(labels.aging_31_60).toBe(AGING_BUCKET_LABELS.D31_60);
    expect(labels.aging_61_90).toBe(AGING_BUCKET_LABELS.D61_90);
    expect(labels.aging_90_plus).toBe(AGING_BUCKET_LABELS.D90_PLUS);
    expect(labels.aging_unapplied).toBe("Unapplied");
    expect(labels.aging_net).toBe("Net");
    // The en-dash labels ("1–30") come from the constant — pin one so a duplicated ASCII "1-30"
    // can never sneak in.
    expect(labels.aging_1_30).toBe("1–30");
  });

  it("the aging strip's seven columns are all flex-width, exactly today's Array(7).fill('*')", () => {
    const widths = columnWidths(STATEMENT_CONTRACT, "aging", "aging").map((c) => c.width);
    expect(widths).toEqual(["*", "*", "*", "*", "*", "*", "*"]);
  });

  it("the open-items columns carry no width knob — the builder's auto widths are its own (the process-row precedent)", () => {
    const openItems = STATEMENT_CONTRACT.sections.find((s) => s.key === "open_items");
    expect(openItems?.fields.map((f) => f.key)).toEqual([
      "document_no", "date", "due_date", "original", "open",
    ]);
    for (const f of openItems?.fields ?? []) expect(f.column, f.key).toBeUndefined();
  });

  it("reproduces the form labels exactly", () => {
    const labels = Object.fromEntries(allFields(STATEMENT_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.title).toBe("Statement");
    expect(labels.customer).toBe("Customer:");
    expect(labels.statement_date).toBe("Statement Date:");
    expect(labels.bill_to).toBe("Bill To");
    expect(labels.remit_to).toBe("Remit To");
    expect(labels.document_no).toBe("Document #");
    expect(labels.date).toBe("Date");
    expect(labels.due_date).toBe("Due Date");
    expect(labels.original).toBe("Original");
    expect(labels.open).toBe("Open");
    expect(labels.finance_charge).toBe("Finance Charge:");
    expect(labels.total_due).toBe("Total Due:");
  });

  it("declares today's formats and fonts — negative money prints on credit/payment rows, so the style knob is on", () => {
    expect(STATEMENT_CONTRACT.formats).toEqual({
      negativeStyle: "SIGN_AFTER_SYMBOL", priceDecimals: 2, thousandsSeparator: true,
      dateFormat: "MMM D, YYYY",
    });
    expect(STATEMENT_DEFAULT_CONFIG.formats).toEqual(STATEMENT_CONTRACT.formats);
    expect(STATEMENT_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 9,
    });
    expect(STATEMENT_CONTRACT.textBlocks).toEqual([]);
    expect(lockedElements(STATEMENT_CONTRACT)).toEqual([]);
  });
});

describe("the quote contract", () => {
  it("declares the builder's blocks in stack order", () => {
    expect(QUOTE_CONTRACT.sections.map((s) => s.key)).toEqual([
      "header", "parties", "intro", "column_header", "lines", "closing", "liability",
    ]);
  });

  it("pageFooter defaults TRUE for the quote alone — its builder already prints 'Page: N of M'", () => {
    expect(QUOTE_DEFAULT_CONFIG.pageFooter).toBe(true);
    // The §5.3 backfill must agree with DEFAULT_CONFIG by construction: an empty stored config
    // parses to pageFooter true here, false everywhere else.
    expect(validateConfig("QUOTE", {}).pageFooter).toBe(true);
    expect(validateConfig("INVOICE", {}).pageFooter).toBe(false);
    // And it stays a knob — a template may turn it off.
    const config = roundTrip(QUOTE_DEFAULT_CONFIG);
    config.pageFooter = false;
    expect(validateConfig("QUOTE", config).pageFooter).toBe(false);
  });

  it("prices default to 4 decimals (money4 — ruling Q7's accepted deviation as the default, now editable)", () => {
    expect(QUOTE_CONTRACT.formats.priceDecimals).toBe(4);
    expect(QUOTE_DEFAULT_CONFIG.formats.priceDecimals).toBe(4);
    const config = roundTrip(QUOTE_DEFAULT_CONFIG);
    config.formats.priceDecimals = 2;
    expect(validateConfig("QUOTE", config).formats.priceDecimals).toBe(2);
  });

  it("carries quote_intro_text and quote_liability_text as text blocks with the settings code defaults copied", () => {
    expect(QUOTE_CONTRACT.textBlocks.map((t) => t.key)).toEqual([
      "quote_intro_text", "quote_liability_text",
    ]);
    expect(QUOTE_DEFAULT_CONFIG.textBlocks.quote_intro_text).toBe(
      "We are pleased to provide you with the following quotation:",
    );
    // The liability block SHIPS EMPTY (the owner keys the shop's wording) — an empty default is
    // today's paper: the builder omits the strip entirely when the text is "".
    expect(QUOTE_DEFAULT_CONFIG.textBlocks.quote_liability_text).toBe("");
    // Both render through zero-field sections (the shipper liability precedent).
    expect(QUOTE_CONTRACT.sections.find((s) => s.key === "intro")?.fields).toEqual([]);
    expect(QUOTE_CONTRACT.sections.find((s) => s.key === "liability")?.fields).toEqual([]);
  });

  it("reproduces the column-header strip exactly: labels and [52, *, 66, 84]", () => {
    expect(columnWidths(QUOTE_CONTRACT, "column_header", "columns")).toEqual([
      { key: "col_qty", label: "Quantity", width: 52 },
      { key: "col_info", label: "Part No. / Description / Pricing Information", width: "*" },
      { key: "col_each_weight", label: "Each weight", width: 66 },
      { key: "col_amount", label: "Total Lbs / Price", width: 84 },
    ]);
  });

  it("reproduces the form labels exactly — including the quote's own lowercase charge labels", () => {
    const labels = Object.fromEntries(allFields(QUOTE_CONTRACT).map((f) => [f.key, f.defaultLabel]));
    expect(labels.title).toBe("Quotation");
    expect(labels.quote_number).toBe("Quotation Number:");
    expect(labels.attn).toBe("Attn:");
    expect(labels.company_phone).toBe("Phone:");
    expect(labels.effective).toBe("Effective:");
    expect(labels.expires).toBe("Expires On:");
    expect(labels.terms).toBe("Terms:");
    expect(labels.rfq_number).toBe("Your R.F.Q. Number:");
    expect(labels.customer_phone).toBe("Your Phone No.:");
    expect(labels.material).toBe("Material:");
    expect(labels.price_heading).toBe("PRICE");
    // The invoice prints "Setup Charge:" / "Minimum Charge:"; the quote's builder prints these
    // lowercase — preserved exactly, per document.
    expect(labels.setup_charge).toBe("Setup charge:");
    expect(labels.minimum_charge).toBe("Minimum charge:");
    expect(labels.price_per).toBe("Price per");
    expect(labels.breaks).toBe("or more:");
  });

  it("declares today's formats and fonts — no negative money ever prints, so no negativeStyle knob", () => {
    expect(QUOTE_CONTRACT.formats).toEqual({
      priceDecimals: 4, thousandsSeparator: true, dateFormat: "MM/DD/YYYY",
    });
    const config = roundTrip(QUOTE_DEFAULT_CONFIG);
    (config.formats as Record<string, unknown>).negativeStyle = "PARENTHESES";
    expect(() => validateConfig("QUOTE", config)).toThrow(/negativeStyle/);
    expect(QUOTE_CONTRACT.fonts).toEqual({
      family: "Roboto", baseSize: 9, headingSize: 20, smallSize: 6.5,
    });
    expect(lockedElements(QUOTE_CONTRACT)).toEqual([]);
  });
});
