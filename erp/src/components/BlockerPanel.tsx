// Shared "why can't I delete this" panel. First lived only in ReferenceTable.tsx; part-fields
// (Task 13) is the second screen needing the identical shape (linked blocker rows + an Excel
// export link), which is the brief's stated ceiling for extracting rather than copying a second
// time — see CLAUDE.md's "blocked deletes need discoverable blockers" note. A refused delete is
// not a dead end: this says plainly what is using the row, links to each one, and offers an
// export instead of leaving the admin to guess (the Visual Shop trap this app is escaping).
export type Blocker = { entityLabel: string; name: string; id: string; href: string | null };

export function BlockerPanel({
  label, rowName, list, exportHref, onDismiss, action = "delete",
}: {
  /** Lowercase singular noun for the row being blocked, e.g. "material" or "part field". */
  label: string;
  rowName: string;
  list: Blocker[];
  exportHref: string;
  onDismiss: () => void;
  /** Present-tense verb phrase for the blocked action, e.g. "delete" or "change the type of".
   *  Defaults to "delete" — the panel's original and still most common caller. */
  action?: string;
}) {
  return (
    <div className="mt-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm">
      <div className="mb-2 font-medium">
        Cannot {action} {label} “{rowName}” — {list.length} record(s) use it:
      </div>
      <ul className="mb-2 space-y-1">
        {list.map((b) => (
          <li key={`${b.entityLabel}-${b.id}`}>
            <span className="text-slate-500">{b.entityLabel}</span>{" "}
            {b.href ? <a href={b.href} className="text-blue-700 underline">{b.name}</a> : <span>{b.name}</span>}
          </li>
        ))}
      </ul>
      <div className="flex gap-3">
        <a href={exportHref} className="text-blue-700 underline">Export list to Excel</a>
        <button onClick={onDismiss} className="text-slate-600">dismiss</button>
      </div>
    </div>
  );
}
