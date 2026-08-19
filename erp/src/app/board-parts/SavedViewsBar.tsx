"use client";

// Presentational only (#33's bounded slice): every piece of state and every handler stays in the
// board page (src/app/page.tsx) — this file receives values + callbacks as props and renders the
// views bar plus its save panel. Nothing here fetches, navigates, or owns a useState.

// Local mirror of src/server/saved-views.ts's SavedViewRow. `config` stays `unknown` — this file
// never trusts it directly, only through board-columns.ts's normalizers.
export type SavedViewRow = { id: string; name: string; config: unknown; isDefault: boolean; updatedAt: string };

type Props = {
  savedViews: SavedViewRow[];
  selectedViewId: string;
  saveOpen: boolean;
  saveName: string;
  saveDefault: boolean;
  /** True while a set-as-default PATCH is in flight — disables the checkbox so two clicks
   *  faster than the round trip cannot issue two unordered updates (#145). */
  settingDefault: boolean;
  onApplyView: (id: string) => void;
  onSetSelectedDefault: (isDefault: boolean) => void;
  onOpenSave: () => void;
  onDeleteView: () => void;
  onSaveNameChange: (name: string) => void;
  onSaveDefaultChange: (isDefault: boolean) => void;
  onSaveView: () => void;
  onCancelSave: () => void;
};

export function SavedViewsBar({
  savedViews, selectedViewId, saveOpen, saveName, saveDefault, settingDefault,
  onApplyView, onSetSelectedDefault, onOpenSave, onDeleteView,
  onSaveNameChange, onSaveDefaultChange, onSaveView, onCancelSave,
}: Props) {
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded border bg-white p-2 text-sm">
        <label className="flex items-center gap-1">
          View:
          <select value={selectedViewId} onChange={(e) => onApplyView(e.target.value)}
                  className="rounded border px-2 py-1">
            <option value="">Default board</option>
            {savedViews.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
        {selectedViewId && (
          <label className="flex items-center gap-1">
            <input type="checkbox"
                   checked={savedViews.find((v) => v.id === selectedViewId)?.isDefault ?? false}
                   disabled={settingDefault} title={settingDefault ? "Saving…" : undefined}
                   onChange={(e) => onSetSelectedDefault(e.target.checked)} />
            Set as default
          </label>
        )}
        <button onClick={onOpenSave} className="text-blue-700 underline">Save view</button>
        <button onClick={onDeleteView} disabled={!selectedViewId}
                className="text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
          Delete view
        </button>
      </div>

      {saveOpen && (
        <div className="mb-3 flex flex-wrap items-center gap-3 rounded border border-slate-300 bg-slate-50 p-3 text-sm">
          <input value={saveName} onChange={(e) => onSaveNameChange(e.target.value)}
                 placeholder="View name" className="rounded border px-2 py-1" />
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={saveDefault} onChange={(e) => onSaveDefaultChange(e.target.checked)} />
            Set as default
          </label>
          <button onClick={onSaveView} className="rounded bg-slate-800 px-3 py-1 text-white">Save</button>
          <button onClick={onCancelSave} className="text-slate-600">
            Cancel
          </button>
        </div>
      )}
    </>
  );
}
