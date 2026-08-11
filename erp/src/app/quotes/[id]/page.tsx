"use client";
import { useParams } from "next/navigation";
import { QuoteDetail } from "./QuoteDetail";

/** Thin wrapper — the `src/app/invoicing/[id]/page.tsx` idiom. All the state lives in
 *  `QuoteDetail`. */
export default function QuoteDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Next reuses this route's component instance across /quotes/A -> /quotes/B (only the param
  // changes, no remount). Keying the body by id forces a fresh instance per quote, so no
  // form-bound field can carry one quote's unsaved draft onto another quote's id — the HANDOFF
  // §5.12 lesson every sibling detail page carries.
  return <QuoteDetail key={id} id={id} />;
}
