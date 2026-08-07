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
 *  (P5A design spec §4.1). */
export const PART_PASTE_COLUMNS = [
  "customerCode", "partNumber", "name", "description", "materialName",
  "eachWeight", "loadQty", "loadWeight", "serializationRequired",
] as const;
