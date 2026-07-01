export function formatNumber(prefix: string, seq: number): string {
  return `${prefix}${seq}`;
}

export class Counter {
  private seqs: Record<string, number>;
  constructor(initial: Record<string, number> = {}) { this.seqs = { ...initial }; }
  next(prefix: string): string {
    const n = (this.seqs[prefix] ?? 0) + 1;
    this.seqs[prefix] = n;
    return formatNumber(prefix, n);
  }
}
