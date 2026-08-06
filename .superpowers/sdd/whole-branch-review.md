# Phase 4 Whole-Branch Review — 586a569..be551d4 (82+ commits, 251 files, ~41k insertions)

> Filed by the controller verbatim from the final reviewer's returned text (strongest model).
> Ran 2026-08-06. The reviewer independently re-ran the gates: vitest 1357/1357, tsc clean,
> eslint clean.

## Verdict: READY TO MERGE — WITH FIXES (one fix wave, below)

## Strengths (abridged headings; full detail in the transcript)
- Locking architecture genuinely disciplined — every mutation path traced opens with its claim; both module cycles confirmed gone.
- Audit coverage complete on the combined tree (AuditableModel + SNAPSHOT_INCLUDE for cert/shipper; SNAPSHOT_SELECT.user excludes signatureImage).
- §3.21 enforced structurally (CertPdfData cannot represent a verdict).
- §8 non-disclosure holds across every post-ruling surface; the one place cert requirement is named to shipping-only users is spec-mandated (§3.13/§5.7), not a leak.
- Merge 89bd01c semantically sound (list vs detail surfaces disjoint; one resolution, one derivation); 7b171d5 wiring is good code.
- Authorization on all 20+ new handlers correct against §9 incl. all four dated amendments.
- Zero-order blank-PDF edge CONFIRMED unreachable (CREATE_SHIPPER orders.min(1); removeOrderFromShipper refuses the last order) — closed, no fix owed.

## Issues

### Critical
None.

### Important — THE FIX WAVE

**1. Voided-state guard on Cert and Shipper rests on SSI, not the row lock (T6-era carry upgraded to latent defect).**
Where: order-locks.ts:109-114 (claimCertsOrder), shippers.ts:641-645 (claimLiveShipper), every consumer's post-claim re-read (cert-results.ts:220-221, certs.ts:600-602, shippers.ts:1313-1315).
The guarded state (Cert.deletedAt / Shipper.deletedAt) lives on a row OTHER than the locked Order row. At Serializable the snapshot fixes at the first (unlocked stub) read, so the post-claim re-read cannot see a void that committed while the claimant blocked on the order lock; the FOR UPDATE raises no 40001 because the Order row was never modified. Most interleavings are rescued incidentally (write-write conflicts, audit-read SSI cycles) — but the PRINT paths have no saving edge: printShippingTickets racing voidShipper writes only a StoredDocument row nothing in the void reads (one-way rw edge, no abort) → a NEW archived document against a voided shipment, violating §5.6. Cert reprint racing voidCert has the same hole. The Order entity never had this problem (voidOrder modifies the very row claimOrder locks); the two new entities introduced a shape Phase 3 never had.
Fix (mechanical): claimCertsOrder and claimLiveShipper also take FOR UPDATE on the cert/shipper row itself, uniformly AFTER the order claims (fixed order ⇒ no new ABBA). Read Committed then re-reads fresh; Serializable raises the standard 40001 → withDbErrors' honest 409. Add the ledger's prescribed concurrency test — replaceReadings racing voidCert, competing caller pinned Read Committed (T5 technique) — verified RED against pre-fix code (the reviewer's analysis says it fails today).

**2. shippedTotals accumulates weight in raw floats — the single §5.1 derivation can spuriously REFUSE a legal edit.**
Where: ship-ledger.ts:40-43, consumed by orders.ts updateLine's §5.5 check, overshipWarnings (shippers.ts:898-911), saveNewShipper's warning text (576-580).
0.1+0.2 epsilon overshoot: (a) reducing a line's weight to exactly its shipped-to-date is REFUSED with "0.30000000000000004 lbs" in the message — a hard false block on a legal §5.5 edit; (b) exactly-complete lines can warn as over-shipped; (c) the artifact prints in refusal/warning text and grids. toShipperRow/readShippingTicketData/readBolData already sum in integer cents citing exactly this shape.
Fix: accumulate Math.round(weight*100) inside shippedTotals, divide once at the end. One test: two 0.10/0.20 shipments against a 0.30 line — edit to 0.30 succeeds, no warning.

**3. Cross-page notes-clobber (the ledger's named fix-wave candidate; reproduced live during T16).**
Where: CertDetail.tsx:216-226 (patchNotes applies the WHOLE server detail over in-flight sibling edits), ShipmentDetail.tsx:400-401 (patchHeader), customers/[id]/page.tsx:216-233 (failure-path load()).
A freeform PATCH in flight resets internalNotes text being typed (controlled inputs) — the normal fill-out-both-fields flow. Fix with ONE shape on all THREE pages in one commit: merge the response minus the notes pair unless untouched, or per-field dirty-since-focus preservation (the per-block bumpReset machinery is the precedent).

### Riding the wave (trivial)
- shipper-documents route test gains the 404 case + fileData-absence assertion (symmetry with the cert sibling).
- Tooltip fall-throughs: cert checkbox on a voided shipment falls through to printGate.title; CertDetail's print button while printing gains a title.

### Minors → BACKLOG (recorded; not blocking)
KIND_LABELS consolidation (three divergent maps); idempotent replay returns warnings:[] (re-derive from replayed detail); CERT_COLUMNS lacks passedCount (export invites the outlawed subtraction); printableShipmentCertIds resolves through the order's CURRENT certScope (behavior note for the PR); §5.16 state-disabled titles (letter of §5.16 is permission gating — covered); serials prefill over-inclusion (owner ping); OrderDetail.orderLineShippedToDate unused in edit payload (keep — document, don't trim); void-between-resolve-and-print partial archive (benign); print-route 401 test; warnings keyed by index; add-order fetch ticket; T16 ungated effects; HistoryPanel staleness; T20 e2e brittleness/soft assertions; credit-hold history rendering (owner feature request).

## Owner pings — confirmed accurately recorded in HANDOFF §6 (lines 171-180, 500-503; reminder at 647)
Ticket Page-N-of-M vs template purity; serial re-shipment warning gap; tear-off overlap past ~8 extra part rows; missing User.title for the cert signature line. Surface in the PR body.

## Recommendations
1. ONE fix-wave dispatch (three Important + two riding minors), one scoped re-review.
2. Put the new house rule in order-locks.ts's header: "the guarded state must live on, or be locked with, the claimed row" — Phase 5's reversing shipments will need it again.
3. PR body: the four owner pings + the current-certScope behavior note.
4. Phase 5 warm-ups: KIND_LABELS consolidation, export passedCount.
