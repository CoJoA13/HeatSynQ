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

/** Extra columns beyond name/active, for the generic list UI and Excel export. */
export const REFERENCE_EXTRA_FIELDS: Record<ReferenceKind, { key: string; label: string; kind: "text" | "ref" }[]> = {
  glAccount:       [{ key: "description",    label: "Description",   kind: "text" }],
  inspectionCode:  [{ key: "defaultScaleId", label: "Default scale", kind: "ref" }],
  paymentType:     [{ key: "glAccountId",    label: "GL account",    kind: "ref" }],
  commentSnippet:  [{ key: "text",           label: "Text",          kind: "text" }],
  specification:   [{ key: "text",           label: "Text",          kind: "text" }],
  material: [], inspectionScale: [], containerType: [], carrier: [], terms: [],
};
