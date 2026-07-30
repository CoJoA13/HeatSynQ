// Pure constants — safe to import from client components (no server imports).
export const REFERENCE_KINDS = ["glAccount"] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const REFERENCE_LABELS: Record<ReferenceKind, { singular: string; plural: string; nameLabel: string }> = {
  glAccount: { singular: "GL account", plural: "GL accounts", nameLabel: "Account number" },
};
