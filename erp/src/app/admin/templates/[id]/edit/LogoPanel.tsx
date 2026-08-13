"use client";
// The logo panel (Phase 7 Task 17, spec §4.1/§5.5) — the one panel that isn't pure config, because
// the logo BYTES live on the draft version row, not in the config JSON: the config carries only the
// placement + width. So this panel does two separable things:
//   1. UPLOAD/CLEAR the bytes — a multipart POST/DELETE to /api/templates/[id]/logo (the Task 4
//      route that sniffs the magic bytes, caps at 512KB, and allow-lists PNG/JPEG). That write bumps
//      the draft's `updatedAt`, so on success we tell the orchestrator to refresh its save
//      precondition (`onLogoChanged`) — otherwise the next config save would 409 on a stale stamp.
//   2. PLACEMENT + WIDTH — plain config edits (`setLogoPlacement`/`setLogoWidth`/`clearLogoPlacement`),
//      saved with the rest of the config via the PATCH. The logo prints only when BOTH a placement is
//      chosen AND bytes are on file, so this panel makes both visible.
//
// The FormData fetch goes direct, not through `api()`: a multipart body needs the browser's own
// computed `multipart/form-data; boundary=...` Content-Type, and `api()` forces application/json
// (the `UserSignatureControl` / `AttachmentsSection` precedent).
import { useRef, useState } from "react";
import { ApiError } from "@/lib/fetcher";
import { LOGO_PLACEMENTS, type LogoPlacement, type TemplateConfig } from "@/lib/template-contracts";
import { clearLogoPlacement, setLogoPlacement, setLogoWidth } from "@/lib/template-editor";

const PLACEMENT_LABELS: Record<LogoPlacement, string> = {
  "header-left": "Header — left",
  "header-center": "Header — center",
  "header-right": "Header — right",
};

export function LogoPanel({ templateId, logoMimeType, config, apply, disabled, editTitle, onLogoChanged }: {
  templateId: string;
  logoMimeType: string | null;
  config: TemplateConfig;
  apply: (fn: (c: TemplateConfig) => TemplateConfig) => void;
  disabled: boolean;
  editTitle: string | undefined;
  onLogoChanged: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const path = `/api/templates/${templateId}/logo`;
  const logo = config.logo;

  async function readError(res: Response, fallback: string): Promise<never> {
    const body = await res.json().catch(() => ({}));
    throw new ApiError((body as { error?: string }).error ?? fallback, res.status);
  }

  async function onFileChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file, file.name);
      const res = await fetch(path, { method: "POST", body: form });
      if (!res.ok) await readError(res, `Upload failed (${res.status})`); // surfaces the route's sniff/size/MIME 400
      setError(null);
      await onLogoChanged(); // the upload bumped the draft's updatedAt — refresh the save precondition
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      // Reset so choosing the SAME file again still fires onChange (the signature-control precedent).
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removeBytes() {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok) await readError(res, `Clear failed (${res.status})`);
      setError(null);
      await onLogoChanged();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded border bg-white p-4">
      <h2 className="text-sm font-semibold">Logo</h2>
      <p className="mt-0.5 mb-3 text-xs text-slate-500">
        The logo prints only when an image is on file <em>and</em> a header placement is chosen. PNG or
        JPEG, up to 512&nbsp;KB.
      </p>

      {/* 1. The bytes */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="text-sm text-slate-700">
          {logoMimeType ? `Image on file (${logoMimeType})` : "No image uploaded"}
        </span>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg"
               disabled={disabled || busy} title={editTitle} onChange={onFileChosen}
               aria-label="Upload logo image" className="w-48 text-xs disabled:cursor-not-allowed" />
        {logoMimeType && (
          <button type="button" onClick={() => void removeBytes()} disabled={disabled || busy} title={editTitle}
                  className="text-xs text-red-600 underline disabled:cursor-not-allowed disabled:text-slate-400">
            Remove image
          </button>
        )}
      </div>

      {/* 2. Placement + width (config) */}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Placement</span>
          <select value={logo?.placement ?? "none"} disabled={disabled} title={editTitle} aria-label="Logo placement"
                  className="rounded border px-2 py-1 text-sm disabled:bg-slate-100"
                  onChange={(e) => {
                    const v = e.target.value;
                    apply((c) => (v === "none" ? clearLogoPlacement(c) : setLogoPlacement(c, v as LogoPlacement)));
                  }}>
            <option value="none">Not printed</option>
            {LOGO_PLACEMENTS.map((p) => <option key={p} value={p}>{PLACEMENT_LABELS[p]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-slate-600">Width (pt)</span>
          <input type="number" min={1} max={564} value={logo?.width ?? ""}
                 disabled={disabled || logo === null}
                 title={logo === null ? "Choose a placement first" : editTitle}
                 aria-label="Logo width"
                 onChange={(e) => {
                   const n = Number(e.target.value);
                   if (!Number.isNaN(n)) apply((c) => setLogoWidth(c, n));
                 }}
                 className="w-24 rounded border px-2 py-1 text-sm disabled:bg-slate-100" />
        </label>
      </div>

      {error && <p className="mt-2 text-xs text-red-700" role="alert">{error}</p>}
    </section>
  );
}
