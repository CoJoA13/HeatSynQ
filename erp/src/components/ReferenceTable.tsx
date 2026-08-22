"use client";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/fetcher";
import { useLatest } from "@/lib/use-latest";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { invalidateSetupBanner } from "@/components/SetupBanner";
import { PasteGrid } from "@/components/PasteGrid";
import { REFERENCE_LABELS, REFERENCE_EXTRA_FIELDS, type ReferenceKind } from "@/lib/reference-constants";
import { linksFrom, nameKey } from "@/lib/reference-links";
import { gate } from "@/lib/permission-ui";
import { usePermissions } from "@/lib/use-permissions";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";

type Row = { id: string; name: string; active: boolean } & Record<string, unknown>;

// The reference kinds the setup banner's readiness rollup counts: glAccount feeds the `chart`
// step (src/server/order-entry-readiness.ts), the other four feed `references`
// (src/server/install-readiness.ts). Hardcoded here rather than imported because a client
// component must not import from src/server/** (CLAUDE.md). A create or delete on any other kind
// moves no readiness signal, so it skips the invalidation — each refetch costs the server an
// argon2 verify (#110).
const READINESS_COUNTED_KINDS: ReadonlySet<string> = new Set([
  "glAccount", "terms", "carrier", "containerType", "material",
]);

export function ReferenceTable({ kind }: { kind: ReferenceKind }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [openHistory, setOpenHistory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [blocked, setBlocked] = useState<{ row: Row; list: Blocker[] } | null>(null);
  const { permissions: perms, error: permsError } = usePermissions();
  const labels = REFERENCE_LABELS[kind];
  const extras = REFERENCE_EXTRA_FIELDS[kind];
  const refLinks = linksFrom(kind);
  const [refOptions, setRefOptions] = useState<Record<string, { id: string; name: string }[]>>({});
  // Gated per the permission each route actually enforces, not one blanket key: add/paste hit
  // POST routes requiring admin.create, delete hits a DELETE route requiring admin.delete, and
  // only the Active-toggle PUT requires admin.edit (src/app/api/admin/reference/[kind]/route.ts,
  // .../paste/route.ts, .../[id]/route.ts).
  const canCreate = gate(perms, "admin.create");
  const canDelete = gate(perms, "admin.delete");
  const canEdit = gate(perms, "admin.edit");

  // Named `latest`, not `gate` — this file also imports `gate` from permission-ui for the
  // held-permission checks below, and shadowing that binding with the stale-response gate would
  // break every `gate(perms, ...)` call in this component (the customers/page.tsx hazard).
  const latest = useLatest();
  // F7 (customers/page.tsx precedent): ticket-gated on BOTH paths — a rapid Show-inactive
  // toggle, or a handler refresh racing one, can land out of order (inactive rows painted under
  // an unchecked box; a just-flipped flag visually reverting), and a superseded request's
  // rejection must not overwrite fresh rows with a stale failure either. Cross-KIND safety is
  // NOT this gate's job: it rests on the mount site remounting the component per kind via
  // `key={kind}` (admin/reference/page.tsx) — a standing requirement for any future mount site.
  const load = useCallback(async () => {
    const t = latest.next();
    let data: Row[];
    try {
      data = await api<Row[]>(`/api/admin/reference/${kind}${showInactive ? "?includeInactive=1" : ""}`);
    } catch (e) {
      if (latest.isCurrent(t)) setError((e as Error).message);
      return;
    }
    if (!latest.isCurrent(t)) return;
    setRows(data);
  }, [kind, showInactive, latest]);
  useEffect(() => { void load(); }, [load]);

  // A stale blocker list from another kind's row must not linger on screen once the admin
  // switches tables.
  useEffect(() => { setBlocked(null); }, [kind]);

  useEffect(() => {
    if (!refLinks.length) return;
    Promise.all(refLinks.map(async (l) => {
      // /api/picklists/<kind> deliberately 404s for glAccount — it stays off the route every
      // signed-in user can reach, but paymentType.glAccountId IS a valid FK target here. This
      // grid is itself an admin.view-gated screen (its own row listing above already calls
      // /api/admin/reference/${kind}), so every ref-link's options are fetched from that same
      // admin endpoint rather than the narrower picklist route — one endpoint choice, no
      // per-link special-casing, and it sidesteps the 404 without widening PICKLIST_KINDS.
      // includeInactive so an already-assigned inactive target still renders by name.
      const opts = await api<{ id: string; name: string }[]>(
        `/api/admin/reference/${l.targetKind}?includeInactive=1`);
      return [l.column, opts] as const;
    }))
      .then((pairs) => setRefOptions(Object.fromEntries(pairs)))
      // No .catch(() => {}) here: a failed fetch that renders an empty dropdown is
      // indistinguishable from a shop that has configured nothing. Say so instead.
      .catch((e) => setError(`Could not load pick lists: ${(e as Error).message}`));
    // refLinks is recomputed every render (a fresh array from linksFrom), so it deliberately
    // isn't a dependency here — that would re-run this effect on every render instead of once
    // per kind change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  async function add() {
    try {
      await api(`/api/admin/reference/${kind}`, { method: "POST", body: JSON.stringify(buildPayload()) });
      // #110: a create on a counted kind can complete a readiness step — fired the instant the
      // POST resolves, before load() (the #124/#131 ordering).
      if (READINESS_COUNTED_KINDS.has(kind)) invalidateSetupBanner();
      // #158 — a CREATE can rewrite ANOTHER row's history. `normalizeEndingStatementDefaultOnCreate`
      // (reference.ts) demotes the current default through `auditedUpdate` when the new row is
      // flagged, so the demoted row's own open panel goes stale on a change it did not make. The
      // first pass wired only `toggleFlag`, whose demotion is the same write reached the other way
      // (Codex P2 on PR #187). Success path, before load (#124/#131); the signal is global, so the
      // demoted row's panel refreshes wherever it is mounted.
      invalidateHistory();
      setDraft({}); setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  // `draft` is a plain string map (every input writes a string). Three extra-field kinds need
  // massaging before that map is a valid request body:
  //   - "number" (Terms' netDays/discountDays, Task 4): a real `z.number().int()` server-side,
  //     not string-accepting like decimalField — so it needs converting to an actual JS number,
  //     the requestDaysOverride precedent (customers/[id]/page.tsx).
  //   - "decimal" (Terms' discountPercent, Task 4 fix round 1): IS string-accepting
  //     (`decimalField`), so no numeric conversion — but it also isn't `""`-accepting: an empty
  //     string fails decimalField's digit-pattern regex with a cryptic 400 instead of being
  //     treated as "no value." A user who types a discount percent and then clears the box must
  //     get "no discount," not that regex error.
  //   - "boolean" (endingStatement.isDefault, Phase 6): the Add-row checkbox writes the strings
  //     "true"/"" into draft; "true" becomes a real `true` here, unchecked drops the key so the
  //     column default applies — a checkbox has no failed-parse case, so nothing is left behind
  //     for the server to name.
  // All three drop a blank input entirely rather than send `""`, so the field's own `.optional()`
  // applies (and, for netDays, so the column's `@default(30)` applies) instead of a 400. Plain
  // "text" fields (glAccount.description, commentSnippet/specification.text) are deliberately left
  // untouched here — `""` is a legitimate stored value for genuine free text, not "no value."
  // A "number" value that fails to parse as finite is left as the original string so the server's
  // own "Expected number, received string" explains it, rather than silently becoming `null` (an
  // "abc" input's `Number()` is `NaN`, which `JSON.stringify` turns into `null` if sent as-is).
  function buildPayload(): Record<string, unknown> {
    const payload: Record<string, unknown> = { ...draft };
    for (const f of extras) {
      if (f.kind !== "number" && f.kind !== "decimal" && f.kind !== "boolean") continue;
      const raw = draft[f.key];
      if (raw === undefined || raw.trim() === "") { delete payload[f.key]; continue; }
      if (f.kind === "number") {
        const n = Number(raw);
        payload[f.key] = Number.isFinite(n) ? n : raw;
      }
      if (f.kind === "boolean") payload[f.key] = raw === "true";
      // "decimal": decimalField accepts the raw string as-is once it isn't blank.
    }
    return payload;
  }

  // One PUT-a-flag helper for the Active column and every "boolean" extra column (Phase 6:
  // endingStatement.isDefault — flipping it ON is how an existing row is promoted to the default;
  // the service demotes the old one, and flipping it OFF leaves the kind defaultless).
  async function toggleFlag(row: Row, key: string) {
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, {
        method: "PUT", body: JSON.stringify({ [key]: !row[key] }),
      });
      // #158 — success path, before the follow-up load (#124/#131). The row stays on screen after
      // a toggle, so its open History panel (mounted per-row, right beside this checkbox) would
      // otherwise keep showing the pre-toggle history. Flipping `isDefault` ON also demotes
      // another row; the signal is global, so that row's panel refreshes too.
      invalidateHistory();
      // Retiring a row via the Active toggle is the sanctioned alternative to deleting it (§4.2)
      // — it must not leave a blocker panel from an earlier failed delete attempt on screen.
      setError(null); setBlocked(null); await load();
    } catch (e) { setError((e as Error).message); }
  }

  async function remove(row: Row) {
    if (!confirm(`Delete ${labels.singular.toLowerCase()} "${row.name}"?`)) return;
    try {
      await api(`/api/admin/reference/${kind}/${row.id}`, { method: "DELETE" });
      // #110: deleting the last row of a counted kind can UN-complete a readiness step.
      if (READINESS_COUNTED_KINDS.has(kind)) invalidateSetupBanner();
      // #158 — the soft-delete has COMMITTED, so the row's own delete entry exists and its open
      // panel is showing pre-delete history. `load()` below swallows a GET failure and returns, so
      // on a failed reload the deleted row and its stale panel both stay on screen (Codex P2 on
      // PR #187). Signalling here, before the load, means the panel is right even when the reload
      // is not. This is the THIRD mutation in this file; the previous round wired the two it was
      // asked about instead of sweeping all three.
      invalidateHistory();
      setError(null); setBlocked(null); await load();
    } catch (e) {
      // A refusal is not a dead end here: say what is blocking, and make the list exportable.
      // Only the delete guard's own 400 means there IS a blocker list to fetch — a 500 or a
      // network failure is a genuine error, not a refusal, and fetching (and likely finding no)
      // blockers for it would misreport a real failure as "N records use it".
      if (e instanceof ApiError && e.status === 400) {
        try {
          const list = await api<Blocker[]>(`/api/admin/reference/${kind}/${row.id}/blockers`);
          if (list.length) { setBlocked({ row, list }); setError(null); return; }
        } catch (listErr) {
          // The delete WAS correctly refused, but the follow-up fetch for WHAT is blocking it
          // failed too (network, 500). A silently empty list here is indistinguishable from
          // "nothing blocks it" and recreates the undiscoverable dead end this feature exists to
          // remove — say plainly that the list is missing, not empty, so the user can retry.
          setError(`${(e as Error).message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError((e as Error).message);
    }
  }

  return (
    <div>
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      <div className="mb-2 flex items-center gap-3">
        <label className="flex items-center gap-1 text-sm">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          Show inactive
        </label>
        <a href={`/api/admin/reference/${kind}/export${showInactive ? "?includeInactive=1" : ""}`}
           className="text-sm text-blue-700 underline">
          Export to Excel
        </a>
        <button onClick={() => setPasting((p) => !p)} disabled={canCreate.disabled} title={canCreate.title}
                className="text-sm text-blue-700 underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline">
          {pasting ? "Hide paste entry" : "Paste from spreadsheet"}
        </button>
      </div>
      <table className="w-full rounded border bg-white text-sm">
        <thead>
          <tr className="border-b text-left">
            <th className="p-2">{labels.nameLabel}</th>
            {extras.map((f) => <th key={f.key} className="p-2">{f.label}</th>)}
            <th className="p-2">Active</th><th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td className="p-2">{r.name}</td>
              {extras.map((f) => (
                <td key={f.key} className="p-2">
                  {f.kind === "boolean" ? (
                    // Interactive like the Active checkbox one cell over — same PUT, same gate.
                    <input type="checkbox" checked={Boolean(r[f.key])} disabled={canEdit.disabled}
                           title={canEdit.title} onChange={() => toggleFlag(r, f.key)} />
                  ) : (
                    String(r[f.kind === "ref" ? nameKey(f.key) : f.key] ?? "")
                  )}
                </td>
              ))}
              <td className="p-2">
                <input type="checkbox" checked={r.active} disabled={canEdit.disabled} title={canEdit.title}
                       onChange={() => toggleFlag(r, "active")} />
              </td>
              <td className="p-2 text-right">
                <button onClick={() => setOpenHistory(openHistory === r.id ? null : r.id)}
                        className="mr-3 text-xs text-slate-600">history</button>
                <button onClick={() => remove(r)} disabled={canDelete.disabled} title={canDelete.title}
                        className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
                  delete
                </button>
                {openHistory === r.id && <HistoryPanel entity={kind} entityId={r.id} />}
              </td>
            </tr>
          ))}
          <tr className="border-t bg-slate-50">
            <td className="p-2">
              <input value={draft.name ?? ""} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                     placeholder={labels.nameLabel} className="w-full rounded border px-2 py-1" />
            </td>
            {extras.map((f) => (
              <td key={f.key} className="p-2">
                {f.kind === "ref" ? (
                  <select value={draft[nameKey(f.key)] ?? ""}
                          onChange={(e) => setDraft({ ...draft, [nameKey(f.key)]: e.target.value })}
                          className="w-full rounded border px-2 py-1">
                    <option value="">—</option>
                    {(refOptions[f.key] ?? []).map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
                  </select>
                ) : f.kind === "boolean" ? (
                  <>
                    {/* draft is a string map — the checkbox round-trips through "true"/"" and
                        buildPayload() turns "true" into a real boolean (unchecked drops the key). */}
                    <input type="checkbox" checked={draft[f.key] === "true"}
                           onChange={(e) => setDraft({ ...draft, [f.key]: e.target.checked ? "true" : "" })} />
                    {f.hint && <span className="mt-0.5 block text-xs text-slate-400">{f.hint}</span>}
                  </>
                ) : (
                  <>
                    <input value={draft[f.key] ?? ""}
                           inputMode={f.kind === "number" ? "numeric" : f.kind === "decimal" ? "decimal" : undefined}
                           onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                           placeholder={f.label} className="w-full rounded border px-2 py-1" />
                    {f.hint && <span className="mt-0.5 block text-xs text-slate-400">{f.hint}</span>}
                  </>
                )}
              </td>
            ))}
            <td />
            <td className="p-2 text-right">
              <button onClick={add} disabled={canCreate.disabled} title={canCreate.title}
                      className="rounded bg-slate-800 px-3 py-1 text-white disabled:cursor-not-allowed disabled:bg-slate-400">
                Add
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      {blocked && (
        <BlockerPanel
          label={labels.singular.toLowerCase()}
          rowName={blocked.row.name}
          list={blocked.list}
          exportHref={`/api/admin/reference/${kind}/${blocked.row.id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
      )}
      {pasting && (
        <PasteGrid
          endpoint={`/api/admin/reference/${kind}/paste`}
          columns={[REFERENCE_LABELS[kind].nameLabel, ...REFERENCE_EXTRA_FIELDS[kind].map((f) => f.label)]}
          onDone={() => {
            // #110: PasteGrid fires onDone only after a successful POST — same rule as add().
            if (READINESS_COUNTED_KINDS.has(kind)) invalidateSetupBanner();
            // #158: and a pasted batch creates rows the same way `add()` does, so it can demote an
            // existing default just as invisibly.
            invalidateHistory();
            void load();
          }}
        />
      )}
    </div>
  );
}
