# Phase 2C-1 — Shared Foundations (design)

**Approved by the owner 2026-08-01.** Sub-spec of `2026-07-29-heat-treat-erp-design.md`; does not amend it. Implements the five obligations handoff §4a lists as inherited by Phase 2C, plus two new owner rulings recorded in §7 below.

**Why this is its own branch.** Phase 2C as originally framed is ~11 new models and ~30 tasks — roughly three times Phase 2B, which still needed eight review rounds and 40 threads. The owner ruled on 2026-08-01 to split it three ways: **2C-1 shared foundations** (this spec), **2C-2 Parts core**, **2C-3 Process Steps + Templates**. Each ships working software and gets its own plan, branch and final review.

2C-1 comes first because every one of its five pieces is something the parts screens need before they can be built well — and because the customer pages retro-adopt three of them.

---

## 1. Goal

Build the five cross-cutting mechanisms Phase 2C inherits, as **one shared implementation each**, not per-screen conditionals. Handoff §6 records that revival-on-create "was got wrong four times across two phases, always where it was reimplemented rather than shared." These five are the next things with that shape.

**Testable outcome:** a user holding only `customers.*` can open a customer and see a populated Terms dropdown; deleting a reference row that anything points at is refused with a list of exactly what is blocking it, exportable to Excel; and a paste into the inspection-codes grid accepts `Rockwell C` where it previously demanded a raw cuid.

## 2. Scope

**In:** the FK registry and its sweep; name resolution on read/export/create/paste; the reference-delete guard with blocker listing and export; the `/api/picklists/[kind]` route; the shared permission-gating helper and its adoption by the customer pages; `deleteRole`'s delete reason.

**Out (belongs to 2C-2/2C-3):** any part entity, part field definitions, process steps, revisions, templates, the steps designer. **Out permanently in this branch:** any schema change — see §6.

**Deliberately deferred, and adjacent enough to name.** Handoff §6 carries an unfixed defect: export emits one more column (`Active`) than paste accepts, so export → edit in Excel → paste back fails "Too many columns", and paste has no header-row detection, so fixing the column count naively makes a masked bug reachable — a pasted header row would create a customer coded `Code` named `Name`. §4.1 touches both export and paste for FK columns, so the two are neighbours, but they are **not the same defect** and §6's own ruling is "fix both together or neither." Fixing the round-trip contract properly means designing header detection, which is its own decision; doing it inside a foundations branch would smuggle a product change into a refactor. It stays on the backlog.

## 3. The spine: one registry, three consumers

The five obligations look unrelated. Two of them need the same fact: **which columns point at which reference kind.** Name resolution needs it forward (given `customer.termsId`, display the Terms name). The delete guard needs it inverted (given a Terms row, find everything pointing at it). Implementing them separately means maintaining that knowledge twice and letting it drift.

### 3.1 Shape

`src/lib/reference-links.ts` — pure constants, client-safe, no `src/server/**` imports (the `permission-constants.ts` precedent; see `CLAUDE.md` "Constraints that will bite you").

```ts
export type ReferenceLink = {
  /** Prisma model holding the foreign key. */
  model: "customer" | "processStepCode" | "paymentType" | "inspectionCode";
  /** The FK column on that model. */
  column: string;              // "termsId"
  /** The reference kind it points at. `ReferenceKind`, NOT `PickListKind` — a link may
   *  target `glAccount`, which is deliberately not served by the pick-list route (§4.3). */
  targetKind: ReferenceKind;   // "terms"
  /** Column header wherever this FK is shown or exported. */
  label: string;               // "Terms"
  /** How a blocker row names its own kind in the blocker list. */
  entityLabel: string;         // "Customer"
  /** Detail-page path, omitted where the entity has no detail page. */
  detailPath?: (id: string) => string;
  /** How a blocker row formats its OWN label. Defaults to `row.name`; a linking model whose
   *  identity is not a bare name (Part's is (customer, partNumber) — see below) supplies this
   *  instead of `findBlockers` special-casing it. */
  displayName?: (row: Record<string, unknown>) => string;
};
```

Four entries exist today:

| model | column | targetKind | entityLabel | detailPath | displayName |
|---|---|---|---|---|---|
| `customer` | `termsId` | `terms` | Customer | `/customers/{id}` | — (defaults to `name`) |
| `processStepCode` | `glAccountId` | `glAccount` | Process step code | — | `` `${code} — ${name}` `` |
| `paymentType` | `glAccountId` | `glAccount` | Payment type | — | — (defaults to `name`) |
| `inspectionCode` | `defaultScaleId` | `inspectionScale` | Inspection code | — | — (defaults to `name`) |

2C-2 adds parts' four (material, specification, inspection code, inspection scale) with a `detailPath` to `/parts/{id}`.

`detailPath` being optional is exactly how the owner's ruling (§7.1) is encoded: link where a detail page exists, plain text where it does not. **`displayName` is optional for the same reason, and the final whole-branch review is why it exists at all:** the first implementation of this spine left `processStepCode`'s "code — name" formatting hardcoded as a `link.model === "processStepCode"` branch inside `findBlockers` itself, which made `findBlockers` a second place every future linking model had to edit — exactly the "reimplemented rather than shared" shape §1 names as the thing this spine exists to stop, and the review that caught it is what moved the formatting onto the registry entry above. Per the main spec (§3, decision log), a Part is identified by `(customer, partNumber)` — part numbers recur across customers, and a name alone never identifies one — so **2C-2's Part entries must supply `displayName` rather than rely on the default**; a blocker list is not real discoverability if the label it shows can't be told apart from another part's. With `displayName` on the registry, Parts start linking in 2C-2 by adding a function (or two, where a Part link needs one) to one registry entry — the guard needs no change.

### 3.2 The sweep

`tests/reference-links-sweep.test.ts` parses `prisma/schema.prisma`, finds every foreign key whose target is one of the reference models, and fails if it is not in the registry. Same technique as `tests/permissions-sweep.test.ts` and `tests/partial-unique-sweep.test.ts`, both of which this repo already trusts.

This is what stops 2C-2 from adding `Part.materialId` and silently getting no delete protection for it. **The sweep must be proved by mutation** — add an unregistered FK, watch it fail naming the column, revert — per the practice established on the `prisma-7-upgrade` branch.

### 3.3 Phase 8 forward-compatibility

Handoff §5.14 commits to bulk re-point ("move everything pointing at X to Y, then delete X") but defers it to Phase 8, with the instruction to *build the registry to support it now so it is an addition rather than a retrofit*. The shape above satisfies that: a re-point is `for each link targeting K: updateMany({ where: { [column]: fromId }, data: { [column]: toId } })`. **Nothing in 2C-1 builds that**; the requirement is only that the registry carries enough to add it without redesign.

## 4. The five obligations

### 4.1 Name resolution for FK reference columns

**Problem (handoff §6, carried from Phase 2A by owner decision):** `inspectionCode.defaultScaleId` and `paymentType.glAccountId` render, export, and accept a **raw cuid**. The grid shows `cms7xo30a0004ijdl…`, Excel exports the same, and paste requires typing a cuid — so quick entry is unusable for those two kinds. The owner deferred it in 2A on the grounds that 2C must build the same mechanism for parts anyway.

**Behaviour:**
- `listReference` resolves each `kind: "ref"` column to the target row's `name`, returned alongside the id.
- The Excel export writes the **name**, not the id.
- Create, update and paste accept a **name**; the service looks up the id among live rows of the target kind.
- An unknown name is a **field-anchored 400** naming the column and the offending value — and in paste, a per-row error, consistent with the existing per-row reporting.
- Resolution matches against live rows only (`deletedAt: null`). An inactive row is still resolvable — inactive hides from pick lists, it does not invalidate existing data (handoff §5.14's inactive-vs-deleted distinction).

Built as the general mechanism, driven by the registry, so 2C-2's parts columns get it for free.

### 4.2 Reference-delete guard (handoff §5.14)

**Behaviour:**
- Deleting a reference row that any registered link points at is **refused** with a 400 — never allowed-and-cleared, never allowed-and-dangled. Consistent with `deleteCustomer`'s "still has child customers" and `deleteRole`'s "still assigned" guards.
- The refusal carries the **blocker list**: for each registered link targeting that kind, the live rows whose FK holds this id — each as `{ entityLabel, name, id, href? }`.
- The screen renders the list, linking rows whose registry entry supplies `detailPath` and showing the rest as plain text (§7.1).
- **The list exports to Excel**, reusing `toXlsx(sheetName, columns, rows)` from `src/server/excel.ts` with columns `Type | Name | Link`.

**Why blocking alone is not enough.** This is a live Visual Shop dead end the owner is escaping: there, a furnace group cannot be deleted because a process master points at it, and that master cannot be deleted because parts point at it, with no way to find those parts — *"it would take me a year to find them all and point it elsewhere."* A block without discoverability looks like data integrity while actually being a permanent dead end. The guard is not the problem; naming no blockers is.

**This never obstructs what delete is for.** A row typed by mistake has nothing pointing at it. Ordinary retirement stays on `active: false`, which keeps existing assignments displaying correctly. 2C-2 must not conflate the two: *inactive* hides a row from pick lists while keeping assignments valid; *deleted* hides it from everything.

### 4.3 Pick-list read route (handoff §5.15)

`GET /api/picklists/[kind]` — gated on `requireUser()` **alone**, returning a narrow `{ id, name, active }` projection.

- **Kinds served:** the ten reference kinds **minus `glAccount`**, **plus `processStepCode`** (§7.2). Any other kind, and `glAccount`, 404.

```ts
// src/lib/reference-constants.ts — a distinct set from ReferenceKind, and NOT a subset:
// it drops glAccount and adds processStepCode, which is not a reference kind at all.
export const PICKLIST_KINDS = [
  ...REFERENCE_KINDS.filter((k) => k !== "glAccount"), "processStepCode",
] as const;
export type PickListKind = (typeof PICKLIST_KINDS)[number];
```
- Create/edit/delete stay under `admin` on the existing `/api/admin/reference/*` routes. This route is read-only.
- **`glAccount` stays `admin.view`-only** — it is the one kind no data-entry screen reads (step codes and payment types reference it, both admin screens), so excluding it costs nothing and keeps chart-of-accounts numbers off a route every signed-in user can reach.
- **`processStepCode`'s projection excludes its `glAccountId`**, so serving it does not leak the chart of accounts either.

**Why a route and not a 13th permission area:** there is nothing to grant and therefore nothing to forget. An area would relocate the silent-empty-dropdown failure to a role misconfiguration instead of removing it.

**Also required:** drop the soft `.catch(() => {})` on every pick-list fetch (today `src/app/customers/[id]/page.tsx:105` for Terms). A failed request must say so rather than impersonate an empty list — which is what makes the current bug invisible.

### 4.4 Permission-aware control helper (handoff §5.16)

`src/lib/permission-ui.ts` — client-safe, one shared helper, **not per-page conditionals**.

```ts
gate(permissions, "customers.delete")     // area.action
gateDo(permissions, "change_prices")      // special action → checks "action.change_prices"
// both → { allowed: boolean; disabled: boolean; title?: string }
```

`/api/auth/me` already returns a flat array of granted keys, with special actions keyed `action.<name>` — so both forms are a string lookup against that array.

- **Action buttons stay visible but disabled**, with a tooltip naming the missing permission: *"Requires customers.delete"*.
- **Fields are not a choice and never were:** a `customers.view`-only user still has to read the name, terms and notes, so inputs render **read-only** rather than hidden.
- `Shell.tsx` keeps *hiding* nav entries and does not change — deciding which features exist at all is a different problem from being stopped mid-task.

**The customer pages adopt it in this branch.** Adopting it now is what proves the helper is usable before 2C-2 puts it on every parts screen.

Not reachable while the owner is the only user and an admin; it matters the moment a second user exists.

### 4.5 `deleteRole` delete reason (handoff §5.17)

Role delete joins customer delete as an action requiring a reason: it carries its permission grants away and frees the role name for reuse.

- `deleteRole(roleId, reason)` — reason **required**, trimmed before storing, rejected when blank.
- **Enforced in the service, not only the route**, so no future caller can bypass it — matching `deleteCustomer`.
- The roles page collects it in the same shape the customer delete does.

Requiring a reason on *every* delete was considered and rejected in §5.17: demanding a justification for a carrier typed wrong four seconds earlier trains people to type "x", and a log full of junk reasons is worse than one where the field means something.

## 5. Testing

Per handoff §5.1, TDD per task against the real `erp_test` database.

- **Registry sweep** — walks `schema.prisma`, fails on an unregistered FK. Proved by mutation.
- **Name resolution** — round-trip per `kind: "ref"` column: create by name, list returns the name, export writes the name, paste accepts the name; unknown name gives a field-anchored 400 and a per-row paste error. Seeded with a **non-default** value so the assertion cannot pass trivially — the trap found on the previous branch, where a test seeded a field with its own default and proved nothing.
- **Delete guard** — per registered link: blocked delete returns the blocker, the blocker list contains the right rows, `detailPath`-less entries carry no href, the export renders. Deleting an unreferenced row still succeeds.
- **Pick-list route** — 401 unauthenticated; 200 with the narrow projection for a user holding *no* area permissions; `glAccount` 404s; `processStepCode` returns no `glAccountId`.
- **Permission helper** — unit tests for both forms, including the tooltip text.
- **`deleteRole` reason** — service-level rejection of blank/whitespace, and the audit entry carrying the trimmed reason.

## 6. No schema change

Nothing in 2C-1 adds or alters a model, so **this branch creates no migration**. That is deliberate: it keeps the branch reviewable as pure behaviour, and it means `prisma migrate dev`'s TTY restriction (handoff §4b, `CLAUDE.md`) never comes up. 2C-2 is where the schema moves again.

## 7. Owner decisions, 2026-08-01

1. **Blocked-delete blocker list links where a detail page exists, and shows plain text where it does not.** §5.14 said "linked to their detail pages", but only customers have one today — step codes, payment types and inspection codes live in admin grids with no per-row page and no search at all. Adding URL-driven search to those grids was considered and rejected: they are small and unpaginated, so the row is already on screen when the admin page opens. The Excel export carries every blocker either way, and because the list stores kind + id, deep links remain addable later without rework.
2. **`processStepCode` is served by the pick-list route.** §5.15 ruled on the ten reference kinds and did not cover step codes, which 2C-3's Process Steps designer must read. The ruling's own logic decides it: `glAccount` was excluded as "the one kind no data-entry screen ever reads", and step codes are the opposite. The narrow projection keeps their GL account unexposed, so the chart-of-accounts concern that excluded `glAccount` does not transfer.

## 8. Decisions taken by the planner

- **The registry is hand-written and sweep-enforced, not derived from Prisma's DMMF.** DMMF cannot express `detailPath`, `label` or `entityLabel`, the generated client is gitignored (so nothing may depend on it at author time), and a hand-written table with a schema-walking sweep is the idiom this repo already uses twice.
- **Resolution is by `name` because every reference kind's human key is `name`** — `REFERENCE_LABELS` already carries a per-kind `nameLabel` ("Account number" for GL accounts, "Code" for inspection codes) for display, so error messages use that label rather than the literal word "name".
- **The blocker list is computed on demand, not cached.** Blocker sets stay small for years — the system starts empty — and a stale cache on a data-integrity guard is worse than a query.

## 9. What 2C-2 and 2C-3 inherit

- Parts' four FK columns register in `reference-links.ts` and get name resolution, delete protection and paste-by-name for free.
- Parts screens consume `/api/picklists/[kind]` four times on one screen, and the steps designer consumes `processStepCode`.
- Every parts control gates through `permission-ui.ts`, including `change_prices` on the pricing block.
- **Do not add a revival-on-create site** (handoff §5.11): any new unique column on a soft-deletable model gets `@@unique([col], where: raw("\"deletedAt\" IS NULL"))`, and those attributes must stay on one line or the partial-unique sweep misses them.
