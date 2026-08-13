"use client";
// /admin/templates/[id]/edit — the structured template editor (Phase 7 Task 17, spec §5.5). A thin
// client wrapper: it reads the template id from the route and hands it to the orchestrator, which
// loads the draft config and renders the contract-driven panels. Client component against the
// guarded API (the templates-admin list page precedent) — no server-side requireUser needed here.
import { useParams } from "next/navigation";
import { TemplateEditor } from "./TemplateEditor";

export default function TemplateEditPage() {
  const { id } = useParams<{ id: string }>();
  return <TemplateEditor templateId={id} />;
}
