# Task 19 Review — BOL + Certification layouts (7800882, range e68b784..7800882)

> Filed by the controller from the task-reviewer's returned text (abridged only by dropping the
> per-requirement ✅ list's repetition of the report; every finding, adjudication and ruling is
> verbatim). Reviewer read BOTH sample PDFs directly. Review ran 2026-08-05.

### Spec Compliance (summary)

Every checked requirement ✅ with file:line citations, including: §10.2 BOL layout block-by-block
against the sample; lazy race-safe bolNumber allocation inside the claim (voided keeps its number);
§10.3 cert layout against the sample (zero-padded packing list, stacked part cells, one-decimal
readings, signature block); **§3.21 enforced STRUCTURALLY** — CertPdfData/CertRequirementBlock carry
no min/max/verdict/override/internalNotes field at all, tested against a cert provably holding a
failed reading; §3.11 signature with typed-name fallback; §5.15 print mechanics in the Task 18
transplant shape; Cert.printedAt set by BOTH paths; 401/403/200 on every new/changed handler;
?cert=0 mis-refusal fixed; reprint Buffer.compare stored-only; friendly filenames asserted;
bolNumber stays plain @unique; cert detail page (other lane) untouched; UI checkbox degrades with
permission-naming tooltip so the deliberate 403 is unreachable through the UI.

⚠️ unverifiable from diff: gate outputs and RED runs (implementer claims; plausible collection-failure RED).

### Important findings → OWNER RULINGS 2026-08-05 (all four adjudicated same-day, recorded as spec amendments)

1. **B(iii) missing-cert whole-request refusal** → owner ruled **print tickets + warn**: tickets
   print and archive, no cert archived, response carries a named warning the UI surfaces. FIX ROUND.
2. **D BMP signatures uploadable with zero warning** → owner ruled **drop image/bmp from
   SIGNATURE_MIME** (existing rows keep falling back safely). FIX ROUND (pulled forward from
   "at fold-in" since users.ts is main-lane).
3. **B(ii) certs.view tightening** → owner **ratified**; dated §9 amendment recorded.
4. **B(i) LOAD-scope all-live-certs incl. printedAt freeze on unshipped loads** → owner **accepted**;
   dated amendment recorded.

### Adjudications A and C (reviewer's rulings, accepted by controller)

- **A — signature title line: correct omission.** No title field exists anywhere on User (schema,
  users.ts, admin UI all verified); builder renders the line the moment a field exists; printing the
  role name would be fabrication on customer paper. OWNER PING: a User.title follow-up migration.
- **C — byte-grep port: nothing silently dropped.** Full enumeration briefed-assertion → current
  home in the review transcript; the glyph-subset probe rationale is technically sound; several
  assertions strengthened beyond the brief.

### Minors (deferred to whole-branch review)

1. §5.16 tooltip gap: cert checkbox disabled by the print gate shows only certsGate.title — on a
   voided shipment with certs.view held, no explanatory tooltip (ShipmentDetail diff 319-325, same
   shape in ShipmentOrderPanel 461-467). Title should fall through to printGate.title.
2. Route thickness: shipper print handler orchestrates resolve → tickets → loop printCert; a
   printShipmentWithCerts service entry would restore strict authorize→parse→delegate.
3. Disclosed narrow race: cert voided between resolution and print leaves ticket archived, request
   failed (partial archive) — benign under append-only archive semantics.
4. Zero-order BOL inherits Task 18's "unreachable via §4.2" continuity note.

### Strengths (reviewer's)

- §3.21 enforced by the input type — the strongest possible form of the phase's most surprising ruling.
- bolNumber allocation exactly right: inside the order-claim, audited on the shipper, counter bump
  rolls back with the tx; two concurrent first-prints serialize on the claimed rows' FOR UPDATE, the
  loser aborts cleanly — duplicate or burned number impossible.
- Exemplary disclosure: every deviation commented in-file, restated in the report, flagged rather than smuggled.
- readCertPdfData reads the signer on the tx, avoiding the pool-starvation shape.

### Assessment

**Spec Compliance:** ✅ except the B(iii) behavior (now owner-ruled into a fix round)
**Task quality:** Approved contingent on the fix round for rulings 1–2
