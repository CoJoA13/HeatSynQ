export class Collection<T extends { id: string; version: number; createdAt: string; updatedAt: string }> {
  private items: Map<string, T>;
  constructor(seed: T[]) { this.items = new Map(seed.map((i) => [i.id, i])); }
  all(): T[] { return [...this.items.values()]; }
  byId(id: string): T | null { return this.items.get(id) ?? null; }
  insert(item: T): T { this.items.set(item.id, item); return item; }
  replace(item: T): T { this.items.set(item.id, item); return item; }
}

let counter = 0;
export function genId(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36)}`;
}

export const NOW = "2026-06-30T12:00:00.000Z"; // fixed mock clock (no Date.now in deterministic tests)
export async function delay(ms: number, failRate = 0): Promise<void> {
  if (failRate > 0 && hashFail(counter, failRate)) throw new Error("Simulated network error");
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}
function hashFail(seed: number, rate: number): boolean {
  return (seed % 100) / 100 < rate;
}
