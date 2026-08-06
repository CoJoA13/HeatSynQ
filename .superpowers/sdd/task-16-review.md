# Task 16 Review — Certification detail page (38b4515, range e56cc91..a749f30)

> Filed by the controller verbatim from the task-reviewer's returned text (reviewer runs
> read-only). Review ran 2026-08-05 against review-task-16.diff.

### Spec Compliance

- ✅ **Frozen fields read-only** — rendered as plain text (`Frozen` spans, never inputs) with the §4.1 caption: `RequirementBlock.tsx` diff lines 860–873.
- ✅ **Three-state pass/fail, never inferred** — summary counts use explicit `passed === true / === false / === null` filters (`CertDetail.tsx` diff lines 551–554); per-row `rowVerdict` returns `null` for blank/unjudgeable values and for a pending override (`RequirementBlock.tsx` diff lines 773–780); `fromServer` maps `passed: null` → `""` pending choice (764). Pending renders as its own amber badge/option everywhere (782–790, 903–905). The Task 15 subtraction bug is genuinely not repeated.
- ✅ **Merge-semantics save payload** — PUT body names only the saved block: `{ requirements: [{ id: requirementId, readings }] }` (`CertDetail.tsx` diff line 505); verified against the server that this replaces only named requirements' readings (`src/server/cert-results.ts:193–252` — delete-and-recreate scoped to named ids). Sibling drafts survive via per-requirement remount keys (`blockResets`, diff lines 409–416, 668).
- ✅ **Post-print gate + §5.16 reason** — `resultsGateFor` (diff lines 342–355): voided → `certs.edit` → printed requires `edit_cert_results_after_print`, title names the missing permission verbatim. Notes remaining on plain `certs.edit` post-print is spec-consistent (spec lines 693–694, 883–884: the after-print tightening covers results edits only).
- ✅ **§3.21 does-not-print copy + internal notes label** — prominent summary explanation (diff lines 633–637), grid column header "Pass/fail (screen only)" (882), amber "never printed" badge beside Internal notes (688–692), Freeform labeled "(prints on the certification)" (680).
- ✅ **Voided cert lockdown** — banner with reason (589–593, reason from audit trail 460–469 with visible fallback). Per-control enumeration, nothing escapes: textareas readOnly (682, 694), value/note inputs readOnly (893–896, 919–921), override select disabled (900), checkbox disabled (913), remove/Add/Save disabled (925, 941, 946), Void "Already voided" (446–447, 580), Print disabled with void-specific title (451–456). Document download links stay live — correct per §5.6.
- ✅ **Remount per id / no server imports / recovery shape** — `<CertDetail key={id} id={id} />` (`page.tsx` 972); client files import only src/lib and src/components, local type mirrors (284–310); rollback-then-report ordering correct in both mutators (483–485, 511–514); no soft-catch.
- ✅ **Print disabled per §5.16** — always disabled, title "Available once the certification layout lands (Task 19)" or the void refusal (451–456, 642–650).
- ✅ **Header** — order link, scope + subject (`scopeSubject`, 326–330), printed date, void-with-reason via DELETE body with two-phase error handling (520–544).
- ⚠️ Cannot verify from diff: screenshots and shared-dev-DB fixture cleanup. The browser narrative's checkable claims (exact titles, per-control lock split, three-state summary string) all match cited code paths, supporting its credibility.

**Adjudication — GET /api/certs/[id]/documents (not in spec §9):**
- handle wrapper, `mustCan(requireUser(), "certs", "view")` first line (route.ts diff 249–252), identical idiom to sibling cert routes.
- Metadata-only via DOCUMENT_SELECT (excludes fileData; test asserts absence).
- §8 per-kind filter satisfied by construction: DB CHECK `StoredDocument_kind_owner_check` (migration 20260804122700 lines 329–333) requires certId non-null only for kind CERT and null otherwise, so `where: { certId }` returns only CERT rows; AREA_FOR_KIND maps CERT → certs — the gating area. Single-kind, so empty-the-group cannot arise.
- 404 from the service (findFirst, correctly not findUnique, correctly not filtering deletedAt per §5.6).
- Test coverage complete for a read route: 401, 403 (cross-area permission), 200 scoped to exactly this cert, metadata-only, 404 (tests/cert-routes.test.ts diff 1018–1051). TDD RED evidence plausible (module-not-found RED).
- **Recommendation: accept as a faithful gap-fill; amend §9 on main.**

### Strengths

- Task 15's three-state lesson honored structurally — explicit === checks at every render site, comments citing the finding.
- Client validation mirrors the server exactly: DECIMAL_10_4 regex byte-identical to decimalField(10,4)'s; computePassed genuinely shared, so screen and stored verdicts cannot disagree.
- Pre-validation-refusal vs failed-save distinction: local error keeps the draft; a real server rejection triggers rollback-then-report (§5.13 without punishing typos with draft loss).
- Block-remount-key mechanism cleanly mirrors the server's merge semantics client-side.
- Honest reporting: the implementer's own verification caught the notes clobber and disclosed it.

### Issues

Critical: none. Important: none.

Minor:
1. **Notes cross-field clobber** (CertDetail.tsx diff 476–486, 681–698; disclosed): a PATCH response carrying the sibling field's old value can wipe text being typed there — reproduced live during verification. Minor only because it is byte-for-byte the ShipmentDetail/customers precedent; should become a named cross-page fix-wave item before merge.
2. Report overstates fetch gating: CertDocumentsList effect (364–368) and voidReason effect (460–469) carry no useLatest ticket (races benign given remount-per-id, but the claim is broader than the code).
3. Rollback-load failure edge: if rollback load() itself fails (swallowed, 483), the field keeps the optimistic value while the banner reports only the PATCH error. Precedent-shared.
4. Malformed value (e.g. "abc") shows amber Pending until Save names the problem (rowVerdict, 778). Defensible, mildly misleading.
5. Disclosed cosmetics: trailing-zero loss on decimal re-display; HistoryPanel not refreshing after same-page saves. Correctly deferred.

### Assessment

**Spec Compliance:** ✅ (one ⚠️ unverifiable-from-diff, corroborated indirectly)
**Task quality:** Approved (first pass)
