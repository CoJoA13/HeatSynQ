/**
 * The template-contract machinery (Phase 7 spec §5.3) — the typed source of truth the editor
 * renders from, the zod config schema is generated from, and every builder consumes a validated
 * `TemplateConfig` through.
 *
 * CLIENT-SAFE BY CONTRACT: nothing under `src/lib/template-contracts/` may import from
 * `src/server/**` (the `permission-constants.ts` precedent) — the editor imports these modules
 * from client components, and a server import would drag Prisma and `node:async_hooks` into the
 * browser bundle. That is also why `CONTENT_WIDTH` below re-declares the 564pt constant the
 * builders each already carry, instead of importing one: the `src/proxy.ts` SESSION_COOKIE rule —
 * keep the literals in sync by hand.
 *
 * Two kinds of refusal, deliberately distinct:
 *  - shape problems (unknown keys, bad enums, out-of-range values) surface as `ZodError` from the
 *    generated schema — `handle()` already turns those into clean 400s;
 *  - contract-rule problems (hiding a locked element, moving a pinned section, blowing a table's
 *    width budget, duplicate entries) throw `TemplateConfigError` with a message that names the
 *    rule — spec §5.6's "the editor alone is not the enforcement".
 *
 * THE §5.3 BACKFILL is the load-bearing behavior: `validateContractConfig` parses a stored config
 * and applies the contract's defaults for every absent key — scalar knobs via zod `.default()`,
 * missing section/field entries re-inserted at their contract position — so a version stored
 * before a knob existed keeps rendering identically as contracts grow. The parse result is always
 * a COMPLETE `TemplateConfig`; no consumer ever reaches for a contract default at render time.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Fixed vocabularies. String keys for the doc types until Task 3 lands the Prisma enum.
// ---------------------------------------------------------------------------------------------

export const TEMPLATE_DOC_TYPES = [
  "TRAVELER", "SHIPPER", "MOS_SHIPPER", "BOL", "CERT", "INVOICE", "STATEMENT", "QUOTE",
] as const;
export type TemplateDocTypeString = (typeof TEMPLATE_DOC_TYPES)[number];

/** The curated bundled set (ruling 5, plan-time confirmation) — no font upload, ever. */
export const FONT_FAMILIES = ["Roboto", "Liberation Sans", "Liberation Serif", "Roboto Mono"] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];

/** The fixed date-format set (ruling 3). Every style a Phase 3–6 builder prints is here, so each
 *  DEFAULT_CONFIG can reproduce today's paper exactly: "M/D/YYYY" is the ticket header's
 *  `shortDate`, "MM/DD/YYYY" its tear-off's `paddedDate`, "MMM - DD - YYYY" the BOL's `bolDate`,
 *  and "MMMM D, YYYY" the invoice/statement `longDate`'s FULL month name ("July 29, 2026") —
 *  renamed from "MMM D, YYYY" before any config was stored (Task 2 review carry: the abbreviated
 *  token would have had Tasks 12/13 render "Jul 29" per convention and silently break golden
 *  compatibility). */
export const DATE_FORMATS = [
  "M/D/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "MMMM D, YYYY", "MMM - DD - YYYY",
] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

/** Ruling 3's fixed negative-style picker. `SIGN_AFTER_SYMBOL` is today's "$-937.44" (the 5A
 *  ruling: the sign sits between the "$" and the digits, so magnitude and sign both read at a
 *  glance); `LEADING_MINUS` is "-$937.44"; `PARENTHESES` is "($937.44)". */
export const NEGATIVE_STYLES = ["SIGN_AFTER_SYMBOL", "LEADING_MINUS", "PARENTHESES"] as const;
export type NegativeStyle = (typeof NEGATIVE_STYLES)[number];

export const PRICE_DECIMALS = [2, 3, 4] as const;
export type PriceDecimals = (typeof PRICE_DECIMALS)[number];

export const LOGO_PLACEMENTS = ["header-left", "header-center", "header-right"] as const;
export type LogoPlacement = (typeof LOGO_PLACEMENTS)[number];

/** LETTER (612pt) minus the 24pt page margins — the width budget every column total is validated
 *  against (spec §5.6, ruling 3's guardrail). Re-declared, not imported: see the header comment. */
export const CONTENT_WIDTH = 564;

// Font sizes bounded to what fits on paper: below 4pt is unreadable ink, above 72pt is a banner,
// and both would let one knob destroy a document.
const FONT_SIZE_MIN = 4;
const FONT_SIZE_MAX = 72;

// ---------------------------------------------------------------------------------------------
// The contract — pure declarations, one module per docType.
// ---------------------------------------------------------------------------------------------

export type ColumnSpec = {
  /** Which table this field is a column of — width totals are validated per table name. */
  table: string;
  /** Today's hardcoded builder width; "*" is pdfmake's flex column and counts 0 toward totals. */
  defaultWidth: number | "*";
};

export type ContractField = {
  /** Stable key — configs reference it forever; renaming one orphans stored configs. */
  key: string;
  /** Editor display name (what the panel calls the field, not what prints). */
  name: string;
  /** The printed label; "" for value-only fields. A config's `label` override replaces it. */
  defaultLabel: string;
  /** Whether a config may hide this field. `false` + `lockReason` = a §5.6 locked element. */
  removable: boolean;
  /** The rule that locks this field, quoted verbatim in the refusal (spec §5.6). */
  lockReason?: string;
  column?: ColumnSpec;
};

export type ContractSection = {
  key: string;
  name: string;
  /** Whether a config may hide the whole section. */
  hideable: boolean;
  /** `false` pins the section to its contract index — reorders around it must preserve it. */
  reorderable: boolean;
  lockReason?: string;
  fields: ContractField[];
};

export type ContractTextBlock = {
  key: string;
  name: string;
  /** Today's standing text, copied verbatim from the builder/settings literal it replaces. */
  defaultText: string;
};

/** The format-knob SURFACE: a knob present here (with its default) is on this document's config;
 *  an absent knob is an unknown key in that config and is refused — a traveler config carrying
 *  `priceDecimals` is a bug, not a no-op. */
export type ContractFormatDefaults = {
  negativeStyle?: NegativeStyle;
  priceDecimals?: PriceDecimals;
  thousandsSeparator?: boolean;
  dateFormat?: DateFormat;
};

export type ContractFontDefaults = {
  family: FontFamily;
  baseSize: number;
  headingSize: number;
  smallSize: number;
};

export type TemplateContract = {
  docType: TemplateDocTypeString;
  name: string;
  sections: ContractSection[];
  textBlocks: ContractTextBlock[];
  formats: ContractFormatDefaults;
  fonts: ContractFontDefaults;
  /** Per-table width budgets where a table does NOT get the full content width — a table printed
   *  twice side-by-side (the ticket's container fold) or beside a fixed sidebar (the BOL's
   *  freight block) declares the width its columns actually have. Absent = CONTENT_WIDTH. */
  tableBudgets?: Record<string, number>;
  /** The config's `pageFooter` default. Absent = false — no Phase 3–6 paper prints one EXCEPT
   *  the quote, whose builder already prints "Page: N of M" via its footer callback: golden
   *  compatibility means the quote's default reproduces THAT, so its contract alone sets true. */
  pageFooter?: boolean;
};

// ---------------------------------------------------------------------------------------------
// The config — the per-version JSON (spec §5.3). Logo BYTES live on the version row, never here;
// the config carries only placement + width.
// ---------------------------------------------------------------------------------------------

export type FieldConfig = {
  key: string;
  visible: boolean;
  /** Label override; null = the contract's `defaultLabel`. */
  label: string | null;
  /** Column-width override; null = the contract's `defaultWidth`. Only column fields accept one. */
  width: number | null;
};

export type SectionConfig = {
  key: string;
  visible: boolean;
  /** Array order IS display order — for sections and for fields alike. */
  fields: FieldConfig[];
};

export type FormatsConfig = {
  negativeStyle?: NegativeStyle;
  priceDecimals?: PriceDecimals;
  thousandsSeparator?: boolean;
  dateFormat?: DateFormat;
};

export type FontsConfig = {
  family: FontFamily;
  baseSize: number;
  headingSize: number;
  smallSize: number;
};

export type LogoConfig = { placement: LogoPlacement; width: number };

export type TemplateConfig = {
  sections: SectionConfig[];
  formats: FormatsConfig;
  fonts: FontsConfig;
  textBlocks: Record<string, string>;
  logo: LogoConfig | null;
  /** "Page N of M" (spec §6.1). Defaults to the contract's `pageFooter` (false everywhere but
   *  the quote, whose builder prints one today) — the backfill must keep old versions rendering
   *  identically. */
  pageFooter: boolean;
};

/** A contract-rule refusal — hiding a locked element, a blown width budget, a duplicate entry.
 *  Services translate this into their own `HttpError`; this module stays server-free. */
export class TemplateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateConfigError";
  }
}

// ---------------------------------------------------------------------------------------------
// Defaults — the canonical "today's paper" config, derived from the contract so the backfill and
// DEFAULT_CONFIG can never disagree.
// ---------------------------------------------------------------------------------------------

export function defaultFieldConfig(field: ContractField): FieldConfig {
  return { key: field.key, visible: true, label: null, width: null };
}

export function defaultSectionConfig(section: ContractSection): SectionConfig {
  return { key: section.key, visible: true, fields: section.fields.map(defaultFieldConfig) };
}

function defaultTextBlocks(contract: TemplateContract): Record<string, string> {
  return Object.fromEntries(contract.textBlocks.map((t) => [t.key, t.defaultText]));
}

export function defaultConfig(contract: TemplateContract): TemplateConfig {
  return {
    sections: contract.sections.map(defaultSectionConfig),
    formats: { ...contract.formats },
    fonts: { ...contract.fonts },
    textBlocks: defaultTextBlocks(contract),
    logo: null,
    pageFooter: contract.pageFooter ?? false,
  };
}

/**
 * The §5.6 belt's OMISSION half (Phase 7 Task 8, carried from the Task 7 review) — the merge
 * every BUILDER resolves its section views over instead of using `config.sections` raw.
 *
 * The flag-based builder belt (each builder's `sectionView`) forces visibility on locked entries,
 * but it can only force entries that are PRESENT: a validator-bypassing config that simply omits
 * the steps section entry (or a locked field entry) would drop the locked element without ever
 * tripping a flag. This helper merges the config's section/field lists with the contract's key
 * list — a leading-run merge: the config's entries lead, untouched and in config order; every
 * contract section or field missing from the config appends after them in contract order with
 * the contract's defaults (`defaultSectionConfig`/`defaultFieldConfig`), so omission cannot drop
 * anything.
 *
 * Unreachable through stored configs — `validateContractConfig`'s §5.3 backfill re-inserts
 * missing entries at their contract POSITION — but the belt's own rationale (spec §5.6: the
 * editor and validator alone are not the enforcement) applies to the builder too. Deliberately
 * APPEND, not the backfill's position splice: the belt's one job is presence — it must never
 * reorder what a config actually says, and where an omitted element lands on a config that could
 * never have been stored is unspecified. Unknown keys pass through untouched: they stay the
 * validator's refusal, and each builder's own view resolution throws on them.
 *
 * Client-safe like everything in this module; Tasks 9–14's builders adopt this same helper.
 */
export function completeSections(
  contract: TemplateContract, sections: SectionConfig[],
): SectionConfig[] {
  const merged = [...sections];
  for (const cs of contract.sections) {
    if (!merged.some((s) => s.key === cs.key)) merged.push(defaultSectionConfig(cs));
  }
  const contractByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  return merged.map((s) => {
    const cs = contractByKey.get(s.key);
    if (cs === undefined) return s; // unknown key — the validator's refusal, not the belt's
    const fields = [...s.fields];
    for (const cf of cs.fields) {
      if (!fields.some((f) => f.key === cf.key)) fields.push(defaultFieldConfig(cf));
    }
    return { ...s, fields };
  });
}

/** The namespace a locked element lives in — a section key and a field key can collide (each is
 *  only unique within its own kind), so the editor must key its padlock lookups by (scope, key),
 *  never key alone (Task 1 review carry). */
export type LockScope = "section" | "field";
export type LockedElement = { scope: LockScope; key: string; reason: string };

/** Every §5.6-locked element with its reason, NAMESPACED by scope — what the editor renders the
 *  padlock from. Sections come before their fields, contract order preserved. */
export function lockedElements(contract: TemplateContract): LockedElement[] {
  const out: LockedElement[] = [];
  for (const section of contract.sections) {
    if (section.lockReason !== undefined) {
      out.push({ scope: "section", key: section.key, reason: section.lockReason });
    }
    for (const field of section.fields) {
      if (field.lockReason !== undefined) {
        out.push({ scope: "field", key: field.key, reason: field.lockReason });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The generated zod schema — `.strict()` at every level, per-key defaults from the contract.
// ---------------------------------------------------------------------------------------------

function fieldSchema(field: ContractField) {
  return z.object({
    key: z.literal(field.key),
    visible: z.boolean().default(true),
    label: z.string().nullable().default(null),
    // Only a column field can carry a width override; on anything else the sole legal value is
    // null, so a stray number is refused by shape, not by a rule someone could forget.
    width: field.column
      ? z.number().positive().max(CONTENT_WIDTH).nullable().default(null)
      : z.null().default(null),
  }).strict();
}

/**
 * Section/field entries are dispatched by `key` to their own strict per-entry schema inside a
 * transform, rather than through `z.discriminatedUnion`: the option lists here are built at
 * runtime from contract data (a tuple-typed union fights that), and the dispatch gives exact
 * messages — the unknown KEY is named, and a matched entry's issues carry its array index.
 */
function dispatchEntries<T>(
  entries: unknown[], ctx: z.core.$RefinementCtx, kind: "section" | "field",
  schemaByKey: Map<string, z.ZodType>,
): T[] {
  const out: T[] = [];
  for (const [index, raw] of entries.entries()) {
    if (typeof raw !== "object" || raw === null || typeof (raw as { key?: unknown }).key !== "string") {
      ctx.addIssue({ code: "custom", message: `Each ${kind} entry must be an object with a string "key"`, path: [index] });
      continue;
    }
    const key = (raw as { key: string }).key;
    const schema = schemaByKey.get(key);
    if (schema === undefined) {
      ctx.addIssue({ code: "custom", message: `Unknown ${kind} key "${key}"`, path: [index] });
      continue;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ code: "custom", message: issue.message, path: [index, ...issue.path] });
      }
      continue;
    }
    out.push(parsed.data as T);
  }
  return out;
}

function sectionSchema(section: ContractSection) {
  const byKey = new Map<string, z.ZodType>(section.fields.map((f) => [f.key, fieldSchema(f)]));
  return z.object({
    key: z.literal(section.key),
    visible: z.boolean().default(true),
    fields: z.array(z.unknown())
      .transform((entries, ctx) => dispatchEntries<FieldConfig>(entries, ctx, "field", byKey))
      .default(() => section.fields.map(defaultFieldConfig)),
  }).strict();
}

/** The editor-facing schema for one contract: shape, strictness, enums, and scalar defaults.
 *  `validateContractConfig` below adds the contract rules and the entry-level backfill. */
export function configSchema(contract: TemplateContract): z.ZodType<TemplateConfig> {
  const sectionByKey = new Map<string, z.ZodType>(
    contract.sections.map((s) => [s.key, sectionSchema(s)]));

  // Only DECLARED knobs exist on the formats object — .strict() makes an undeclared knob an
  // unknown key. Each declared knob defaults to the contract's value (the §5.3 backfill).
  const formatEntries: Record<string, z.ZodType> = {};
  if (contract.formats.negativeStyle !== undefined) {
    formatEntries.negativeStyle = z.enum(NEGATIVE_STYLES).default(contract.formats.negativeStyle);
  }
  if (contract.formats.priceDecimals !== undefined) {
    formatEntries.priceDecimals = z.literal([...PRICE_DECIMALS]).default(contract.formats.priceDecimals);
  }
  if (contract.formats.thousandsSeparator !== undefined) {
    formatEntries.thousandsSeparator = z.boolean().default(contract.formats.thousandsSeparator);
  }
  if (contract.formats.dateFormat !== undefined) {
    formatEntries.dateFormat = z.enum(DATE_FORMATS).default(contract.formats.dateFormat);
  }

  const fontSize = z.number().min(FONT_SIZE_MIN).max(FONT_SIZE_MAX);

  const schema = z.object({
    sections: z.array(z.unknown())
      .transform((entries, ctx) => dispatchEntries<SectionConfig>(entries, ctx, "section", sectionByKey))
      .default(() => contract.sections.map(defaultSectionConfig)),
    formats: z.object(formatEntries).strict().default(() => ({ ...contract.formats })),
    fonts: z.object({
      family: z.enum(FONT_FAMILIES).default(contract.fonts.family),
      baseSize: fontSize.default(contract.fonts.baseSize),
      headingSize: fontSize.default(contract.fonts.headingSize),
      smallSize: fontSize.default(contract.fonts.smallSize),
    }).strict().default(() => ({ ...contract.fonts })),
    textBlocks: z.object(
      Object.fromEntries(contract.textBlocks.map((t) => [t.key, z.string().default(t.defaultText)])),
    ).strict().default(() => defaultTextBlocks(contract)),
    logo: z.object({
      placement: z.enum(LOGO_PLACEMENTS),
      width: z.number().positive().max(CONTENT_WIDTH),
    }).strict().nullable().default(null),
    pageFooter: z.boolean().default(contract.pageFooter ?? false),
  }).strict();

  // The runtime shape is exactly TemplateConfig; zod's inferred type is wider (dynamic object
  // shapes infer as records, literal keys as strings), so the narrowing lives here, once.
  return schema as unknown as z.ZodType<TemplateConfig>;
}

// ---------------------------------------------------------------------------------------------
// validateContractConfig — parse, backfill, contract rules. Always returns a COMPLETE config.
// ---------------------------------------------------------------------------------------------

function refuseDuplicates(kind: "section" | "field", keys: string[]): void {
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) throw new TemplateConfigError(`Duplicate ${kind} "${key}"`);
    seen.add(key);
  }
}

/** Missing entries are the §5.3 evolution case (the stored config predates the element), so each
 *  is re-inserted at its contract position with the contract's defaults. */
function backfillSections(contract: TemplateContract, sections: SectionConfig[]): SectionConfig[] {
  const merged = [...sections];
  contract.sections.forEach((cs, index) => {
    if (!merged.some((s) => s.key === cs.key)) {
      merged.splice(Math.min(index, merged.length), 0, defaultSectionConfig(cs));
    }
  });
  const byKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  return merged.map((s) => {
    const cs = byKey.get(s.key);
    if (cs === undefined) throw new TemplateConfigError(`Unknown section key "${s.key}"`); // unreachable after parse
    refuseDuplicates("field", s.fields.map((f) => f.key));
    const fields = [...s.fields];
    cs.fields.forEach((cf, index) => {
      if (!fields.some((f) => f.key === cf.key)) {
        fields.splice(Math.min(index, fields.length), 0, defaultFieldConfig(cf));
      }
    });
    return { ...s, fields };
  });
}

function lockMessage(name: string, verb: string, reason: string | undefined): string {
  return `"${name}" cannot be ${verb}${reason === undefined ? "" : `: ${reason}`}`;
}

function assertLocksHonored(contract: TemplateContract, sections: SectionConfig[]): void {
  const sectionByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  for (const s of sections) {
    const cs = sectionByKey.get(s.key);
    if (cs === undefined) continue; // unknown keys already refused
    if (!s.visible && !cs.hideable) {
      throw new TemplateConfigError(lockMessage(cs.name, "hidden", cs.lockReason));
    }
    // Hiding a section hides every field in it (the Task 1 review carry): a *hideable* section
    // sheltering a non-removable field is refused with the FIELD's lock reason — otherwise the
    // section knob is a lock bypass, and only contract discipline (pinning such sections
    // non-hideable) would stand between a config and a quietly-omitted locked element.
    if (!s.visible) {
      const lockedField = cs.fields.find((cf) => !cf.removable);
      if (lockedField !== undefined) {
        throw new TemplateConfigError(
          `Hiding "${cs.name}" would hide "${lockedField.name}", which cannot be hidden` +
          (lockedField.lockReason === undefined ? "" : `: ${lockedField.lockReason}`));
      }
    }
    const fieldByKey = new Map(cs.fields.map((cf) => [cf.key, cf]));
    for (const f of s.fields) {
      const cf = fieldByKey.get(f.key);
      if (cf === undefined) continue;
      if (!f.visible && !cf.removable) {
        throw new TemplateConfigError(lockMessage(cf.name, "hidden", cf.lockReason));
      }
    }
  }
  // A pinned (non-reorderable) section must sit at its contract index — reorders around it are
  // fine as long as they leave it where the contract put it.
  contract.sections.forEach((cs, contractIndex) => {
    if (cs.reorderable) return;
    const index = sections.findIndex((s) => s.key === cs.key);
    if (index !== contractIndex) {
      throw new TemplateConfigError(lockMessage(cs.name, "reordered", cs.lockReason));
    }
  });
}

/** Width totals per table, over VISIBLE columns of VISIBLE sections only — hiding a column is
 *  exactly how a template frees budget to widen another, so dormant widths must not count. */
function assertWidthBudgets(contract: TemplateContract, sections: SectionConfig[]): void {
  const sectionByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  const totals = new Map<string, number>();
  for (const s of sections) {
    if (!s.visible) continue;
    const cs = sectionByKey.get(s.key);
    if (cs === undefined) continue;
    const fieldByKey = new Map(cs.fields.map((cf) => [cf.key, cf]));
    for (const f of s.fields) {
      const cf = fieldByKey.get(f.key);
      if (cf?.column === undefined || !f.visible) continue;
      const width = f.width ?? cf.column.defaultWidth;
      if (width === "*") continue;
      totals.set(cf.column.table, (totals.get(cf.column.table) ?? 0) + width);
    }
  }
  for (const [table, total] of totals) {
    const budget = contract.tableBudgets?.[table] ?? CONTENT_WIDTH;
    if (total > budget) {
      throw new TemplateConfigError(
        `The "${table}" table's visible column widths total ${total}pt, past its ${budget}pt budget` +
        ` (LETTER content width is ${CONTENT_WIDTH}pt)`);
    }
  }
}

/**
 * Parses a stored (or incoming) config against one contract, applying the §5.3 backfill and
 * enforcing the contract rules. Throws `ZodError` for shape problems, `TemplateConfigError` for
 * rule violations; returns a complete `TemplateConfig` otherwise. The registry-facing
 * `validateConfig(docType, json)` lives in ./index.ts — the registry imports the contract
 * modules, which import this file, so the docType lookup cannot live here without a cycle.
 */
export function validateContractConfig(contract: TemplateContract, json: unknown): TemplateConfig {
  const parsed = configSchema(contract).parse(json);
  refuseDuplicates("section", parsed.sections.map((s) => s.key));
  const sections = backfillSections(contract, parsed.sections);
  assertLocksHonored(contract, sections);
  assertWidthBudgets(contract, sections);
  return { ...parsed, sections };
}
