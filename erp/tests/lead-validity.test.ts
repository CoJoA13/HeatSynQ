import { describe, it, expect } from "vitest";
import { resolveLeadValidity } from "@/lib/lead-validity";

// Fix-wave R4 finding 9. Only the LEAD line's part is checked for process steps (spec §11), and
// the check is an async fetch. Two things could make a report land against the wrong line:
//
//   1. The card that fired the fetch is UNMOUNTED before it resolves — the line was removed, or an
//      earlier removal promoted a different card to lead. `useLatest`'s gate is per-card, so an
//      unmounted card's in-flight ticket was still "current" from its own gate's point of view;
//      the fix bumps that gate in the effect's cleanup (OrderLineCard.tsx).
//   2. The card survives but is no longer the lead. Nothing about a per-card gate can see that.
//
// This is the second guard, and the one that is testable without a component harness (vitest runs
// `environment: "node"`): the parent keys the report by the line id it came from and reads it only
// while that id is still the lead. Belt and braces — either guard alone closes the common case,
// and the failure mode they close is Save being enabled or blocked on a verdict about a part the
// operator is no longer ordering.

describe("resolveLeadValidity", () => {
  it("is unknown (null) before any report has arrived", () => {
    expect(resolveLeadValidity(null, "line-1")).toBeNull();
  });

  it.each([[true], [false]])("passes through the current lead's own verdict (%s)", (ok) => {
    expect(resolveLeadValidity({ lineId: "line-1", ok }, "line-1")).toBe(ok);
  });

  // The finding's own shape: line-1 was the lead, its check was still in flight when the operator
  // removed it, and it resolves afterwards. Its verdict describes a part that is no longer on the
  // order's lead position — reading it would block (or unblock) Save on the wrong part.
  it("ignores a report from a line that is no longer the lead", () => {
    expect(resolveLeadValidity({ lineId: "line-1", ok: false }, "line-2")).toBeNull();
    expect(resolveLeadValidity({ lineId: "line-1", ok: true }, "line-2")).toBeNull();
  });

  it("ignores every report once there is no lead line at all", () => {
    expect(resolveLeadValidity({ lineId: "line-1", ok: false }, null)).toBeNull();
  });

  // "Unknown" is a real verdict the card reports (a failed fetch, or no processes.view) and it
  // must stay null rather than collapsing to false — it never blocks Save on its own.
  it("keeps an unknown verdict from the current lead as unknown", () => {
    expect(resolveLeadValidity({ lineId: "line-1", ok: null }, "line-1")).toBeNull();
  });
});
