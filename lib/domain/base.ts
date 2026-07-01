import { z } from "zod";

export const baseEntitySchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().nonnegative(),
});
export type BaseEntity = z.infer<typeof baseEntitySchema>;

/** Discount applied at quote level. */
export const discountSchema = z.object({
  kind: z.enum(["amount", "percent"]),
  value: z.number().nonnegative(), // cents (amount) or whole-percent (percent)
});
export type Discount = z.infer<typeof discountSchema>;
