"use client";
import { BOARD_COLUMNS, type ColumnKey, type ColumnState } from "@/lib/board-columns";

// Presentational only (#33's bounded slice): the column arrangement lives in the board page's
// state (src/app/page.tsx) — this file renders the show/reorder panel and reports clicks up.

type Props = {
  columns: ColumnState[];
  onToggleVisible: (key: ColumnKey) => void;
  onMove: (index: number, direction: -1 | 1) => void;
};

export function ColumnPicker({ columns, onToggleVisible, onMove }: Props) {
  return (
    <div className="mb-3 max-w-sm rounded border border-slate-300 bg-slate-50 p-3 text-sm">
      <div className="mb-2 font-medium">Show / reorder columns</div>
      {columns.map((c, i) => {
        const def = BOARD_COLUMNS.find((d) => d.key === c.key);
        if (!def) return null;
        return (
          <div key={c.key} className="flex items-center gap-2 border-b py-1 last:border-b-0">
            <input type="checkbox" checked={c.visible} onChange={() => onToggleVisible(c.key)} />
            <span className="flex-1">{def.label}</span>
            <button type="button" disabled={i === 0} onClick={() => onMove(i, -1)}
                    className="text-xs text-slate-600 disabled:text-slate-300">
              ↑
            </button>
            <button type="button" disabled={i === columns.length - 1} onClick={() => onMove(i, 1)}
                    className="text-xs text-slate-600 disabled:text-slate-300">
              ↓
            </button>
          </div>
        );
      })}
    </div>
  );
}
