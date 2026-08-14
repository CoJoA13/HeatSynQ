/**
 * The traveler's template contract (spec §5.3), derived from `src/server/traveler.ts`'s
 * `buildTravelerDefinition` — every section is one of the builder's stacked blocks, in stack
 * order, and every field is a label or column that builder actually prints. A contract can only
 * re-arrange, re-label, restyle, show, or hide what the data layer already collects (spec §5.3);
 * nothing here is a new data source.
 *
 * LOCKED (spec §5.6): the steps section, its typed-field rendering, and the barcode. The header
 * section is non-hideable because it is what carries the barcode — hiding it would hide the lock.
 */
import { defaultConfig, type TemplateConfig, type TemplateContract } from "./types";

/** The master spec §15 Step-fields ruling (2026-07-30) — the lock's reason string, quoted in
 *  every refusal. Supersedes the original §8 "steps on traveler" show/hide example. */
const STEP_FIELDS_LOCK =
  "Spec §15 Step-fields ruling: typed step fields print in a fixed place on the traveler and " +
  "cannot be quietly omitted.";

/** Spec §4/§8 — "barcode automatic": scanning it into the global search opens the order. */
const BARCODE_LOCK =
  "Spec §8: the traveler barcode is automatic — scanning it opens the order — and cannot be " +
  "removed from any traveler template.";

export const TRAVELER_CONTRACT: TemplateContract = {
  docType: "TRAVELER",
  name: "Traveler",
  sections: [
    {
      // headerBlock — non-hideable because the barcode lives here (see BARCODE_LOCK); the
      // individual header fields other than the barcode remain free.
      key: "header", name: "Header", hideable: false, reorderable: true, lockReason: BARCODE_LOCK,
      fields: [
        { key: "customer_name", name: "Customer name", defaultLabel: "", removable: true },
        { key: "received_from", name: "Received-from address", defaultLabel: "", removable: true },
        { key: "company_name", name: "Company name", defaultLabel: "", removable: true },
        { key: "company_address", name: "Company address", defaultLabel: "", removable: true },
        { key: "company_phone", name: "Company phone", defaultLabel: "", removable: true },
        { key: "order_number", name: "Order number", defaultLabel: "Order Number", removable: true },
        { key: "load_number", name: "Load number", defaultLabel: "Load", removable: true },
        {
          key: "barcode", name: "Order barcode", defaultLabel: "", removable: false,
          lockReason: BARCODE_LOCK,
        },
      ],
    },
    {
      // linesTable — widths [78, "*", 78, 88].
      key: "lines", name: "Part lines", hideable: true, reorderable: true,
      fields: [
        {
          key: "line_qty", name: "Part quantity", defaultLabel: "Part Quantity", removable: true,
          column: { table: "lines", defaultWidth: 78 },
        },
        {
          key: "line_part", name: "Part identity",
          defaultLabel: "Part Number / Part Name / Description", removable: true,
          column: { table: "lines", defaultWidth: "*" },
        },
        {
          key: "line_each_weight", name: "Part weight", defaultLabel: "Part Weight", removable: true,
          column: { table: "lines", defaultWidth: 78 },
        },
        {
          key: "line_weight", name: "Line weight", defaultLabel: "Line Weight", removable: true,
          column: { table: "lines", defaultWidth: 88 },
        },
      ],
    },
    {
      // quantityTable — widths [78, 78, "*", 88, 78, 88].
      key: "quantities", name: "Quantities and containers", hideable: true, reorderable: true,
      fields: [
        {
          key: "order_qty", name: "Order quantity", defaultLabel: "Order Quantity", removable: true,
          column: { table: "quantities", defaultWidth: 78 },
        },
        {
          key: "load_qty", name: "Load quantity", defaultLabel: "Load Quantity", removable: true,
          column: { table: "quantities", defaultWidth: 78 },
        },
        {
          key: "container", name: "Container", defaultLabel: "Container", removable: true,
          column: { table: "quantities", defaultWidth: "*" },
        },
        {
          key: "container_qty", name: "Container count", defaultLabel: "Container Quantity",
          removable: true, column: { table: "quantities", defaultWidth: 88 },
        },
        {
          key: "tare_weight", name: "Tare weight", defaultLabel: "Tare Weight", removable: true,
          column: { table: "quantities", defaultWidth: 78 },
        },
        {
          key: "gross_weight", name: "Gross weight", defaultLabel: "Gross Weight", removable: true,
          column: { table: "quantities", defaultWidth: 88 },
        },
      ],
    },
    {
      // processRow — label/value pairs in one hand-laid table; no column memberships (its widths
      // are the builder's own, not a per-column knob).
      key: "process", name: "Process row", hideable: true, reorderable: true,
      fields: [
        // The deliberately blank Process: slot (Phase 3 owner ruling) — ruling 4 binds
        // `part.processName` to it in a later task; the contract just declares the slot.
        { key: "process", name: "Process", defaultLabel: "Process:", removable: true },
        { key: "material", name: "Material", defaultLabel: "Material:", removable: true },
        { key: "process_id", name: "Process ID", defaultLabel: "Process ID:", removable: true },
      ],
    },
    {
      // inspectionsBlock — heading plus the inner table, widths ["*", 55, 48, 48, 72, "*"].
      key: "inspections", name: "Key characteristic inspections", hideable: true, reorderable: true,
      fields: [
        {
          key: "inspections_title", name: "Inspections heading",
          defaultLabel: "Key Characteristic Inspection(s):", removable: true,
        },
        {
          key: "inspection_code", name: "Inspection code", defaultLabel: "Inspection",
          removable: true, column: { table: "inspections", defaultWidth: "*" },
        },
        {
          key: "inspection_scale", name: "Scale", defaultLabel: "Scale", removable: true,
          column: { table: "inspections", defaultWidth: 55 },
        },
        {
          key: "inspection_min", name: "Minimum", defaultLabel: "Min", removable: true,
          column: { table: "inspections", defaultWidth: 48 },
        },
        {
          key: "inspection_max", name: "Maximum", defaultLabel: "Max", removable: true,
          column: { table: "inspections", defaultWidth: 48 },
        },
        {
          key: "inspection_qty", name: "Sample quantity", defaultLabel: "Quantity", removable: true,
          column: { table: "inspections", defaultWidth: 72 },
        },
        {
          key: "inspection_location", name: "Location", defaultLabel: "Location", removable: true,
          column: { table: "inspections", defaultWidth: "*" },
        },
      ],
    },
    {
      // stepsTable — widths [16, 62, "*", 34, 30, 46]. LOCKED whole (spec §5.6): non-hideable
      // and pinned to this position; the typed-field columns below are individually locked too
      // (defense in depth — the section lock alone would not survive a contract edit that
      // loosened it). The EQ#/OP/Date handwriting boxes are NOT typed fields and stay free.
      key: "steps", name: "Process steps", hideable: false, reorderable: false,
      lockReason: STEP_FIELDS_LOCK,
      fields: [
        {
          key: "steps_title", name: "Steps heading", defaultLabel: "PROCESS STEPS:",
          removable: true,
        },
        {
          key: "step_position", name: "Step position", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK, column: { table: "steps", defaultWidth: 16 },
        },
        {
          key: "step_code", name: "Step code", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK, column: { table: "steps", defaultWidth: 62 },
        },
        {
          key: "step_instruction", name: "Step instruction", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK, column: { table: "steps", defaultWidth: "*" },
        },
        {
          // The typed step values ("Furnace Temp: 1650 °F") render inside the instruction
          // column — a rendering, not a column of their own, so no column membership.
          key: "step_values", name: "Typed step values", defaultLabel: "", removable: false,
          lockReason: STEP_FIELDS_LOCK,
        },
        {
          key: "step_eq", name: "EQ# box", defaultLabel: "EQ#", removable: true,
          column: { table: "steps", defaultWidth: 34 },
        },
        {
          key: "step_op", name: "OP box", defaultLabel: "OP", removable: true,
          column: { table: "steps", defaultWidth: 30 },
        },
        {
          key: "step_date", name: "Date box", defaultLabel: "Date", removable: true,
          column: { table: "steps", defaultWidth: 46 },
        },
      ],
    },
    {
      // footerBlocks — the hand-completed results/sign-off area; labels only, hand-laid.
      key: "footer", name: "Results and sign-off", hideable: true, reorderable: true,
      fields: [
        { key: "results", name: "Results box", defaultLabel: "RESULTS:", removable: true },
        {
          key: "tempered_results", name: "Tempered results box", defaultLabel: "TEMPERED RESULTS:",
          removable: true,
        },
        {
          key: "final_inspection", name: "Final inspection", defaultLabel: "FINAL INSPECTION:",
          removable: true,
        },
        { key: "pass", name: "Pass checkbox", defaultLabel: "PASS", removable: true },
        { key: "fail", name: "Fail checkbox", defaultLabel: "FAIL", removable: true },
        { key: "tested_by", name: "Tested by", defaultLabel: "Tested By:", removable: true },
        { key: "tested_date", name: "Tested date", defaultLabel: "Date:", removable: true },
        { key: "ok_to_ship", name: "OK to ship", defaultLabel: "OK to Ship:", removable: true },
        { key: "ship_date", name: "OK-to-ship date", defaultLabel: "Date:", removable: true },
      ],
    },
  ],
  textBlocks: [], // the traveler carries no standing paragraph — its texts are all data or labels
  // `num()` groups thousands ("4,500"); no date and no price ever prints, so those knobs are
  // deliberately off this document's surface.
  formats: { thousandsSeparator: true },
  // Today's builder: defaultStyle 8pt; the company name (12pt) is the sheet's heading; 6.5pt is
  // the sub-annotation size (pieces-per-container, load weight).
  fonts: { family: "Roboto", baseSize: 8, headingSize: 12, smallSize: 6.5 },
};

export const DEFAULT_CONFIG: TemplateConfig = defaultConfig(TRAVELER_CONTRACT);
