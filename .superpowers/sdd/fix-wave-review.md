# Final Fix-Wave Re-Review (b785d1f..ad025e9) — 2026-08-06

> Filed by the controller verbatim-in-substance. All FIVE items ADDRESSED; Approved; **PR-ready**.

- **Item 1 (voided-guard row locks + races + house rule): ADDRESSED.** Cert lock after claimOrder in the ONE shared helper every cert path routes through (caller grep exhaustive); shipper lock after order claims in all nine paths — the claimLiveShipper restructure collapsed seven mutators' duplicated sequence into one shared helper, making the house rule STRUCTURAL, not conventional. Global lock order Orders → Shipper → Cert everywhere; no ABBA reopened (voidShipper's cascade shares the Order-first prefix). Race tests are genuine discriminators: real happens-before edge (signal after awaited FOR UPDATE), competitor genuinely Read Committed (no isolationLevel), outcome-content assertions (409 + zero rows written / nothing archived). RED evidence matches the predicted pre-fix failures exactly. 40001→409 via the pre-existing isRawSerializationFailure mapping (db-errors.ts:32-36, 52-55). Print paths deliberately keep their own shape so a void answers 400 not 404 (§5.6 preserved). Checked risk closed: sortedClaimIds dedupes, so addOrderToShipper's intended "already on this shipment" 400 survives.
- **Item 2 (shippedTotals cents): ADDRESSED.** Weight in integer cents, one division at the end, Decimal(12,2) lossless; test RED'd on the literal 0.30000000000000004 refusal; exact-remainder edit now succeeds with no warning.
- **Item 3 (notes-clobber trio): ADDRESSED.** One hook (src/lib/use-edit-guard.ts, per-field dirty-since-focus), one commit, three pages consuming it identically. §5.13 rollback intact: onBlurSave clears the focus slot BEFORE committing, so the failed-save field itself is never protected and rolls back to server truth. Browser verification concrete (2500ms delayed-fetch, three scenarios).
- **Items 4-5: ADDRESSED** (test symmetry; certsGate.title ?? printGate.title on both components + mid-print title).

**Residual float in saveNewShipper's §5.7 warning text: ruled BACKLOG, does not block** — warn-never-block contract, no refusal, no wrong data; the detail-path derivation is now exact; one-line cents sweep available whenever.

Deferred observations (recorded): packageCountDisplay string-lens quirk under concurrent editing (nil consequence single-user); customers grid cells outside the trio's scope (correctly not gold-plated); merge's re-snapshot inside a setState updater (idempotent, harmless).

**Verdict: Approved — PR-ready. No new breakage.**
