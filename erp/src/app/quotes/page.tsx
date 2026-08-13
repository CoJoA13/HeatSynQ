"use client";
import { Quotes } from "./Quotes";

/** Thin wrapper — the `src/app/receivables/page.tsx` idiom. All the state lives in `Quotes`.
 *  Area gating follows the house pattern for client pages (CLAUDE.md "Any server-rendered page
 *  that fetches data must call requireUser itself" — this page fetches nothing server-side):
 *  every API it calls is `quotes.view`-guarded, the Shell nav hides the entry without the area,
 *  and a user reaching the URL directly sees the 403 in the page's own error banner. */
export default function QuotesPage() {
  return <Quotes />;
}
