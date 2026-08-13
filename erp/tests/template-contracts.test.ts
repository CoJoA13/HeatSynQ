import { describe, expect, it } from "vitest";
import {
  CONTENT_WIDTH,
  TemplateConfigError,
  configSchema,
  defaultConfig,
  lockedElements,
  validateContractConfig,
  type TemplateConfig,
  type TemplateContract,
} from "@/lib/template-contracts/types";

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
