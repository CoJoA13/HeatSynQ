# Task 11 brief — Cert conversion

**Branch:** `phase-7-template-designer` (Tasks 1–10 APPROVED; ticket and BOL bracket the two text-block binding shapes; suite at 2486; E2E 19/19).
**Read first:** the spec §5.4/§5.6 + plan Task 11; **Task 10's report** (its Task 11 notes: the data-seam-vs-config-binding fork — check whether `cert_statement` arrives as caller data or a builder literal and pick the matching worked example; signature block byte-identical + regression-pinned; multi-part certs stay ONE sheet group; mint `e2e-task11.done`). Then `erp/src/server/pdf/cert.ts` in full, `readCertPdfData`/`printCert` in `erp/src/server/certs.ts` (~:506–710), and the cert contract.

## Deliverable

1. **`buildCertDefinition(data, config)`** — config-consumer per the pattern (`completeSections`, §5.6 both halves + the text-block third half where applicable): sections/fields/labels/widths/fonts/formats. **`cert_statement` from the resolved config** — pick the binding shape by what the code actually does today (`certs.ts` reads the Setting and passes it into the data → the TICKET shape: inject the config's text block at the data seam; if it turns out to be a builder literal, the BOL shape) and justify in the report. `settings.ts` untouched (Task 14 retires the key).
2. **Constraints that must survive conversion untouched:**
   - **§3.21's type-level exclusion**: `CertPdfData` structurally excludes min/max/pass-fail — the conversion must not widen the type or add any binding the contract doesn't declare; the existing contract-omits-internal-notes test rides the real data path (extend it if the conversion moves any seam).
   - **The signature block**: byte-identical rendering (signer name/title/company, image-or-typed-name fallback) — pin with a regression test through rendered bytes if none exists at that granularity.
   - **Multi-part certs are ONE sheet group** (the per-part requirement headings are §3.21 content within one document, never separate renders); the frozen-requirements + `orderLineIdAtSeed` grouping tests from Phase 4 stay green and untouched.
3. **`printCert`** — after the existing claims (`claimCertsOrder`), inside the Serializable transaction: `resolveTemplateForPrint(tx, "CERT", <the owning order's customerId>)`; logo per the pattern; stamp `templateVersionId`; **`printedAt` first-print semantics and the signer read untouched**.
4. **Page N of M** knob (default OFF — golden). **Overflow, investigate-first** (the Task 10 precedent): can a real cert overflow one page (many readings/serials/parts)? If reachable, the identity continuation band (order number + scope identity, "(continued)"); if provably not, say so in the report — no dead code.

## Tests (TDD; RED evidence REQUIRED)

Golden: `tests/cert-pdf.test.ts` untouched, green; the Phase 4 cert suites (frozen requirements, grouping, multi-part headings) untouched, green. Config-driven: label/width/font/format overrides; `cert_statement` both directions (edited block reaches paper; the Setting no longer does — through the real path); §5.6 shapes; resolution + stamp through the real print path with a marker template (`createTemplate → editDraft → publishDraft → assignTemplate → printCert`), the stamp read off the stored row; `printedAt` regression (first print sets, reprint doesn't); the signature-block pin; the overflow finding's test (whichever way it lands).

## Gates — E2E REQUIRED

Four unit gates + full E2E **detached from the start, per-task sentinel `e2e-task11.done`**; rows from the run's own output or PENDING; dev-DB fixtures cleared. Commit in small logical units.

## Report

`docs/execution/2026-08-12-phase-7-template-designer/task-11-report.md`: the binding-shape finding, the overflow finding, RED evidence, all five gates watched, deviations, notes for Task 12 (invoice/credit — the frozen-snapshot conversion + the `processNames` source change + #98). Final message: 5-line summary + report path. Update your ledger row.
