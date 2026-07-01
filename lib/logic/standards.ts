import type { Standard } from "@/lib/domain";

/** Review is due on or before `asOf` — the boundary instant counts as due. */
export function isReviewDue(standard: Standard, asOf: string): boolean {
  return new Date(standard.nextReviewAt).getTime() <= new Date(asOf).getTime();
}
