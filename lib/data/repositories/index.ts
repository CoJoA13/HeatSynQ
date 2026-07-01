import type {
  Customer, Contact, Part, ProcessMaster, Specification, Standard, PriceKey, PricingRule,
  Quote, WorkOrder, Certification, Invoice, Operator, ScheduleBlock,
} from "@/lib/domain";

/** Base fields are server-assigned; `number` (if the entity has one) is optional —
 *  omit it to let the number service assign one at create, or pass an explicit
 *  value (including `null`) to keep control (e.g. a to-bill invoice stays `null`). */
export type CreateInput<T> =
  Omit<T, "id" | "createdAt" | "updatedAt" | "version" | "number">
  & Partial<Pick<T, Extract<keyof T, "number">>>;

export interface ReadRepo<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
}

export interface WriteRepo<T extends { id: string }> extends ReadRepo<T> {
  create(input: CreateInput<T>): Promise<T>;
  update(id: string, patch: Partial<Omit<T, "id" | "createdAt" | "updatedAt" | "version">>, expectedVersion: number): Promise<T>;
}

export type NumberedEntity = "quotes" | "workOrders" | "invoices" | "certifications";
export interface NumberService {
  /** Returns the next sequential id/number for an entity type (e.g. "INV-30413"). */
  next(entity: NumberedEntity): Promise<string>;
}

export interface Repositories {
  customers: ReadRepo<Customer> & { byId(ids: string[]): Promise<Customer[]> };
  contacts: ReadRepo<Contact> & { byCustomer(customerId: string): Promise<Contact[]> };
  parts: WriteRepo<Part> & { byCustomer(customerId: string): Promise<Part[]> };
  processMasters: ReadRepo<ProcessMaster>;
  specifications: ReadRepo<Specification>;
  standards: ReadRepo<Standard>;
  priceKeys: ReadRepo<PriceKey>;
  pricingRules: ReadRepo<PricingRule> & { byPriceKey(priceKeyId: string): Promise<PricingRule[]> };
  quotes: WriteRepo<Quote>;
  workOrders: WriteRepo<WorkOrder>;
  certifications: WriteRepo<Certification> & { byWorkOrder(workOrderId: string): Promise<Certification | null> };
  invoices: WriteRepo<Invoice>;
  scheduleBlocks: WriteRepo<ScheduleBlock>;
  operators: ReadRepo<Operator>;
  numbers: NumberService;
}
