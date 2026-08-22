// The dev-DB pre-flight (#167a). Pure policy: given the ambient state `db-fixtures.ts`'s
// `preflight` command reads out of the dev database, decide whether the suite can run at all —
// returning the reason rather than throwing, the `warmupRefusal`/`retryRefusal` shape, so
// `tests/e2e-harness.test.ts` can pin the policy and `run.mjs` owns the refusal.
//
// WHY A REFUSAL AND NOT A FIX. Almost every ambient-state assertion in the suite can be scoped to
// the flow's own fixtures, and #167a scopes the two that could be. `close-month-end`'s cannot:
// `unpostedBatchCount` and the continuity `variance` are GLOBAL figures for the month — that is
// what a month-end close IS — and a flow that only looked at its own rows would no longer be
// testing the close. The flow also refuses, correctly, to post a batch it did not create ("never
// touch a stranger's dev-DB row"), so it cannot tidy the database into a state it likes either.
// What is left is to say so up front: a named refusal in one second beats flow 20 failing on an
// opaque number after eight minutes.
//
// WHY THESE THREE AND NOTHING ELSE. Each one is an assertion `close-month-end.mjs` itself makes
// about the whole plant, verbatim — not a guess at what "clean" means:
//
//   * a `ClosePeriod` already covering the target month — the flow's own pre-flight guard, hoisted
//     out of minute eight (`close-month-end.mjs`, "Refusing to run: a ClosePeriod already exists");
//   * an OPEN receipt batch carrying a payment dated in the target month — `preliminary
//     .unpostedBatchCount === 0`;
//   * a non-zero continuity variance — `preliminary.schedule.variance === 0`.
//
// Surcharges are deliberately NOT here, though they were half of #167: once
// `invoice-shipped-order` counts only its own surcharge row, the number of plant-wide surcharges
// stops being a precondition. A pre-flight that over-refuses is a pre-flight people disable.
//
// WHEN THE CONDITIONS ARE EVALUATED, and why "before flow 1" is the right moment rather than a
// convenient one. All three are read before the run has created anything, so everything they see
// belongs to somebody else — which is exactly the population the flow refuses to touch:
//
//   * The run's OWN batches (close-month-end's, and receivables-apply-age-statement's, which it
//     leaves OPEN) do not exist yet, so they can never be counted here. Reading the same number at
//     flow 20 would have to tell them apart from a stranger's; reading it now does not.
//   * Nothing the suite does can move a STRANGER'S batch in either direction. `postOpenBatch`
//     names only ids out of `ctx.created`, and no flow reopens a batch at all (`reopenBatch`
//     exists — posting is NOT one-way — but the only thing `close-month-end` reopens is the
//     PERIOD). So the count is stable across the run for every row the run does not own.
//   * The variance can only be moved by rows somebody adds, and everything the run itself adds
//     moves the roll-forward and the aging by the same amount (its invoices are raised through the
//     real UI; its cash is in batches it posts). An ambient imbalance now is the same imbalance at
//     flow 20.
//   * The one genuine gap is the month boundary: a run started at 23:5x on the last day of a month
//     evaluates this for the old month while flow 20 targets the new one. Both use UTC `now`, so
//     the window is minutes wide once a month, and the failure mode is the pre-existing one (flow
//     20 fails on its own assertion) rather than a wrong pass.
//
// The recipe every refusal prints has to exist, which is what `npm run db:reset` is for.

const RECIPE =
  "The E2E suite and the demonstration dataset cannot share a database (docs/manual/dataset.md).\n" +
  "  To run the suite:      npm run db:reset      (back to migrate-deploy + db:seed state, ~1s)\n" +
  "  To rebuild the demo:   docs/manual/dataset.md, \"Rebuilding it\"\n" +
  "  Neither is destructive to anything but the LOCAL dev database (`erp` on localhost).";

/**
 * `null` when the dev database can host a run, otherwise every reason it cannot, with the evidence
 * and the recipe. All reasons are collected rather than short-circuited: they share one fix, and a
 * developer should not have to re-run to discover the second one.
 */
export function preflightRefusal({ year, month, closePeriodStatus, unpostedBatchCount, variance }) {
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const reasons = [];
  if (closePeriodStatus) {
    reasons.push(
      `a ClosePeriod row already covers ${period} (status ${closePeriodStatus}). The close-month-end ` +
      `flow only ever touches a period it created itself, so it would refuse — after ~8 minutes of ` +
      `flows. If this is a real close, that is the dev DB being used for a demonstration; if it is ` +
      `a leftover, a previous run's cleanup did not finish.`,
    );
  }
  if (unpostedBatchCount > 0) {
    reasons.push(
      `${unpostedBatchCount} OPEN receipt batch(es) carry a payment dated in ${period}. ` +
      `close-month-end asserts a plant-wide unpostedBatchCount of 0 and will not post a batch it ` +
      `did not create. The demonstration dataset leaves exactly one open on purpose, to teach the ` +
      `reconciliation.`,
    );
  }
  if (variance !== 0) {
    reasons.push(
      `${period}'s continuity schedule does not reconcile (variance ${variance}). close-month-end ` +
      `asserts a variance of 0 for the whole month, and nothing the run itself does can move it — ` +
      `every invoice and payment it raises lands on both sides of the schedule.`,
    );
  }
  if (reasons.length === 0) return null;
  return `the dev database (erp) holds state the E2E suite cannot run against:\n` +
    reasons.map((r) => `  - ${r}`).join("\n") + `\n${RECIPE}`;
}
