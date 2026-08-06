"use client";
import { useParams } from "next/navigation";
import { CertDetail } from "./CertDetail";

/** Thin wrapper — the `shipping/[id]/page.tsx` precedent. Next reuses this route's component
 *  instance across /certs/A -> /certs/B (only the param changes, no remount). Keying the body by
 *  id forces a fresh instance per certification, so no draft readings grid or notes field can
 *  carry one cert's unsaved text onto another's id — the HANDOFF §5.12 lesson (a Critical in
 *  Phase 2B) task-16-brief.md calls out by name for this page. */
export default function CertDetailPage() {
  const { id } = useParams<{ id: string }>();
  return <CertDetail key={id} id={id} />;
}
