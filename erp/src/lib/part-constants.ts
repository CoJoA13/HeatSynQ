// Pure constants — safe to import from client components (no server imports).
export const PRICE_PER = ["EACH", "LB", "PER_100", "PER_1000", "LOT"] as const;
export type PricePerValue = (typeof PRICE_PER)[number];
export const PRICE_PER_LABELS: Record<PricePerValue, string> = {
  EACH: "Each", LB: "Per lb", PER_100: "Per 100", PER_1000: "Per 1,000", LOT: "Lot (flat)",
};

export const PART_FIELD_TYPES = ["TEXT", "NUMBER", "DATE", "CHECKBOX"] as const;
export type PartFieldTypeValue = (typeof PART_FIELD_TYPES)[number];

/** Column order for spreadsheet paste (Task 9), and the header hint above the paste box.
 *  Pricing is deliberately absent: Phase 5A moved it off `Part` onto `PartPrice` rows keyed by
 *  process step code, edited on their own grid and NOT part of the parts paste contract
 *  (P5A design spec §4.1). `processName` (Phase 7 Task 15) sits right after `description`, the
 *  SAME relative position it holds in the Excel export (src/app/api/parts/export/route.ts) —
 *  paste stays a positional subsequence of export so a part survives export → edit → paste back
 *  (HANDOFF's "Export/paste round-trip" contract; do not split the two apart). */
export const PART_PASTE_COLUMNS = [
  "customerCode", "partNumber", "name", "description", "processName", "materialName",
  "eachWeight", "loadQty", "loadWeight", "serializationRequired",
] as const;
