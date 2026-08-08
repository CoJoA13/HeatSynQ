"use client";
import { useParams } from "next/navigation";
import { InvoiceDetail } from "./InvoiceDetail";

/** Thin wrapper — the `src/app/shipping/[id]/page.tsx` idiom (task-18-brief.md's exact
 *  instruction — copy the comment too). All the state lives in `InvoiceDetail`. */
export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Next reuses this route's component instance across /invoicing/A -> /invoicing/B (only the
  // param changes, no remount). Keying the body by id forces a fresh instance per invoice, so no
  // defaultValue-bound field or bulk-grid overlay can carry one invoice's unsaved text onto
  // another invoice's id — the exact HANDOFF §5.12 lesson (a Critical in Phase 2B) task-18-
  // brief.md calls out by name for this page specifically.
  return <InvoiceDetail key={id} id={id} />;
}
