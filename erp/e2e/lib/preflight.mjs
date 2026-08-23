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
// FOUR CONDITIONS SINCE THE FIX ROUND, not three, and the fourth is `close-month-end`'s FOURTH
// plant-wide assertion rather than a new idea: `readinessGaps.length === 0` (its line 399) is as
// global as the other two — `resolveReadiness` scans every FINALIZED invoice in the month with no
// customer scope, which is exactly why `db-fixtures.ts` backfills GL accounts onto a STRANGER
// flow's rows. Leaving it out meant an ambient account-less invoice line redded flow 20 while the
// pre-flight stayed silent. `db-fixtures.ts`'s `preflight` command filters the gap list to the ones
// naming a specific ambient row before it gets here; its comment says why.
//
// A FIFTH reason exists that is not a condition at all: `preliminaryReport` REFUSING to answer.
// See `preliminaryError` below — it is a refusal wearing a stack trace, and turning it back into a
// reason is the whole point of this file.
//
// The recipe every refusal prints has to exist, which is what `npm run db:reset` is for — and it
// has to WORK in the session that reads it, which is why the non-interactive form is spelled out.
// `db:reset` confirms before it truncates (scripts/db-reset.ts, barrier 4): a terminal is asked to
// type the database name, and everything else must pass `--yes`.

const RECIPE =
  "The E2E suite and the demonstration dataset cannot share a database (docs/manual/dataset.md).\n" +
  "  To run the suite:      npm run db:reset              (asks you to confirm; ~1s)\n" +
  "                         npm run db:reset -- --yes     (same, from a script or an agent session)\n" +
  "  To rebuild the demo:   docs/manual/dataset.md, \"Rebuilding it\"\n" +
  "  Neither is destructive to anything but the LOCAL dev database (`erp` on localhost).";

/**
 * `null` when the dev database can host a run, otherwise every reason it cannot, with the evidence
 * and the recipe. All reasons are collected rather than short-circuited: they share one fix, and a
 * developer should not have to re-run to discover the second one.
 */
export function preflightRefusal(ambient) {
  // The probe's answer is one line of JSON parsed out of a child process's stdout, so "no readable
  // answer" is a state that exists — `runDbScript` returns null when the script exits 0 having
  // printed nothing. Destructuring it straight away turned that into a TypeError inside the
  // harness rather than a diagnosis, which is the same class of defect as everything else here.
  if (!ambient || typeof ambient !== "object") {
    return `the dev-DB pre-flight probe produced no readable answer (got ${JSON.stringify(ambient) ?? "undefined"}). ` +
      `That is a harness fault, not a database one: e2e/lib/db-fixtures.ts's \`preflight\` command ` +
      `is expected to print exactly one line of JSON on stdout. Run it directly to see what it ` +
      `said:\n  npx tsx e2e/lib/db-fixtures.ts preflight`;
  }
  const {
    year, month, closePeriodStatus, unpostedBatchCount, variance,
    preliminaryError = null, readinessGaps = [],
  } = ambient;
  const period = `${year}-${String(month).padStart(2, "0")}`;
  const reasons = [];
  // FIRST, because it means the two figures below were never computed: when the close service
  // refuses to report at all, `unpostedBatchCount` and `variance` are the probe's zero defaults and
  // say nothing. Reporting them as clean beside this would be a lie of exactly the shape this file
  // exists to remove.
  if (preliminaryError) {
    reasons.push(
      `the close service refuses to report on ${period} at all: "${preliminaryError}". ` +
      `close-month-end reads that same report and would fail the same way, after ~8 minutes of ` +
      `flows. The usual cause is a ClosePeriod for an EARLIER month with the immediately-prior ` +
      `month left open — a skipped month, which breaks the roll-forward chain — and the ` +
      `demonstration dataset produces it by design: it closes the month BEFORE its seed date, so a ` +
      `dataset seeded in one month and still present in the next makes this throw. The unposted-` +
      `batch and variance figures below were NOT computed and are not being reported.`,
    );
  }
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
  if (readinessGaps.length > 0) {
    const shown = readinessGaps.slice(0, 5);
    const rest = readinessGaps.length - shown.length;
    reasons.push(
      `${readinessGaps.length} GL-export readiness gap(s) in ${period} name rows this run does not ` +
      `own: ${shown.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}. close-month-end asserts a ` +
      `plant-wide gap list of ZERO before it exports — readiness scans every FINALIZED invoice in ` +
      `the month, not just its own — and it cannot repair somebody else's paper (a frozen ` +
      `account-less line is only fixed by unlocking and re-finalizing that invoice).`,
    );
  }
  if (reasons.length === 0) return null;
  return `the dev database (erp) holds state the E2E suite cannot run against:\n` +
    reasons.map((r) => `  - ${r}`).join("\n") + `\n${RECIPE}`;
}
