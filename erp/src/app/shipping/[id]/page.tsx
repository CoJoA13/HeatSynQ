"use client";
import { useParams } from "next/navigation";
import { ShipmentDetail } from "./ShipmentDetail";

/** Thin wrapper — the `parts/[id]/page.tsx` / `customers/[id]/page.tsx` precedent. All the state
 *  lives in `ShipmentDetail`, colocated in its own file per task-14-brief.md's file list rather
 *  than inlined here the way the parts/customers pages do it, since this page's per-order panels
 *  (`ShipmentOrderPanel.tsx`) are already a second sibling file — keeping the top-level page a
 *  bare id-to-component handoff keeps that split legible. */
export default function ShipmentDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Next reuses this route's component instance across /shipping/A -> /shipping/B (only the
  // param changes, no remount). Keying the body by id forces a fresh instance per shipment, so no
  // defaultValue-bound field or bulk-grid overlay can carry one shipment's unsaved text onto
  // another shipment's id — the exact HANDOFF §5.12 lesson (a Critical in Phase 2B) task-14-
  // brief.md calls out by name for this page specifically.
  return <ShipmentDetail key={id} id={id} />;
}
