"use client";
import { useParams } from "next/navigation";
import { BatchDetail } from "./BatchDetail";

/** Thin wrapper — the `src/app/invoicing/[id]/page.tsx` idiom. All the state lives in
 *  `BatchDetail`. `key={id}` forces a fresh instance per batch id across a same-route
 *  navigation (Next reuses the route component instance across /receivables/batches/A ->
 *  /receivables/batches/B, only the param changes) — the HANDOFF §5.12 lesson (a Critical in
 *  Phase 2B) InvoiceDetailPage carries forward for exactly this reason. */
export default function BatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <BatchDetail key={id} id={id} />;
}
