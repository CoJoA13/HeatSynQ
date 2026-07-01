import { z } from "zod";
import { baseEntitySchema, discountSchema } from "./base";
import {
  QUOTE_STATUSES, ORDER_STATUSES, INVOICE_STATUSES, CERT_STATUSES,
  CUSTOMER_STATUSES, PRICING_BASES, ROLE_KEYS,
} from "./enums";

export const operatorSchema = baseEntitySchema.extend({
  name: z.string(),
  initials: z.string(),
  title: z.string(),
  role: z.enum(ROLE_KEYS),
  quoteAuthLimitCents: z.number().int().nonnegative(),
});
export type Operator = z.infer<typeof operatorSchema>;

export const contactSchema = baseEntitySchema.extend({
  customerId: z.string(),
  name: z.string(),
  role: z.string(),
  email: z.string(),
  phone: z.string(),
});
export type Contact = z.infer<typeof contactSchema>;

export const customerSchema = baseEntitySchema.extend({
  customerNumber: z.string(),       // "1042"
  name: z.string(),
  initials: z.string(),
  city: z.string(),
  billingAddress: z.string(),
  phone: z.string(),
  terms: z.string(),                // "Net 30"
  status: z.enum(CUSTOMER_STATUSES),
  priceKeyId: z.string().nullable(),
  taxExempt: z.boolean(),
  defaultCertSpecId: z.string().nullable(),
  defaultCertCopies: z.number().int().nonnegative(),
  ytdSalesCents: z.number().int(),
});
export type Customer = z.infer<typeof customerSchema>;

export const specificationSchema = baseEntitySchema.extend({
  code: z.string(),                 // "AMS 2759/3"
  title: z.string(),
  rev: z.string(),
  owner: z.string(),                // SAE / DoD / Customer
});
export type Specification = z.infer<typeof specificationSchema>;

export const pricingRuleSchema = baseEntitySchema.extend({
  priceKeyId: z.string(),
  process: z.string(),              // "Carburize"
  basis: z.enum(PRICING_BASES),
  rateCents: z.number().int().nonnegative(),
  minChargeCents: z.number().int().nonnegative().nullable(),
});
export type PricingRule = z.infer<typeof pricingRuleSchema>;

export const priceKeySchema = baseEntitySchema.extend({
  code: z.string(),                 // "AERO-1"
  description: z.string(),
});
export type PriceKey = z.infer<typeof priceKeySchema>;

export const processStepSchema = z.object({
  n: z.number().int().positive(),
  op: z.string(),                   // "Carburize"
  equip: z.string(),                // work-center label
  instr: z.string(),
  params: z.array(z.string()),
  track: z.enum(["track_in","track_in_out","track_out","inspect","none"]),
});
export type ProcessStep = z.infer<typeof processStepSchema>;

export const processMasterSchema = baseEntitySchema.extend({
  code: z.string(),                 // "PM-CARB-58"
  name: z.string(),                 // "Carburize & temper"
  description: z.string(),
  rev: z.string(),
  status: z.literal("active"),
  steps: z.array(processStepSchema),
  surfaceHardness: z.string(),
  caseDepth: z.string(),
  hardnessScale: z.string(),
});
export type ProcessMaster = z.infer<typeof processMasterSchema>;

export const partSchema = baseEntitySchema.extend({
  partNumber: z.string(),           // "TS-4471"
  description: z.string(),
  customerId: z.string(),
  material: z.string(),
  drawingRev: z.string(),
  hardness: z.string(),
  caseDepth: z.string(),
  specificationId: z.string().nullable(),
  processMasterId: z.string().nullable(),
  priceKeyId: z.string().nullable(),
  inspectionScale: z.string(),
  inspectionSample: z.string(),
});
export type Part = z.infer<typeof partSchema>;

export const quoteLineSchema = z.object({
  id: z.string(),
  process: z.string(),
  basis: z.enum(PRICING_BASES),
  qtyOrWeight: z.number().nonnegative(),
  rateCents: z.number().int().nonnegative(),
  minChargeCents: z.number().int().nonnegative().nullable(),
});
export type QuoteLine = z.infer<typeof quoteLineSchema>;

export const quotePartSchema = z.object({
  id: z.string(),
  partId: z.string(),
  material: z.string(),
  quantity: z.number().int().nonnegative(),
  lines: z.array(quoteLineSchema),
});
export type QuotePart = z.infer<typeof quotePartSchema>;

export const quoteSchema = baseEntitySchema.extend({
  number: z.string(),               // "Q-2841"
  rev: z.number().int().nonnegative(),
  customerId: z.string(),
  customerPO: z.string(),
  status: z.enum(QUOTE_STATUSES),
  salespersonId: z.string(),
  date: z.string(),
  validUntil: z.string(),
  requiredBy: z.string().nullable(),
  discount: discountSchema.nullable(),
  estCostCents: z.number().int().nonnegative(), // stub cost for margin
  notes: z.string(),
  parts: z.array(quotePartSchema),
  wonOrderId: z.string().nullable(),
});
export type Quote = z.infer<typeof quoteSchema>;

export const orderLineSchema = z.object({
  id: z.string(),
  partId: z.string(),
  description: z.string(),
  quantity: z.number().int().nonnegative(),
  spec: z.string(),
});
export type OrderLine = z.infer<typeof orderLineSchema>;

export const orderPricingLineSchema = z.object({
  process: z.string(),
  detail: z.string(),               // "600 lb"
  amountCents: z.number().int(),
});
export type OrderPricingLine = z.infer<typeof orderPricingLineSchema>;

export const activityEntrySchema = z.object({
  at: z.string(),
  actor: z.string(),
  message: z.string(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

export const workOrderSchema = baseEntitySchema.extend({
  number: z.string(),               // "WO-48211"
  customerId: z.string(),
  customerPO: z.string(),
  quoteId: z.string().nullable(),
  processSummary: z.string(),       // "Carburize + Temper"
  processMasterId: z.string().nullable(),
  status: z.enum(ORDER_STATUSES),
  orderedDate: z.string(),
  due: z.string(),
  certifyRequired: z.boolean(),
  certSpecId: z.string().nullable(),
  orderValueCents: z.number().int().nonnegative(),
  progressPct: z.number().int().min(0).max(100),
  lines: z.array(orderLineSchema),
  pricing: z.array(orderPricingLineSchema),
  steps: z.array(processStepSchema),
  activity: z.array(activityEntrySchema),
});
export type WorkOrder = z.infer<typeof workOrderSchema>;

export const certificationSchema = baseEntitySchema.extend({
  number: z.string(),               // "C-9921"
  customerId: z.string(),
  workOrderId: z.string(),
  specificationId: z.string().nullable(),
  type: z.string(),
  status: z.enum(CERT_STATUSES),
  copies: z.number().int().nonnegative(),
});
export type Certification = z.infer<typeof certificationSchema>;

export const invoiceSchema = baseEntitySchema.extend({
  number: z.string().nullable(),    // null while "to_bill"
  customerId: z.string(),
  workOrderId: z.string(),
  amountCents: z.number().int().nonnegative(),
  status: z.enum(INVOICE_STATUSES),
  shippedDate: z.string(),
  invoicedDate: z.string().nullable(),
  paidDate: z.string().nullable(),
});
export type Invoice = z.infer<typeof invoiceSchema>;
