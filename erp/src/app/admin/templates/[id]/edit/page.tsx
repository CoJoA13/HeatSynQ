"use client";
// /admin/templates/[id]/edit — the structured template editor (Phase 7 Task 17, spec §5.5). A thin
// client wrapper: it reads the template id from the route and hands it to the orchestrator, which
// loads the draft config and renders the contract-driven panels. Client component against the
// guarded API (the templates-admin list page precedent) — no server-side requireUser needed here.
import { useParams } from "next/navigation";
import { TemplateEditor } from "./TemplateEditor";

export default function TemplateEditPage() {
  const { id } = useParams<{ id: string }>();
  // §5.12 remount idiom (every detail page's `key={id}`): keying the editor by the route id forces
  // a fresh instance on /edit/[A]→/edit/[B], so B never inherits A's stale config/dirty/conflict
  // state or its updatedAt save token — a Save after navigation would otherwise target B with A's
  // token and config. All editor state lives inside TemplateEditor, so the key is the whole fix.
  return <TemplateEditor key={id} templateId={id} />;
}
