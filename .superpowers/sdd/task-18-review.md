# Task 18 Review — Shipping ticket layout + print mechanics (4130260, range 1d03ec0..4130260)

> Filed by the controller verbatim from the task-reviewer's returned text. Review ran 2026-08-05
> against review-task-18.diff; the reviewer read docs/samples/Shipping Ticket Sample.pdf directly.

### Spec Compliance

- ✅ **One ticket = one ShipperOrder; all-tickets = one sheet per order, never a merged MOS layout** (§3.20) — `buildShippingTicketDefinition` iterates `TicketData[]` with `pageBreak: "before"` per sheet (shipping-ticket.ts:696–715); `/Count 2` / `/Count 1` pinned-marker tests (tests:1157–1168).
- ✅ **POST /api/shippers/[id]/print?doc=ticket|bol&order=<id>&cert=1, gated shipping.view** (§9) — route.ts:46–52; first line canonical mustCan.
- ✅ **Archive via Task 3 store, kind SHIPPER, correct owner columns, audited create metadata-only** — storeDocument inside the claim-holding Serializable tx (shippers.ts:917); audit test asserts content (fileData absent), owner-column test asserts null vs set orderId.
- ✅ **Voided refuses new prints, stored stays reprintable** — re-read under claim then assertPrintable (shippers.ts:910–912); exact VOIDED_PRINT message + stored readability asserted; route 400 body verbatim. Deliberate non-use of claimLiveShipper (404 would misname a void) is sound.
- ✅ **Reprint = stored bytes Buffer.compare only stored-vs-original; fresh renders pinned-content only** — no fresh-vs-fresh compare anywhere.
- ✅ **Row-claim discipline** — pre-claim stub read only to learn the claim set (sanctioned addOrderToShipper shape), claimOrdersInOrder over shipperOrderIds, then re-read + all data reads on tx (shippers.ts:902–915); readShippingTicketData takes the caller's db throughout.
- ✅ **Friendly filenames not regressed** — reuses documentFilename; ticket-<shipperNumber>.pdf / ticket-<ship>-order-<orderNumber>.pdf both asserted exactly.
- ✅ **bol/cert refusals: 400s naming Task 19, nothing archived** — refusals precede any service call; test pins zero archived documents after the cert refusal.
- ✅ **UI: exactly the ticket paths live; §5.16 held** — BOL button and cert checkbox stay disabled naming Task 19; voided print gate title truthful ("stored prints stay available"); popup-block failure surfaced; shared grids/gate structure untouched.
- ✅ **Template-as-data (§10)** — builder is pure JSON, asserted by a JSON.parse(JSON.stringify(def)) round-trip test; same contract as traveler.ts.
- ✅ **Tests: 17 (3 builder + 7 print + 2 collector + 5 route), ctx passed, no delegate spies, content-pinned.** TDD RED reported.
- ⚠️ Cannot verify from diff: pristine full-suite output and the visual side-by-side beyond block-string structure — controller should spot-check one rendered ticket against the sample before merge.

### Rulings on the three disclosed deviations

**(a) No signature block — SPEC-FAITHFUL.** §3.11's ruling is about the cert ("The sample cert confirms the shape: a signature image above a typed name, title and company"); §10.3 (certification) lists the signature block; §10.1 (ticket) lists none, ending at Received By/Date. The sample ticket carries only the hand-completed Received By/Date strip. Task 19's cert owns the signature.

**(b) No "Page 1 of 1" — DISCLOSED SPEC DEVIATION, correctly resolved; ledger-note it.** §10.1 does list Page N of M (the sample prints "Page 1 of 1"), so a spec-listed field is omitted. The technical claim is accurate: pdfmake exposes page counts only to header/footer FUNCTIONS, which a pure-JSON definition cannot carry (the purity test would fail), and a render.ts-level footer would count across the whole multi-ticket PDF ("Page 3 of 5" on a five-order print), not per-ticket. The traveler prints no page numbers either. A hard-coded "1 of 1" would be false on any wrapped ticket. §10's template-as-data contract wins over §10.1's field list — but §10.1 names it, so: ledger + owner ping (Phase 7's designer is the natural home). Minor.

**(c) absolutePosition tear-off at y=648 — LEDGER NOTE; report understated reachability.** LETTER flow area runs to y≈768; tear-off occupies ~648–740, so flow content past ~640 collides — a 120pt collision band before pdfmake would break the page. A sample-shaped ticket uses ~380–420pt, leaving headroom for ~7–8 additional three-line part rows (~15 container/serial rows). An 8–10-line order is plausible real data. Failure mode: one cosmetically-overlapped sheet (on a two-page ticket the tear-off lands only on the final page — arguably right); no data corruption; a data-only definition has no space-reservation instrument. Fix not required now; ledger must record the real threshold; Phase 7's designer or Task 19 owns a flow-based fallback.

**Concern 4 (combined-tree gates) — NOT AN ISSUE.** The reviewed range is exactly one commit whose base already contains the Task 14b commits; every out-of-file symbol consumed was verified to pre-exist. Nothing depends on uncommitted or later work.

### Strengths

- The print entry point is a faithful printTraveler transplant: settings outside the tx, one Serializable tx bracketing claim → re-read → assertPrintable → read-on-tx → render → archive, with the void-vs-404 distinction reasoned in comments.
- Every layout deviation from the sample is individually commented in the builder — none silent — each citing its spec clause or precedent (shipping-ticket.ts:334–343).
- Cents-integer weight summation (shippers.ts:851–855) kills the float-tail bug class before it reaches paper; date formatting never touches a timezone.
- The shippedComplete vacuous-truth guard (lines.length > 0 && …, shippers.ts:873) is exactly the paper-must-not-lie edge the spec demands, and tested.
- Content-first assertions: zero-padded 072826, tear-off's bare Order No.: 72036, exact VOIDED_PRINT body, printOnShipper filtering, archived-nothing after refusal.

### Issues

Critical: none. Important: none.

Minor:
1. **?cert=0 refused with the wrong message** — `search.get("cert") !== null` (route.ts:56) refuses ANY cert parameter, including an explicit cert=0, with a message about printing the certification alongside. Spec §9 names cert=1. Harmless today (UI can't send it; Task 19 replaces the branch), but the refusal misnames the blocker for cert=0.
2. **No 401 route test** — 403 and 200 covered, not the no-cookie 401 (house rule: 401/403/200 per handler).
3. **Zero-order shipment prints and archives a blank PDF** — empty content, empty claim set. Untested edge; a refusal ("no orders on this shipment") would be more honest paper. (Controller note: §4.2 document-level enforcement (T9) should make a zero-order shipment unreachable through edit paths — verify reachability before spending a fix on it.)
4. **Deviations (b) and (c) need ledger entries** per the rulings — (b) §10.1-listed field consciously omitted (owner ping / Phase 7), (c) real overlap threshold ~8 extra multi-line part rows, nearer than "pathologically long".

### Assessment

**Spec Compliance:** ✅ (one ⚠️: controller to spot-check a rendered ticket against the sample before merge)
**Task quality:** Approved (first pass)
