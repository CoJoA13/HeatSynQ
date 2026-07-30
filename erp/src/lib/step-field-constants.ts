// Pure constants — safe to import from client components (no server imports).
export const STEP_FIELD_TYPES = ["NUMBER", "TEXT", "DATE", "CHECKBOX"] as const;
export type StepFieldType = (typeof STEP_FIELD_TYPES)[number];
