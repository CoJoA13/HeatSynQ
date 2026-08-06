# Phase 2B — Round 3 review fix wave

Branch `phase-2b-customers`, starting at `640f48f`. Scope: R1, R2, R3 from the third
automated review round. The other two round-3 findings (queued-edit rollback race;
contacts allowing document-delivery flags with a blank email) were triaged as minor,
filed as GitHub issues, and are untouched here.

File touched: `src/app/customers/[id]/page.tsx` (only file changed).

## R1 — `code` and `name` were not editable

Before this fix the customer's `code` and `name` rendered only as static header text
(`{c.code} — {c.name}`). Every other identity-bearing field on this page (address
names, contact names, defaultPo, notes, credit limit) was already editable in place
via an onChange-sets-local-state / onBlur-persists pattern. `code`/`name` were the one
exception, so a typo could only be fixed by delete-and-recreate — which the service
blocks outright once the customer has children, and which discards addresses/contacts
either way.

Fix: replaced the static `<h1>` with two `<input>` elements (`aria-label="Customer
code"` / `aria-label="Customer name"`), wired with the exact same shape used
everywhere else on this page:

```
<input value={c.code} onChange={(e) => setC({ ...c, code: e.target.value })}
       onBlur={(e) => save({ code: e.target.value })} />
```

This reuses `save()` unmodified for the network call, which means:
- `code` is trimmed and required server-side (`CREATE.partial().strict()` in
  `src/server/customers.ts`); a duplicate or blank code comes back as a field-anchored
  400 through `save()`'s existing error path.
- On rejection, `save()`'s catch does `load()` (revert to server truth) then
  `setError(msg)` — the input reverts to the last-saved value and the red error banner
  explains why, identical to every other field's behavior on this page (this is the
  "Fix C2" contract already documented in the file: the displayed value always matches
  actual state, so there's never a stale/rejected value left showing as if it might
  have been saved).
- No new client-side validation was added — `updateCustomer` already handles both
  fields; the UI just needed a way to send the PUT.

## R2 — rejected parent change reverted silently

`saveParent()` called `save()` and then *unconditionally* called `load()` again.
`save()`'s own failure path already does `await load(); setError(msg)`. The second,
unconditional `load()` in `saveParent()` ran after that and reset `error` back to
`null` (via `load()`'s own `setError(null)` on its success), silently erasing the
message the user was supposed to see. Net effect: selecting a parent that trips the
cycle guard reverted the `<select>` and said nothing about why.

The instructions were explicit that this is the third recurrence of the same
"a reload clears the error that was just set" shape on this page, and asked for a fix
that closes the door on recurrence rather than special-casing this one caller.

### How `save()` was restructured

`save()` now returns `Promise<boolean>` — `true` if the PUT succeeded, `false` if it
was rejected (mirroring the contract `call()` already offered its own callers, e.g.
for the "add address"/"add contact" forms deciding whether to clear a draft):

```ts
async function save(body: Partial<Customer>): Promise<boolean> {
  setC((cur) => (cur ? { ...cur, ...body } : cur));
  const key = Object.keys(body).sort().join(",");
  return serial(key, async () => {
    try {
      await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null);
      return true;
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
      return false;
    }
  });
}
```

`saveParent()` now only reloads when `save()` reports success:

```ts
async function saveParent(parentId: string) {
  if (await save({ parentId: parentId || null })) await load().catch(() => {});
}
```

### Why this prevents recurrence

Previously every caller of `save()` that needed a post-save reload had to remember,
independently, "only reload if it actually succeeded" — an implicit rule nowhere
enforced by the type system, which is exactly how it was missed for `saveParent()`.
Now `save()`'s own return type carries that fact explicitly: a caller cannot reload
"after `save()`" without first deciding what to do with the boolean, because the only
thing `save()` hands back *is* that boolean. There is no second, parallel reload path
left for a future caller to bolt on incorrectly — reload-on-success is now expressed as
"if (await save(...))" at the call site, not as an unconditional statement someone has
to remember to guard. The single-shot callers (`toggleContactFlag`,
`saveAddressField`, `saveContactField`) were deliberately left as void-returning —
they never reload a second time, so they don't have this trap to fall into, and
changing their shape wasn't necessary to close the recurrence.

## R3 — inactive assigned parent rendered as "— none —"

`getCustomer()` (`src/server/customers.ts`) keeps returning `parentId` even when the
parent's `active` flag is `false` — only a *soft-deleted* parent is disallowed
(`assertParentExists`/`assertNoCycle` check `deletedAt: null`, not `active`), and a
parent can never be soft-deleted while it still has children (`deleteCustomer` blocks
that). So an inactive-but-live parent is a legitimate, persistent state. The
parent-options fetch, however, only requested active customers
(`GET /api/customers`, which defaults `active: true` server-side per
`listCustomers()`), so the assigned-but-inactive parent was never in the `<select>`'s
option list — a controlled `<select>` whose `value` matches no `<option>` renders as
if nothing were selected, silently misrepresenting stored data.

Fix: fetch parent options with `includeInactive=1`:

```ts
useEffect(() => {
  api<CustomerOption[]>("/api/customers?includeInactive=1").then(setCustomers).catch(() => {});
}, []);
```

`listCustomers({ includeInactive: true })` still filters on `deletedAt: null` (verified
by reading `src/server/customers.ts`), so this cannot resurrect a soft-deleted parent
as an option — and a soft-deleted parent isn't a state that can occur anyway given the
children guard above. `CustomerOption` gained an `active: boolean` field, and the
`<option>` label appends `" (inactive)"` when `!x.active`, so inactive parents are
distinguishable rather than silently offered as if they were ordinary active
customers:

```tsx
<option key={x.id} value={x.id}>
  {x.code} — {x.name}{!x.active && " (inactive)"}
</option>
```

No separate "always include the currently-assigned parent" special case was needed —
fetching every non-deleted customer (active or not) is sufficient and simpler, and
matches the general instruction ("if you include inactive customers generally, label
them").

## Manual verification

No component/e2e test harness exists for this page in the repo (all existing customer
tests are API/service-level: `tests/customer-routes.test.ts`, `tests/customers.test.ts`,
`tests/customer-children.test.ts`, `tests/customer-paste.test.ts`). Per the
instructions, these are UI behaviors and needed to be exercised against a running dev
server rather than asserted purely by reading the diff.

A real (not simulated) browser was reachable: neither the `chrome-devtools` nor
`playwright` MCP tools could launch (`Could not find Google Chrome executable for
channel 'stable' at /opt/google/chrome/chrome`, and no `sudo` available to install
Chrome), but the `playwright` **npm package** already had its bundled Chromium cached
locally, and a plain Node script using `import { chromium } from "playwright"` launched
it successfully. I used that to drive real clicks/fills/blurs against
`npm run dev` on `http://localhost:3000`, logged in as the seeded `admin`/`admin`
user, and asserted on the live DOM and network responses. This is a genuine
click-through, just driven by a script instead of the MCP tool (which was unusable in
this sandbox).

Steps run (`/tmp/.../scratchpad/round3-verify.mjs`, three throwaway customers created
and deleted through the API each run):

1. Created `R3PARENT<ts>` / `R3CHILD<ts>` / `R3OTHER<ts>`, set `R3CHILD`'s parent to
   `R3PARENT`, set `R3PARENT.active = false`, set `R3OTHER`'s parent to `R3CHILD`
   (to set up a cycle for the R2 check).
2. **R3**: opened `/customers/<R3CHILD id>`. Parent `<select>`'s `.inputValue()`
   equalled the parent's id (not empty), and the selected `<option>`'s text was
   `"R3PARENT<ts> — R3 Parent Co (inactive)"` — confirmed present and correctly
   labelled, not silently reverted to "— none —".
3. **R1**: code/name inputs (`aria-label="Customer code"` / `"Customer name"`)
   pre-filled with the current values. Renamed the customer via the name input,
   blurred, reloaded the page fresh, and confirmed the new name persisted
   server-side. Then set the code input to `R3PARENT<ts>` (duplicate of the parent's
   live code) and blurred: PUT returned `400 {"error":"A customer with that code
   already exists"}`, the error banner text `"already exists"` was present in the
   page body, and the code input reverted to the original `R3CHILD<ts>` value —
   matching the same rollback-plus-visible-error contract as every other field.
4. **R2**: selected `R3OTHER` as `R3CHILD`'s parent (creating the cycle
   R3CHILD → R3OTHER → R3CHILD). PUT returned 400, the page body contained
   `"That parent would create a circular relationship"`, and the `<select>`'s value
   reverted to the *actual* original parent id (`R3PARENT`'s id) — not blank, and the
   error was visibly present (the bug this fixes: previously the second, unconditional
   `load()` in `saveParent()` would have cleared this exact message).
5. Cleaned up all three fixture customers via `DELETE` at the end of the script.
   Confirmed via `GET /api/customers?includeInactive=1` afterward that the dev
   database's customer table is empty (0 rows) — no leftover fixtures.

One flake worth recording: an early version of the script used a fixed
`page.waitForTimeout(700)` after `blur()` before checking for the duplicate-code error,
and intermittently read the DOM before the PUT had resolved, reporting a false
negative. Rewriting that one assertion to `Promise.all([page.waitForResponse(...),
codeInput.blur()])` (matching how the R2 check was already written) made it
deterministic and it then passed consistently across repeated runs. This was a test
harness timing issue, not an application bug — a standalone debug script confirmed the
400 and the error banner appear reliably as soon as the PUT settles.

## Gates

All from `/home/cojoa13/Desktop/HeatSynQ/erp`, after the fix, before commit:

```
$ npm test
 Test Files  30 passed (30)
      Tests  246 passed (246)
```

Baseline was 246; count is unchanged (no test files exercise this page, and no
existing test's expectations depend on it).

```
$ npx tsc --noEmit
(no output — clean)
```

```
$ npx eslint src tests
(no output — clean)
```

```
$ npm run build
✓ Compiled successfully in 1835ms
✓ Generating static pages (25/25)
Route (app) ...
├ ƒ /customers/[id]                            3.67 kB         107 kB
...
```

All four gates green.

## Deviations

None from the brief. No schema changes were made or needed — `updateCustomer`,
`createCustomer`'s revival path, `getCustomer`, and `listCustomers({ includeInactive
})` already supported everything required; this was purely a client-side wiring gap
(R1, R3) and a control-flow bug (R2).

## Things I was unsure about

- **R1's "must not lose the user's input if rejected" wording.** Read literally, the
  current `save()` contract (shared by every text field on this page, not just
  code/name) *does* revert the displayed value to server truth on rejection rather
  than leaving the user's just-typed text sitting in the box — that's the documented
  "Fix C2" behavior. I read the R1 instruction as "follow that existing, already-
  accepted rule for code/name too" (display always matches actual state, error
  surfaced, no silent swallow) rather than "invent a new draft-preserving mechanism
  unique to these two fields" — the latter would make code/name behave differently
  from every sibling field (defaultPo, notes, credit limit) for no stated reason, and
  the brief's own phrasing ("the same rule the rest of this page now follows") reads as
  confirming, not overriding, that existing contract. I did not add a separate local
  draft state for code/name; flagging this interpretation in case a stronger
  "literally never overwrite what's mid-typed on rejection" behavior was intended
  instead.
- Whether to also return a boolean from `toggleContactFlag`/`saveAddressField`/
  `saveContactField` for consistency with `save()`'s new signature. I left them as-is:
  none of their callers reload a second time, so they have no instance of the bug R2
  describes, and the instructions scoped the fix to `save()`/`saveParent()`
  specifically ("have save() report whether it succeeded and let callers act on
  that"). Changing their signature too seemed like scope creep without a corresponding
  bug to fix.
