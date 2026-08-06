### Task 16: Cert detail page — requirement blocks and readings grids

**Files:**
- Create: `src/app/certs/[id]/page.tsx`, `src/app/certs/[id]/CertDetail.tsx`, `src/app/certs/[id]/RequirementBlock.tsx`

- [ ] **Step 1: Build the header** — order link, scope and its subject (load number or packing-list number), printed date, and the void action with a reason.
- [ ] **Step 2: Build one requirement block per `CertRequirementDetail`**, grouped by part line and headed with the part number and name. Each block shows the frozen code, scale, min, max, sample qty and location **read-only** (they are frozen by design — §4.1), with an editable readings grid under it: value, computed pass/fail, an explicit override toggle, and a note. **Show pass/fail prominently on screen and note in the UI copy that it does not print** (§3.21) — this is the single most surprising behaviour in the phase and the screen is where it gets explained.
- [ ] **Step 3: Build freeform and internal notes** — internal notes carry a persistent "never printed" label beside the field.
- [ ] **Step 4: Gate post-print editing** — once `printedAt` is set the grids are read-only unless the session holds `edit_cert_results_after_print`, and the disabled state **says why** (§5.16).
- [ ] **Step 5: Add** the print action, the stored-documents list, and `HistoryPanel entity="cert"`. Remount per id.
- [ ] **Step 6: Verify in the browser** — seed a cert, type readings, watch pass/fail compute, override one. Screenshots.
- [ ] **Step 7: Gates + commit** — `feat(ui): certification detail with seeded requirements and readings`
