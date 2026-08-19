import { NextResponse } from "next/server";
import { z } from "zod";
import { handle, requireUser, HttpError } from "@/server/http";
import { can } from "@/server/permissions";
import { prisma } from "@/server/db";
import { eligibleQuoteLines } from "@/server/quote-links";
import { parseDateOnly, todayDateOnly } from "@/lib/business-days";
import { orUndefined } from "../../orders/query";

const QUERY = z.object({
  customerId: z.string().min(1),
  partId: z.string().min(1),
  receivedDate: z.string().optional(),
}).strict();

/**
 * The entry UI's link-resolution preview (spec §5.2): every eligible quote line for one
 * customer + part as of a received date, in ruling 7's order, plus which one the save would
 * silently auto-resolve — shown before save, with re-pick/unlink offered against the same list.
 *
 * Gated `orders.view` OR `quotes.view` (the §5.15 reasoning — a read is gated by the SCREEN it
 * serves, not the module that owns the data — applied to the TWO screens this route now serves,
 * #101 / owner ruling 5, 2026-08-12): order entry's resolution preview (an entry operator
 * without `quotes.view` must still see which quote will price the line they are keying) AND the
 * part page's Active-quotes indicator (quote visibility on a parts screen is quotes-area
 * vocabulary, so `quotes.view` alone must also suffice).
 *
 * A preview on the bare client, never a guard: the save re-judges every pick inside its own
 * Serializable transaction (`resolveQuoteLinks`, orders.ts — the §5.14 SSI read), so a stale
 * answer here costs nothing, exactly like /api/orders/entry-defaults.
 */
export const GET = handle(async (req) => {
  const u = requireUser();
  if (!can(u, "orders", "view") && !can(u, "quotes", "view")) {
    throw new HttpError(403, "Requires orders.view or quotes.view");
  }
  const url = new URL(req.url);
  // Blank (present-but-empty, what an untouched form input serializes to) means absent — the
  // orders query.ts rule; the required pair then fails zod's own min(1) as a clean 400.
  const query = QUERY.parse({
    customerId: orUndefined(url.searchParams.get("customerId")) ?? "",
    partId: orUndefined(url.searchParams.get("partId")) ?? "",
    receivedDate: orUndefined(url.searchParams.get("receivedDate")),
  });

  // Absent = "not backdated yet" = today, the identical default createOrder itself applies —
  // so the preview and the eventual save agree (the entry-defaults precedent).
  let receivedDate: Date;
  try {
    receivedDate = query.receivedDate === undefined ? todayDateOnly() : parseDateOnly(query.receivedDate);
  } catch {
    throw new HttpError(400, `"${query.receivedDate}" is not a valid date (yyyy-mm-dd) for Received date`);
  }

  const candidates = await eligibleQuoteLines(prisma, {
    customerId: query.customerId, partId: query.partId, receivedDate,
  });
  // `[0]` IS the auto-resolution (resolveAutoLink's own definition) — derived from the same
  // list, so the preview's highlighted pick and the save's silent one can never disagree.
  return NextResponse.json({ candidates, autoLink: candidates[0] ?? null });
});
