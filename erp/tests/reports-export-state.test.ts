import { describe, it, expect } from "vitest";
import { exportState } from "@/lib/report-export-state";

// Phase 8A Codex fixes 5 & 6: the one rule every /reports screen uses to decide whether its
// "Export to Excel" link is live (screen==export) and whether its table is showing stale data.
// `appliedQuery` is the query of the CURRENTLY-DISPLAYED result, or `null` until the FIRST success.

describe("exportState — Export readiness (Codex fixes 5 & 6)", () => {
  it("is NOT exportable before any successful load — the failed-initial-load case (fix 6)", () => {
    // The screens flip `loaded` true even on a FAILED fetch, and an appliedQuery initialized to ""
    // would equal the default empty query — which is exactly what wrongly enabled Export on a result
    // that never loaded. The `null` sentinel keeps Export inert until a load actually succeeds.
    expect(exportState(null, "")).toEqual({ exportable: false, showingStale: false });
    expect(exportState(null, "from=2026-01-01")).toEqual({ exportable: false, showingStale: false });
  });

  it("is exportable and not stale right after a successful load whose filters still match", () => {
    expect(exportState("", "")).toEqual({ exportable: true, showingStale: false });
    expect(exportState("groupBy=customer", "groupBy=customer"))
      .toEqual({ exportable: true, showingStale: false });
  });

  it("stays exportable but marks stale when the filters have moved past the displayed result (fix 5)", () => {
    // A slow or FAILED reload: the table still shows the last successful data, so Export stays pinned
    // to THAT data (exportable) and the screen flags itself stale until the reload lands — the export
    // file and the on-screen table can never disagree.
    expect(exportState("from=2026-01-01", "from=2026-02-01"))
      .toEqual({ exportable: true, showingStale: true });
    expect(exportState("", "customerId=abc")).toEqual({ exportable: true, showingStale: true });
  });
});
