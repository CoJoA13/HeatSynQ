import type {
  Customer, Contact, Part, ProcessMaster, Specification, PriceKey, PricingRule,
  Quote, WorkOrder, Certification, Invoice, Operator,
} from "@/lib/domain";

export interface ReadRepo<T> {
  list(): Promise<T[]>;
  get(id: string): Promise<T | null>;
}

export interface WriteRepo<T extends { id: string }> extends ReadRepo<T> {
  create(input: Omit<T, "id" | "createdAt" | "updatedAt" | "version">): Promise<T>;
  update(id: string, patch: Partial<T>, expectedVersion: number): Promise<T>;
}

export interface Repositories {
  customers: ReadRepo<Customer> & { byId(ids: string[]): Promise<Customer[]> };
  contacts: ReadRepo<Contact> & { byCustomer(customerId: string): Promise<Contact[]> };
  parts: WriteRepo<Part> & { byCustomer(customerId: string): Promise<Part[]> };
  processMasters: ReadRepo<ProcessMaster>;
  specifications: ReadRepo<Specification>;
  priceKeys: ReadRepo<PriceKey>;
  pricingRules: ReadRepo<PricingRule> & { byPriceKey(priceKeyId: string): Promise<PricingRule[]> };
  quotes: WriteRepo<Quote>;
  workOrders: WriteRepo<WorkOrder>;
  certifications: WriteRepo<Certification> & { byWorkOrder(workOrderId: string): Promise<Certification | null> };
  invoices: WriteRepo<Invoice>;
  operators: ReadRepo<Operator>;
}
