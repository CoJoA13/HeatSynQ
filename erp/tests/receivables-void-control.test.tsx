import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OpenItemRow, closedPeriodTitle, type CustomerOpenItem } from "@/app/customers/[id]/ReceivablesSection";

// #174: a write-off whose own month is closed must render its Void DISABLED WITH THE REASON, never
// enabled-and-always-409ing (§5.16: disabled with the reason, never hidden). The server ships the
// verdict as `voidable`; this pins what the screen does with it.
//
// **This file exists because a brief was wrong.** Three task briefs on this branch and the last one
// asserted "there is no DOM test environment, so a .tsx change cannot be unit-tested", and
// implementers correctly reported the client half as unverifiable. Half true: `vitest.config.ts`
// sets `environment: "node"`, so there is no jsdom and no events — a CLICK cannot be tested. But
// INITIAL RENDER can, via `renderToStaticMarkup`, and four suites already did it
// (loads-section, backup-banner, practice-banner, setup-banner). `OpenItemRow` holds only
// `useState`, so it renders straight through. Reviewer-caught (#174 review, Minor 2).
//
// What is still genuinely out of reach: interaction, effects, and anything that needs a fetch to
// land. Those remain Playwright's.

const gate = (allowed: boolean, title?: string) => ({ allowed, disabled: !allowed, title });
const ALLOWED = gate(true);
const DENIED = gate(false, "Requires receivables.delete");

function row(voidable: boolean): CustomerOpenItem {
  return {
    kind: "INVOICE", id: "inv-1", documentNumber: "1001",
    date: "2026-07-01", dueDate: "2026-07-31",
    original: 1000, open: 600,   // still open on its own merits — the shape #174 is about
    writeOffs: [{ id: "wo-1", amount: 400, appliedDate: "2026-07-14", reason: "disputed", voidable }],
  };
}

const render = (item: CustomerOpenItem, voidGate: ReturnType<typeof gate>) =>
  renderToStaticMarkup(
    <OpenItemRow item={item} invoices={[item]} applyGate={ALLOWED} writeOffGate={ALLOWED}
                 voidGate={voidGate} onApplied={() => {}} />,
  );

/** The one Void button's opening tag, so `disabled`/`title` are read off the control itself rather
 *  than off any attribute anywhere in the row. */
function voidButtonTag(html: string): string {
  const at = html.indexOf(">Void<");
  expect(at).toBeGreaterThan(-1);          // the control is RENDERED, never hidden (§5.16)
  return html.slice(html.lastIndexOf("<button", at), at + 1);
}

/**
 * Is the button REALLY disabled — the attribute, not the word?
 *
 * A substring check for "disabled" is vacuous here and the first draft of this file used one. The
 * button's Tailwind classes are `disabled:cursor-not-allowed disabled:text-slate-400`, so the word
 * is in every render, enabled or not: `toContain("disabled")` passes on the class attribute alone
 * and would have gone green with the feature deleted. React SSR emits a true boolean attribute as
 * `disabled=""`, which is what this matches. The enabled-case assertion caught it — which is the
 * argument for always writing the negative case beside the positive one.
 */
const isDisabled = (tag: string) => /\sdisabled=""/.test(tag);

describe("the Void control on a closed-month write-off (#174)", () => {
  it("renders enabled when the write-off's month is still open", () => {
    const tag = voidButtonTag(render(row(true), ALLOWED));
    expect(isDisabled(tag)).toBe(false);
    expect(tag).not.toContain("accounting period");
  });

  it("renders DISABLED, with the reason, when the month is closed", () => {
    const tag = voidButtonTag(render(row(false), ALLOWED));
    expect(isDisabled(tag)).toBe(true);
    // The exact sentence `assertPeriodOpen` throws — so the tooltip and the 409 agree.
    expect(tag).toContain(closedPeriodTitle(row(false).writeOffs[0]));
  });

  // The ladder: BOTH reasons apply at once. Permission must win, because the route runs
  // `mustCan(…, "receivables", "delete")` BEFORE `voidApplication`, so a 403 is what a click would
  // actually have produced — naming the closed period there would send the operator to reopen a
  // month that would not have helped them.
  it("names the PERMISSION when both blockers apply, because that is what a click would hit", () => {
    const tag = voidButtonTag(render(row(false), DENIED));
    expect(isDisabled(tag)).toBe(true);
    expect(tag).toContain("Requires receivables.delete");
    expect(tag).not.toContain("accounting period");
  });

  it("names the permission when only the permission is missing", () => {
    const tag = voidButtonTag(render(row(true), DENIED));
    expect(isDisabled(tag)).toBe(true);
    expect(tag).toContain("Requires receivables.delete");
  });
});
