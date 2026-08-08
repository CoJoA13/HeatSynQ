// Pure constants — safe to import from client components (no server imports).
export const REFERENCE_KINDS = [
  "glAccount", "material", "inspectionScale", "inspectionCode", "containerType",
  "carrier", "terms", "paymentType", "commentSnippet", "specification",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const REFERENCE_LABELS: Record<ReferenceKind, { singular: string; plural: string; nameLabel: string }> = {
  glAccount:       { singular: "GL account",       plural: "GL accounts",       nameLabel: "Account number" },
  material:        { singular: "Material",         plural: "Materials",         nameLabel: "Name" },
  inspectionScale: { singular: "Inspection scale", plural: "Inspection scales", nameLabel: "Name" },
  inspectionCode:  { singular: "Inspection code",  plural: "Inspection codes",  nameLabel: "Code" },
  containerType:   { singular: "Container type",   plural: "Container types",   nameLabel: "Name" },
  carrier:         { singular: "Carrier",          plural: "Carriers",          nameLabel: "Name" },
  terms:           { singular: "Terms",            plural: "Terms",             nameLabel: "Name" },
  paymentType:     { singular: "Payment type",     plural: "Payment types",     nameLabel: "Name" },
  commentSnippet:  { singular: "Comment snippet",  plural: "Comment snippets",  nameLabel: "Name" },
  specification:   { singular: "Specification",    plural: "Specifications",    nameLabel: "Name" },
};

/** Kinds readable by any signed-in user. A distinct set from ReferenceKind, and NOT a subset:
 *  it drops glAccount (the one kind no data-entry screen reads — keeping chart-of-accounts
 *  numbers off a route everyone can reach) and adds processStepCode, which is not a reference
 *  kind at all but which the Phase 2C-3 Process Steps designer must read. */
export const PICKLIST_KINDS = [
  ...REFERENCE_KINDS.filter((k) => k !== "glAccount"),
  "processStepCode",
] as const;
export type PickListKind = (typeof PICKLIST_KINDS)[number];

/** Extra columns beyond name/active, for the generic list UI and Excel export.
 *  `kind: "number"` is Task 4's addition, for Terms' netDays/discountDays — the ReferenceTable
 *  Add row and the paste importer both only ever handle raw strings otherwise, and the server's
 *  netDays/discountDays columns are plain `z.number().int()` (not string-accepting like
 *  `decimalField`), so those two entry points coerce a "number" field to an actual JS number
 *  before the value ever reaches the API. `hint` is optional, generic UI-note text shown under an
 *  Add-row input — used here for the early-pay discount's all-or-nothing pairing. */
export const REFERENCE_EXTRA_FIELDS: Record<
  ReferenceKind, { key: string; label: string; kind: "text" | "ref" | "number"; hint?: string }[]
> = {
  glAccount:       [{ key: "description",    label: "Description",   kind: "text" }],
  inspectionCode:  [{ key: "defaultScaleId", label: "Default scale", kind: "ref" }],
  paymentType:     [{ key: "glAccountId",    label: "GL account",    kind: "ref" }],
  commentSnippet:  [{ key: "text",           label: "Text",          kind: "text" }],
  specification:   [{ key: "text",           label: "Text",          kind: "text" }],
  material: [], inspectionScale: [], containerType: [], carrier: [],
  terms: [
    { key: "netDays", label: "Net days", kind: "number" },
    { key: "discountPercent", label: "Discount %", kind: "text", hint: "needs Discount days too" },
    { key: "discountDays", label: "Discount days", kind: "number", hint: "needs Discount % too" },
  ],
};
