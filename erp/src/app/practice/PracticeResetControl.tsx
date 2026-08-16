"use client";
import { useState } from "react";
import { api } from "@/lib/fetcher";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";

// The practice-only "Reset practice data" control (Phase 8B §5.3). Rendered only in practice mode
// (its parent server page decides that). The reset route is fully guarded (admin + practiceMode +
// the in-request db-identity re-check), so this control is UX only — a mis-click on production would
// be refused server-side regardless.
export function PracticeResetControl() {
  // The reset route requires admin.edit; the banner links every signed-in operator here, so disable
  // the control (rather than let it deterministically 403) for anyone lacking it (Codex).
  const { permissions } = usePermissions();
  const editGate = gate(permissions, "admin.edit");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function reset() {
    if (!window.confirm(
      "Reset ALL practice data to the demo baseline? Everything entered in the practice copy is permanently erased and replaced with the sample data.",
    )) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api<{ ok: boolean }>("/api/practice/reset", { method: "POST", body: "{}" });
      // The reset truncated the current session + user rows and recreated admin/admin, so the shell
      // now holds stale auth — the next request would 401. Send the user to sign in again with the
      // reset credentials (Codex). A full navigation, since the session no longer exists server-side.
      setMessage("Practice data was reset. Signing you out — sign back in with admin / admin.");
      setTimeout(() => {
        window.location.href = "/login";
      }, 1500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-xl rounded border border-amber-300 bg-amber-50 p-4">
      <p className="mb-3 text-sm text-amber-900">
        Reset the practice database to a fresh demo baseline. Everything entered here is permanently
        erased and replaced with the sample data. This has no effect on the production system.
      </p>
      {error && <p className="mb-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      {message && <p className="mb-2 rounded bg-green-50 p-2 text-sm text-green-700">{message}</p>}
      <button
        type="button"
        disabled={busy || !editGate.allowed}
        title={editGate.allowed ? undefined : editGate.title}
        onClick={() => void reset()}
        className="rounded bg-red-700 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? "Resetting…" : "Reset practice data"}
      </button>
    </div>
  );
}
