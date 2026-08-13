// Pure constants — safe to import from client components (no server imports).
export const REFERENCE_KINDS = [
  "glAccount", "material", "inspectionScale", "inspectionCode", "containerType",
  "carrier", "terms", "paymentType", "commentSnippet", "specification",
  "endingStatement", // Phase 6 ruling 13 — the eleventh kind, the quote footer's statement list
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
  endingStatement: { singular: "Ending statement", plural: "Ending statements", nameLabel: "Name" },
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
 *  before the value ever reaches the API.
 *  `kind: "decimal"` (Task 4 fix round 1) is a SEPARATE kind from plain `"text"`, even though a
 *  `decimalField`-bound value is a string on the wire same as text: `"text"` covers genuine free
 *  text (glAccount.description, commentSnippet/specification.text) where an explicit `""` is a
 *  legitimate value to store, but a `decimalField` column rejects `""` outright (it isn't
 *  `.nullable()`-shaped for an empty string, only for an absent key) — so ReferenceTable.tsx's Add
 *  row needs to know, per field, whether a cleared input means "store empty text" or "no value, drop
 *  the key" (Terms.discountPercent). Conflating the two by leaving discountPercent `"text"` was
 *  exactly the bug this kind exists to prevent.
 *  `kind: "boolean"` (Phase 6, for endingStatement.isDefault — the first boolean extra column;
 *  the nearest in-grid precedent is the Active column itself, so it follows that shape at every
 *  surface): the grid renders it as a checkbox — interactive on existing rows like the Active
 *  toggle (a PUT of `{ [key]: !current }`, gated admin.edit), a plain checkbox on the Add row —
 *  the export writes the raw boolean (a TRUE/FALSE cell, exactly how Active already exports),
 *  and the paste importer coerces a case-insensitive "true"/"false" cell to a real boolean
 *  before the server's `z.boolean()` sees it (anything else stays a string so zod's own
 *  "expected boolean" names the bad cell, the numberColumns philosophy). A blank cell is
 *  dropped like every other optional field, so the column default applies.
 *  `hint` is optional, generic UI-note text shown under an Add-row input — used here for the
 *  early-pay discount's all-or-nothing pairing. */
export const REFERENCE_EXTRA_FIELDS: Record<
  ReferenceKind, { key: string; label: string; kind: "text" | "ref" | "number" | "decimal" | "boolean"; hint?: string }[]
> = {
  glAccount:       [{ key: "description",    label: "Description",   kind: "text" }],
  inspectionCode:  [{ key: "defaultScaleId", label: "Default scale", kind: "ref" }],
  paymentType:     [{ key: "glAccountId",    label: "GL account",    kind: "ref" }],
  commentSnippet:  [{ key: "text",           label: "Text",          kind: "text" }],
  specification:   [{ key: "text",           label: "Text",          kind: "text" }],
  material: [], inspectionScale: [], containerType: [], carrier: [],
  terms: [
    { key: "netDays", label: "Net days", kind: "number" },
    { key: "discountPercent", label: "Discount %", kind: "decimal", hint: "needs Discount days too" },
    { key: "discountDays", label: "Discount days", kind: "number", hint: "needs Discount % too" },
  ],
  endingStatement: [
    { key: "text",      label: "Text",    kind: "text" },
    { key: "isDefault", label: "Default", kind: "boolean", hint: "setting it clears the current default" },
  ],
};
