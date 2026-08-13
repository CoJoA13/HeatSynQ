/**
 * The template editor's PURE config-editing logic (Phase 7 Task 17) — every mutation the panels
 * make to a draft's `TemplateConfig`, plus the live width-budget check the editor surfaces before
 * the server's own `validateConfig` backstop refuses an over-budget config.
 *
 * CLIENT-SAFE BY CONTRACT: this file imports only from `./template-contracts/types` and
 * `./reorder`, never from `src/server/**` — the editor is a client component and a server import
 * would drag Prisma / `node:async_hooks` into the browser bundle (the `permission-ui.ts`
 * precedent). It is also the node-testable half of the editor: the vitest harness has no DOM, so
 * the config mutations live HERE as pure functions unit-tested directly, and the panels are thin
 * wrappers proven in E2E.
 *
 * Every function returns a NEW `TemplateConfig` and never mutates its input (React state
 * discipline). The lock/budget RULES are enforced authoritatively by the contract machinery's
 * `validateContractConfig` (spec §5.6 — "the editor alone is not the enforcement"); the helpers
 * here keep the editor from PRODUCING a refused config (disabled controls) and show the width
 * error EARLY, but a config built by hand and sent to the server is still refused there.
 */
import {
  CONTENT_WIDTH,
  lockedElements,
  type ContractField,
  type ContractSection,
  type FieldConfig,
  type FontsConfig,
  type FormatsConfig,
  type LockScope,
  type LogoPlacement,
  type SectionConfig,
  type TemplateConfig,
  type TemplateContract,
} from "./template-contracts/types";
import { swapAt } from "./reorder";

/** A logo default width in points — a header mark, well within the content width. Used when the
 *  user first picks a placement (bytes are uploaded separately, via the logo route). */
export const DEFAULT_LOGO_WIDTH = 120;

// ---------------------------------------------------------------------------------------------
// Locked-element lookup — what the panels render padlocks from
// ---------------------------------------------------------------------------------------------

/** The namespaced key a `lockIndex` entry lives under — a section and a field can share a key
 *  (each is only unique within its own kind), so the map is keyed by scope, never key alone. */
export function lockKey(scope: LockScope, key: string): string {
  return `${scope}:${key}`;
}

/**
 * The `(scope, key) -> lock reason` map the editor keys its padlocks off of, built from the
 * contract's own `lockedElements` (spec §5.6) — so the reason the padlock shows and the reason the
 * server quotes when it refuses a hiding/reorder are the SAME string, one source. Keyed by scope
 * (`lockKey`) because a locked section and a free field may share a key: a bare-key map would
 * render one an ambiguous padlock (the Task 1 review carry the namespace tightening closed). A
 * missing entry means "not locked" — the control is free (subject only to the edit permission).
 */
export function lockIndex(contract: TemplateContract): Map<string, string> {
  const index = new Map<string, string>();
  for (const el of lockedElements(contract)) index.set(lockKey(el.scope, el.key), el.reason);
  return index;
}

// ---------------------------------------------------------------------------------------------
// Immutable update primitives
// ---------------------------------------------------------------------------------------------

function updateSection(
  config: TemplateConfig, sectionKey: string, fn: (s: SectionConfig) => SectionConfig,
): TemplateConfig {
  return { ...config, sections: config.sections.map((s) => (s.key === sectionKey ? fn(s) : s)) };
}

function updateField(
  config: TemplateConfig, sectionKey: string, fieldKey: string, fn: (f: FieldConfig) => FieldConfig,
): TemplateConfig {
  return updateSection(config, sectionKey, (s) => ({
    ...s, fields: s.fields.map((f) => (f.key === fieldKey ? fn(f) : f)),
  }));
}

// ---------------------------------------------------------------------------------------------
// Sections and fields — show/hide, reorder, relabel, widths
// ---------------------------------------------------------------------------------------------

/** Flip a section's visibility. (The UI disables this control for a non-hideable section — the
 *  lock's authority is `assertLocksHonored`; this primitive just flips the bit.) */
export function toggleSectionVisible(config: TemplateConfig, sectionKey: string): TemplateConfig {
  return updateSection(config, sectionKey, (s) => ({ ...s, visible: !s.visible }));
}

/** Flip a field's visibility within its section. (Disabled in the UI for a non-removable field.) */
export function toggleFieldVisible(
  config: TemplateConfig, sectionKey: string, fieldKey: string,
): TemplateConfig {
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, visible: !f.visible }));
}

/** Set a field's label override. An empty string clears it back to the contract's `defaultLabel`
 *  (stored as null — the config's "use the default" sentinel). */
export function setFieldLabel(
  config: TemplateConfig, sectionKey: string, fieldKey: string, raw: string,
): TemplateConfig {
  const label = raw === "" ? null : raw;
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, label }));
}

/** Set a field's column-width override; null clears it back to the contract's `defaultWidth`.
 *  Only column fields carry a width (the contract schema refuses one elsewhere). */
export function setFieldWidth(
  config: TemplateConfig, sectionKey: string, fieldKey: string, width: number | null,
): TemplateConfig {
  return updateField(config, sectionKey, fieldKey, (f) => ({ ...f, width }));
}

function contractSection(contract: TemplateContract, key: string): ContractSection | undefined {
  return contract.sections.find((cs) => cs.key === key);
}

/**
 * Whether `moveSection` would do anything — the exact predicate an up/down control disables on.
 * A section moves only among REORDERABLE positions: a non-reorderable (pinned) section never
 * moves, and a move never displaces a pinned neighbour. Together these keep every pinned section
 * at its contract index (the invariant `assertLocksHonored` enforces): single-step swaps between
 * reorderable neighbours can never carry a section across a pinned anchor, because the pinned
 * anchor would be the neighbour and blocks the swap.
 */
export function canMoveSection(
  config: TemplateConfig, contract: TemplateContract, sectionKey: string, dir: -1 | 1,
): boolean {
  const index = config.sections.findIndex((s) => s.key === sectionKey);
  if (index < 0) return false;
  const cs = contractSection(contract, sectionKey);
  if (cs === undefined || !cs.reorderable) return false; // a pinned section cannot move
  const target = index + dir;
  if (target < 0 || target >= config.sections.length) return false;
  const neighbour = contractSection(contract, config.sections[target].key);
  if (neighbour !== undefined && !neighbour.reorderable) return false; // cannot displace a pin
  return true;
}

/** Move a section up (-1) or down (+1), or return the config unchanged when the move is blocked
 *  (a boundary, a pinned section, or a pinned neighbour — see `canMoveSection`). */
export function moveSection(
  config: TemplateConfig, contract: TemplateContract, sectionKey: string, dir: -1 | 1,
): TemplateConfig {
  if (!canMoveSection(config, contract, sectionKey, dir)) return config;
  const index = config.sections.findIndex((s) => s.key === sectionKey);
  const swapped = swapAt(config.sections, index, dir);
  return swapped === null ? config : { ...config, sections: swapped };
}

/** Whether `moveField` would do anything (a within-section bounds check). Fields carry no reorder
 *  lock — the validator does not constrain field order — so only the list bounds matter. */
export function canMoveField(
  config: TemplateConfig, sectionKey: string, fieldKey: string, dir: -1 | 1,
): boolean {
  const section = config.sections.find((s) => s.key === sectionKey);
  if (section === undefined) return false;
  const index = section.fields.findIndex((f) => f.key === fieldKey);
  if (index < 0) return false;
  const target = index + dir;
  return target >= 0 && target < section.fields.length;
}

/** Move a field up (-1) or down (+1) within its section, or return the config unchanged at a
 *  boundary. */
export function moveField(
  config: TemplateConfig, sectionKey: string, fieldKey: string, dir: -1 | 1,
): TemplateConfig {
  return updateSection(config, sectionKey, (s) => {
    const index = s.fields.findIndex((f) => f.key === fieldKey);
    const swapped = index < 0 ? null : swapAt(s.fields, index, dir);
    return swapped === null ? s : { ...s, fields: swapped };
  });
}

// ---------------------------------------------------------------------------------------------
// Format knobs, fonts, text blocks, page footer
// ---------------------------------------------------------------------------------------------

/** Set one format knob (the picker only offers knobs the contract declares). */
export function setFormat<K extends keyof FormatsConfig>(
  config: TemplateConfig, key: K, value: FormatsConfig[K],
): TemplateConfig {
  return { ...config, formats: { ...config.formats, [key]: value } };
}

/** Patch the font config (family and/or the three sizes). */
export function setFonts(config: TemplateConfig, patch: Partial<FontsConfig>): TemplateConfig {
  return { ...config, fonts: { ...config.fonts, ...patch } };
}

/** Set a text block's body (the textarea's content). */
export function setTextBlock(config: TemplateConfig, key: string, value: string): TemplateConfig {
  return { ...config, textBlocks: { ...config.textBlocks, [key]: value } };
}

/** Toggle the "Page N of M" footer. */
export function setPageFooter(config: TemplateConfig, value: boolean): TemplateConfig {
  return { ...config, pageFooter: value };
}

// ---------------------------------------------------------------------------------------------
// Logo placement + width (the BYTES are uploaded separately, via the logo route)
// ---------------------------------------------------------------------------------------------

/** Choose (or change) the header slot the logo prints in. Picking a placement creates the logo
 *  block if there wasn't one, preserving any width already set; DEFAULT_LOGO_WIDTH otherwise. */
export function setLogoPlacement(config: TemplateConfig, placement: LogoPlacement): TemplateConfig {
  return { ...config, logo: { placement, width: config.logo?.width ?? DEFAULT_LOGO_WIDTH } };
}

/** Set the logo's printed width (points). A no-op when no placement is chosen (nothing to size). */
export function setLogoWidth(config: TemplateConfig, width: number): TemplateConfig {
  if (config.logo === null) return config;
  return { ...config, logo: { ...config.logo, width } };
}

/** Remove the logo block — the logo stops printing even if bytes remain on the version (both a
 *  placement AND bytes are required to render, so clearing either is enough). */
export function clearLogoPlacement(config: TemplateConfig): TemplateConfig {
  return { ...config, logo: null };
}

// ---------------------------------------------------------------------------------------------
// Live width-budget check — the client's early surface of the server's own guardrail
// ---------------------------------------------------------------------------------------------

export type TableBudget = { table: string; total: number; budget: number; over: boolean };

/**
 * Per-table visible-column-width totals against each table's budget — a data-returning mirror of
 * the contract machinery's `assertWidthBudgets` (which throws). The editor renders the over-budget
 * tables inline so a template author sees the 564pt guardrail (ruling 3) as they drag, BEFORE the
 * `PATCH` reaches `validateConfig` and is refused. Only VISIBLE columns of VISIBLE sections count
 * — hiding a column is exactly how a template frees budget to widen another, so the two must agree.
 */
export function tableBudgets(contract: TemplateContract, config: TemplateConfig): TableBudget[] {
  const sectionByKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  const totals = new Map<string, number>();
  for (const s of config.sections) {
    if (!s.visible) continue;
    const cs = sectionByKey.get(s.key);
    if (cs === undefined) continue;
    const fieldByKey = new Map<string, ContractField>(cs.fields.map((cf) => [cf.key, cf]));
    for (const f of s.fields) {
      const cf = fieldByKey.get(f.key);
      if (cf?.column === undefined || !f.visible) continue;
      const width = f.width ?? cf.column.defaultWidth;
      if (width === "*") continue;
      totals.set(cf.column.table, (totals.get(cf.column.table) ?? 0) + width);
    }
  }
  return [...totals.entries()].map(([table, total]) => {
    const budget = contract.tableBudgets?.[table] ?? CONTENT_WIDTH;
    return { table, total, budget, over: total > budget };
  });
}
