// Pure, client-safe: no src/server/** imports — importing src/server/settings.ts's zod schema
// registry would drag Prisma and node:async_hooks into the browser bundle (CLAUDE.md
// "Constraints that will bite you"). This mirrors just enough of that registry's per-key shape
// for the admin settings page (src/app/admin/settings/page.tsx) to pick the right form control
// and submit the right JavaScript type.
//
// This exists because the page, as shipped, rendered every setting as a single-line string
// `<input>` and submitted every value as `String(value)` — Task 1's own review of adding the
// first boolean setting (cert_required_default) and first enum setting (cert_scope_default)
// found that this made both keys unusable from the UI: setSetting's zod schema
// (src/server/settings.ts) already accepts a real boolean/enum, but the page could only ever send
// a string, which z.boolean()/z.enum(CERT_SCOPES) reject outright. Fixed here, not at the schema.
import { CERT_SCOPES, CERT_SCOPE_LABELS } from "./cert-constants";

export type SettingWidgetKind = "checkbox" | "select" | "textarea" | "number" | "text";

/** Keys rendered as a `<select>`, and the option list for each — currently the one enum setting
 *  this project has. Keyed by string rather than SettingKey: this file is deliberately independent
 *  of settings.ts's server-only registry, so the settings page's own row keys (plain strings, as
 *  returned by GET /api/admin/settings) are all this has to work with. */
const SELECT_OPTIONS: Record<string, readonly string[]> = {
  cert_scope_default: CERT_SCOPES,
};

/** Option-value -> display-label maps, for the same select keys above. */
const SELECT_LABELS: Record<string, Record<string, string>> = {
  cert_scope_default: CERT_SCOPE_LABELS,
};

/** Keys whose stored text is long, multi-paragraph legal boilerplate (settings.ts's
 *  CERT_STATEMENT_DEFAULT / SHIPPER_LIABILITY_DEFAULT transcribed from the owner's printed
 *  samples) — a single-line `<input>` makes them uneditable in practice. */
const TEXTAREA_KEYS = new Set(["cert_statement", "shipper_liability_text"]);

/**
 * Picks the control a setting renders as. `value` is the setting's CURRENT value, exactly as
 * returned by GET /api/admin/settings — already the real, zod-parsed JS type — so its `typeof`
 * is what distinguishes a boolean/number setting from a plain string one; `key` is what
 * distinguishes the two string-shaped special cases (the enum select and the two textareas) from
 * an ordinary string setting, since a runtime string alone can't tell those apart.
 */
export function widgetKindFor(key: string, value: unknown): SettingWidgetKind {
  if (key in SELECT_OPTIONS) return "select";
  if (TEXTAREA_KEYS.has(key)) return "textarea";
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  return "text";
}

export function selectOptionsFor(key: string): readonly string[] | undefined {
  return SELECT_OPTIONS[key];
}

export function selectLabelsFor(key: string): Record<string, string> | undefined {
  return SELECT_LABELS[key];
}

/**
 * Coerces a raw form value into the real JS type `setSetting` expects for the given widget kind.
 * This is the fix itself: the old page sent `String(value)` for EVERY kind, including booleans —
 * which setSetting's `z.boolean()` schema rejects outright, a 400 for a value the UI itself just
 * displayed as correct. A checkbox's `checked` is already a boolean and passes through unchanged;
 * a number widget's raw string is parsed; everything else (select/textarea/text) is already the
 * right type as a plain string.
 */
export function coerceForSubmit(kind: SettingWidgetKind, raw: string | boolean): unknown {
  if (kind === "checkbox") return raw;
  if (kind === "number") return Number(raw);
  return raw;
}
