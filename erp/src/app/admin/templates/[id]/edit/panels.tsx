"use client";
// The contract-driven editing panels (Phase 7 Task 17, spec §5.5) — thin, presentational wrappers
// over the pure config-editing logic in `@/lib/template-editor`. ONE component tree serves all
// eight docTypes: every panel renders from the contract handed to it (`contractFor(docType)`), with
// NO per-type branch anywhere — a knob shows because the contract declares it, a section is locked
// because the contract locks it. Client-safe: the contract registry and the editor logic are pure
// declarations with no `src/server/**` import (the `permission-ui.ts` precedent, CLAUDE.md).
//
// The panels hold NO state of their own. Each mutation is `apply(fn)` where `fn` is one of the
// tested pure functions — `apply` is the orchestrator's `setConfig(fn(config))`, so the panels are
// the "thin wrappers proven in E2E" the brief calls for, and every rule they enforce (a locked
// element cannot be hidden, a reorder cannot cross a pin) is the pure layer's, unit-tested directly.
import {
  CONTENT_WIDTH,
  DATE_FORMATS,
  FONT_FAMILIES,
  NEGATIVE_STYLES,
  PRICE_DECIMALS,
  type ContractField,
  type DateFormat,
  type FontFamily,
  type NegativeStyle,
  type PriceDecimals,
  type TemplateConfig,
  type TemplateContract,
} from "@/lib/template-contracts";
import {
  canMoveField,
  canMoveSection,
  lockKey,
  moveField,
  moveSection,
  setFieldLabel,
  setFieldWidth,
  setFonts,
  setFormat,
  setPageFooter,
  setTextBlock,
  tableBudgets,
  toggleFieldVisible,
  toggleSectionVisible,
} from "@/lib/template-editor";

/** Every panel takes the contract + the working config + one `apply` that swaps the config for the
 *  result of a pure function, plus the shared edit gate (`disabled`/`editTitle`, §5.16) and the
 *  namespaced padlock lookup (`locks`). */
export type PanelProps = {
  contract: TemplateContract;
  config: TemplateConfig;
  apply: (fn: (c: TemplateConfig) => TemplateConfig) => void;
  disabled: boolean;
  editTitle: string | undefined;
  locks: Map<string, string>;
};

// A card wrapper so every panel reads the same on the page.
function Panel({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded border bg-white p-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 mb-2 text-xs text-slate-500">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </section>
  );
}

/** A padlock + reason, shown beside a locked section/field. The reason IS the string the server
 *  quotes when it refuses hiding/reordering it (spec §5.6) — one source, via `lockIndex`. */
function Lock({ reason }: { reason: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-700" title={reason} aria-label={`locked: ${reason}`}>
      <span aria-hidden>🔒</span>
      <span className="italic">locked</span>
    </span>
  );
}

function Reorder({ onUp, onDown, upOk, downOk, disabled, title }: {
  onUp: () => void; onDown: () => void; upOk: boolean; downOk: boolean;
  disabled: boolean; title: string | undefined;
}) {
  const cls = "rounded border px-1.5 text-xs leading-5 disabled:cursor-not-allowed disabled:text-slate-300";
  return (
    <span className="flex gap-1">
      <button type="button" onClick={onUp} disabled={disabled || !upOk} title={title} aria-label="Move up" className={cls}>↑</button>
      <button type="button" onClick={onDown} disabled={disabled || !downOk} title={title} aria-label="Move down" className={cls}>↓</button>
    </span>
  );
}

// ------------------------------------------------------------------------------------------------
// Sections and fields — show/hide, reorder, label override. Locked entries render locked + disabled.
// ------------------------------------------------------------------------------------------------

export function SectionsPanel({ contract, config, apply, disabled, editTitle, locks }: PanelProps) {
  const byKey = new Map(contract.sections.map((cs) => [cs.key, cs]));
  return (
    <Panel title="Sections and fields"
           hint="Show or hide, reorder, and relabel. Locked elements print in a fixed place and cannot be hidden or moved.">
      <div className="space-y-3">
        {config.sections.map((s) => {
          const cs = byKey.get(s.key);
          if (cs === undefined) return null; // unknown key — the validator's refusal, not the UI's
          const sectionLock = locks.get(lockKey("section", s.key));
          const hideTitle = sectionLock ?? (cs.hideable ? editTitle : "This section prints in a fixed place");
          const fieldByKey = new Map(cs.fields.map((cf) => [cf.key, cf]));
          return (
            <div key={s.key} className="rounded border border-slate-200">
              <div className="flex flex-wrap items-center gap-3 bg-slate-50 px-3 py-2">
                <label className="flex items-center gap-1.5 text-sm font-medium">
                  <input type="checkbox" checked={s.visible}
                         disabled={disabled || !cs.hideable}
                         title={s.visible || cs.hideable ? hideTitle : undefined}
                         onChange={() => apply((c) => toggleSectionVisible(c, s.key))}
                         aria-label={`Show section ${cs.name}`} />
                  {cs.name}
                </label>
                {sectionLock && <Lock reason={sectionLock} />}
                <div className="ml-auto">
                  <Reorder disabled={disabled}
                           title={cs.reorderable ? editTitle : (sectionLock ?? "This section is pinned in place")}
                           upOk={canMoveSection(config, contract, s.key, -1)}
                           downOk={canMoveSection(config, contract, s.key, 1)}
                           onUp={() => apply((c) => moveSection(c, contract, s.key, -1))}
                           onDown={() => apply((c) => moveSection(c, contract, s.key, 1))} />
                </div>
              </div>
              <ul className="divide-y">
                {s.fields.map((f) => {
                  const cf = fieldByKey.get(f.key);
                  if (cf === undefined) return null;
                  const fieldLock = locks.get(lockKey("field", f.key));
                  return (
                    <li key={f.key} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-sm">
                      <label className="flex items-center gap-1.5" title={fieldLock ?? (cf.removable ? editTitle : "This field cannot be hidden")}>
                        <input type="checkbox" checked={f.visible}
                               disabled={disabled || !cf.removable}
                               onChange={() => apply((c) => toggleFieldVisible(c, s.key, f.key))}
                               aria-label={`Show field ${cf.name}`} />
                        <span className="w-40 truncate text-slate-700">{cf.name}</span>
                      </label>
                      <input type="text" value={f.label ?? ""}
                             disabled={disabled}
                             placeholder={cf.defaultLabel === "" ? "(no printed label)" : cf.defaultLabel}
                             title={editTitle}
                             onChange={(e) => apply((c) => setFieldLabel(c, s.key, f.key, e.target.value))}
                             aria-label={`Label for ${cf.name}`}
                             className="w-56 rounded border px-2 py-0.5 text-xs disabled:bg-slate-100" />
                      {fieldLock && <Lock reason={fieldLock} />}
                      <div className="ml-auto">
                        <Reorder disabled={disabled} title={editTitle}
                                 upOk={canMoveField(config, s.key, f.key, -1)}
                                 downOk={canMoveField(config, s.key, f.key, 1)}
                                 onUp={() => apply((c) => moveField(c, s.key, f.key, -1))}
                                 onDown={() => apply((c) => moveField(c, s.key, f.key, 1))} />
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Column widths — numeric inputs per declared column, LIVE budget check against 564pt (ruling 3).
// ------------------------------------------------------------------------------------------------

type WidthColumn = { sectionKey: string; field: ContractField; visible: boolean; width: number | null };

/** Group the contract's column fields by table, carrying each column's current visibility + width
 *  override — the widths panel's presentation grouping (the authoritative totals come from the
 *  pure `tableBudgets`). Local to this panel: pure display shaping, no config mutation. */
function widthTables(contract: TemplateContract, config: TemplateConfig): { table: string; columns: WidthColumn[] }[] {
  const cfgSection = new Map(config.sections.map((s) => [s.key, s]));
  const order: string[] = [];
  const cols = new Map<string, WidthColumn[]>();
  for (const cs of contract.sections) {
    const sc = cfgSection.get(cs.key);
    for (const cf of cs.fields) {
      if (cf.column === undefined) continue;
      const fc = sc?.fields.find((f) => f.key === cf.key);
      const table = cf.column.table;
      if (!cols.has(table)) { cols.set(table, []); order.push(table); }
      cols.get(table)!.push({
        sectionKey: cs.key, field: cf,
        visible: (sc?.visible ?? true) && (fc?.visible ?? true),
        width: fc?.width ?? null,
      });
    }
  }
  return order.map((table) => ({ table, columns: cols.get(table)! }));
}

export function WidthsPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  const tables = widthTables(contract, config);
  if (tables.length === 0) return null; // a document with no column tables (rare) shows no panel
  const budgets = new Map(tableBudgets(contract, config).map((b) => [b.table, b]));
  return (
    <Panel title="Column widths"
           hint={`Widths are in points. Each table's visible columns must total no more than its budget (the ${CONTENT_WIDTH}pt letter content width, or less where a table shares the page).`}>
      <div className="space-y-4">
        {tables.map(({ table, columns }) => {
          const b = budgets.get(table);
          const budget = b?.budget ?? CONTENT_WIDTH;
          const total = b?.total ?? 0;
          const over = b?.over ?? false;
          return (
            <div key={table}>
              <div className="mb-1 flex items-baseline justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{table}</span>
                <span className={`text-xs ${over ? "font-semibold text-red-700" : "text-slate-500"}`}
                      aria-label={`${table} width total`}>
                  {total} / {budget}pt{over ? " — over budget" : ""}
                </span>
              </div>
              {over && (
                <p className="mb-1 rounded bg-red-50 px-2 py-1 text-xs text-red-700" role="alert">
                  The visible columns of “{table}” total {total}pt, past the {budget}pt budget. Narrow a
                  column or hide one to fit.
                </p>
              )}
              <ul className="space-y-1">
                {columns.map(({ sectionKey, field, visible, width }) => {
                  const flex = field.column!.defaultWidth === "*";
                  return (
                    <li key={field.key} className={`flex items-center gap-2 text-sm ${visible ? "" : "text-slate-400"}`}>
                      <span className="w-52 truncate">{field.name}{visible ? "" : " (hidden)"}</span>
                      <input type="number" min={1} max={CONTENT_WIDTH}
                             value={width ?? ""}
                             disabled={disabled}
                             placeholder={flex ? "flex" : String(field.column!.defaultWidth)}
                             title={editTitle}
                             onChange={(e) => {
                               const raw = e.target.value.trim();
                               const next = raw === "" ? null : Number(raw);
                               apply((c) => setFieldWidth(c, sectionKey, field.key,
                                 next === null || Number.isNaN(next) ? null : next));
                             }}
                             aria-label={`Width for ${field.name}`}
                             className="w-24 rounded border px-2 py-0.5 text-xs disabled:bg-slate-100" />
                      <span className="text-xs text-slate-400">{flex ? "flex column (fills remaining width)" : "pt"}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Format pickers — only the knobs the contract DECLARES (a traveler has no price/date knobs).
// ------------------------------------------------------------------------------------------------

const NEGATIVE_STYLE_LABELS: Record<NegativeStyle, string> = {
  SIGN_AFTER_SYMBOL: "$-1,234.56  (sign after the symbol)",
  LEADING_MINUS: "-$1,234.56  (leading minus)",
  PARENTHESES: "($1,234.56)  (parentheses)",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1 text-sm">
      <span className="text-slate-600">{label}</span>
      {children}
    </label>
  );
}

export function FormatsPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  const f = config.formats;
  const declares = contract.formats;
  // No declared knobs (a document that prints no numbers or dates) → no panel.
  if (declares.negativeStyle === undefined && declares.priceDecimals === undefined
      && declares.thousandsSeparator === undefined && declares.dateFormat === undefined) {
    return null;
  }
  const sel = "rounded border px-2 py-1 text-sm disabled:bg-slate-100";
  return (
    <Panel title="Number and date formats" hint="How money, quantities and dates print on this document.">
      <div className="divide-y">
        {declares.negativeStyle !== undefined && (
          <Row label="Negative amounts">
            <select value={f.negativeStyle} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Negative amount style"
                    onChange={(e) => apply((c) => setFormat(c, "negativeStyle", e.target.value as NegativeStyle))}>
              {NEGATIVE_STYLES.map((v) => <option key={v} value={v}>{NEGATIVE_STYLE_LABELS[v]}</option>)}
            </select>
          </Row>
        )}
        {declares.priceDecimals !== undefined && (
          <Row label="Price decimal places">
            <select value={f.priceDecimals} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Price decimal places"
                    onChange={(e) => apply((c) => setFormat(c, "priceDecimals", Number(e.target.value) as PriceDecimals))}>
              {PRICE_DECIMALS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
        )}
        {declares.thousandsSeparator !== undefined && (
          <Row label="Group thousands (1,234)">
            <input type="checkbox" checked={f.thousandsSeparator ?? false} disabled={disabled} title={editTitle}
                   aria-label="Group thousands"
                   onChange={(e) => apply((c) => setFormat(c, "thousandsSeparator", e.target.checked))} />
          </Row>
        )}
        {declares.dateFormat !== undefined && (
          <Row label="Date format">
            <select value={f.dateFormat} disabled={disabled} title={editTitle} className={sel}
                    aria-label="Date format"
                    onChange={(e) => apply((c) => setFormat(c, "dateFormat", e.target.value as DateFormat))}>
              {DATE_FORMATS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Row>
        )}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Fonts — the curated 4-family list + the three role sizes.
// ------------------------------------------------------------------------------------------------

export function FontsPanel({ config, apply, disabled, editTitle }: PanelProps) {
  const fonts = config.fonts;
  const num = "w-20 rounded border px-2 py-1 text-sm disabled:bg-slate-100";
  const sizeRow = (label: string, key: "baseSize" | "headingSize" | "smallSize") => (
    <Row label={label}>
      <input type="number" min={4} max={72} step={0.5} value={fonts[key]} disabled={disabled} title={editTitle}
             aria-label={label} className={num}
             onChange={(e) => {
               const n = Number(e.target.value);
               if (!Number.isNaN(n)) apply((c) => setFonts(c, { [key]: n }));
             }} />
    </Row>
  );
  return (
    <Panel title="Fonts" hint="One family for the whole document, from the bundled set.">
      <div className="divide-y">
        <Row label="Family">
          <select value={fonts.family} disabled={disabled} title={editTitle} aria-label="Font family"
                  className="rounded border px-2 py-1 text-sm disabled:bg-slate-100"
                  onChange={(e) => apply((c) => setFonts(c, { family: e.target.value as FontFamily }))}>
            {FONT_FAMILIES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </Row>
        {sizeRow("Body size (pt)", "baseSize")}
        {sizeRow("Heading size (pt)", "headingSize")}
        {sizeRow("Small size (pt)", "smallSize")}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Text blocks — the standing paragraphs (cert statement, BOL legal, quote intro/liability, …).
// ------------------------------------------------------------------------------------------------

export function TextBlocksPanel({ contract, config, apply, disabled, editTitle }: PanelProps) {
  if (contract.textBlocks.length === 0) return null; // a document with no standing text (traveler)
  return (
    <Panel title="Standing text" hint="Paragraphs printed verbatim on every document of this type.">
      <div className="space-y-3">
        {contract.textBlocks.map((t) => (
          <label key={t.key} className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">{t.name}</span>
            <textarea value={config.textBlocks[t.key] ?? ""} disabled={disabled} title={editTitle}
                      rows={3} placeholder={t.defaultText}
                      aria-label={t.name}
                      onChange={(e) => apply((c) => setTextBlock(c, t.key, e.target.value))}
                      className="w-full rounded border px-2 py-1 text-xs disabled:bg-slate-100" />
          </label>
        ))}
      </div>
    </Panel>
  );
}

// ------------------------------------------------------------------------------------------------
// Page footer — the "Page N of M" toggle (on by default only for the quote; the editor reflects it).
// ------------------------------------------------------------------------------------------------

export function PageFooterPanel({ config, apply, disabled, editTitle }: PanelProps) {
  return (
    <Panel title="Page footer">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={config.pageFooter} disabled={disabled} title={editTitle}
               aria-label="Print a page footer"
               onChange={(e) => apply((c) => setPageFooter(c, e.target.checked))} />
        Print “Page N of M” at the foot of every page
      </label>
    </Panel>
  );
}
