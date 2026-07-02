import type { Repositories, ReadRepo, WriteRepo } from "@/lib/data/repositories";
import { buildSeed } from "@/lib/data/seed";
import { Counter } from "@/lib/logic/numbering";
import { Collection, genId, NOW, delay } from "./store";

type Opts = { latencyMs?: number; failRate?: number };

export function createMockRepositories(opts: Opts = {}): Repositories {
  const latency = opts.latencyMs ?? 250;
  const fail = opts.failRate ?? 0;
  const seed = buildSeed();
  const counter = new Counter(seed.counters);

  const numberPrefix: Record<string, string> = { quotes: "Q-", workOrders: "WO-", invoices: "INV-", certifications: "C-" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- approved: mock generic plumbing only (enforced everywhere else)
  function read<T extends { id: string }>(col: Collection<any>): ReadRepo<T> {
    return {
      async list() { await delay(latency, fail); return col.all() as T[]; },
      async get(id) { await delay(latency, fail); return col.byId(id) as T | null; },
    };
  }
  function write<T extends { id: string; version: number; createdAt: string; updatedAt: string; number?: string | null }>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- approved: mock generic plumbing only (enforced everywhere else)
    col: Collection<any>, key?: keyof typeof numberPrefix & string,
  ): WriteRepo<T> {
    return {
      ...read<T>(col),
      async create(input) {
        await delay(latency, fail);
        const id = genId(key ?? "id");
        const explicitNumber = "number" in (input as object);
        const numbered = key && numberPrefix[key] && !explicitNumber
          ? { number: counter.next(numberPrefix[key]) }
          : {};
        const item = { ...(input as object), ...numbered, id, createdAt: NOW, updatedAt: NOW, version: 0 } as T;
        return col.insert(item);
      },
      async update(id, patch, expectedVersion) {
        await delay(latency, fail);
        const cur = col.byId(id);
        if (!cur) throw new Error("Not found: " + id);
        if (cur.version !== expectedVersion) throw new Error("Version conflict");
        const next = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, version: cur.version + 1, updatedAt: NOW } as T;
        return col.replace(next);
      },
    };
  }

  const cols = {
    customers: new Collection(seed.customers),
    contacts: new Collection(seed.contacts),
    parts: new Collection(seed.parts),
    processMasters: new Collection(seed.processMasters),
    specifications: new Collection(seed.specifications),
    standards: new Collection(seed.standards),
    priceKeys: new Collection(seed.priceKeys),
    pricingRules: new Collection(seed.pricingRules),
    quotes: new Collection(seed.quotes),
    workOrders: new Collection(seed.workOrders),
    certifications: new Collection(seed.certifications),
    invoices: new Collection(seed.invoices),
    operators: new Collection(seed.operators),
    scheduleBlocks: new Collection(seed.scheduleBlocks),
    equipment: new Collection(seed.equipment),
    maintenance: new Collection(seed.maintenance),
  };

  return {
    customers: { ...read(cols.customers), async byId(ids) { await delay(latency, fail); return cols.customers.all().filter((c) => ids.includes(c.id)); } },
    contacts: { ...read(cols.contacts), async byCustomer(cid) { await delay(latency, fail); return cols.contacts.all().filter((c) => c.customerId === cid); } },
    parts: { ...write(cols.parts), async byCustomer(cid) { await delay(latency, fail); return cols.parts.all().filter((p) => p.customerId === cid); } },
    processMasters: read(cols.processMasters),
    specifications: read(cols.specifications),
    standards: read(cols.standards),
    priceKeys: read(cols.priceKeys),
    pricingRules: { ...read(cols.pricingRules), async byPriceKey(pk) { await delay(latency, fail); return cols.pricingRules.all().filter((r) => r.priceKeyId === pk); } },
    quotes: write(cols.quotes, "quotes"),
    workOrders: write(cols.workOrders, "workOrders"),
    certifications: { ...write(cols.certifications, "certifications"), async byWorkOrder(woId) { await delay(latency, fail); return cols.certifications.all().find((c) => c.workOrderId === woId) ?? null; } },
    invoices: write(cols.invoices, "invoices"),
    scheduleBlocks: write(cols.scheduleBlocks),
    equipment: write(cols.equipment),
    maintenance: write(cols.maintenance),
    operators: write(cols.operators),
    numbers: {
      async next(entity) { await delay(latency, fail); return counter.next(numberPrefix[entity]); },
    },
  } as Repositories;
}
