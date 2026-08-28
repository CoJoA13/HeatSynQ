"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/fetcher";
import { HistoryPanel, invalidateHistory } from "@/components/HistoryPanel";
import { ADDRESS_KINDS, ADDRESS_KIND_LABELS, CONTACT_FLAGS, type AddressKind } from "@/lib/customer-constants";
import { CERT_SCOPES, CERT_SCOPE_LABELS, type CertScopeValue } from "@/lib/cert-constants";
import { gate, gateDo, type Gate } from "@/lib/permission-ui";
import { percentFromFraction, fractionFromPercent } from "@/lib/rate-display";
import { usePermissions } from "@/lib/use-permissions";
import { useEditGuard } from "@/lib/use-edit-guard";
import { useSaveScope } from "@/lib/save-scope";
import { BlockerPanel, type Blocker } from "@/components/BlockerPanel";
import { SurchargeOverridesSection } from "./SurchargeOverridesSection";
import { TemplateAssignmentsSection } from "./TemplateAssignmentsSection";
import { ReceivablesSection } from "./ReceivablesSection";

type Customer = {
  id: string; code: string; name: string; parentId: string | null; parentCode: string | null;
  termsId: string | null;
  // number|null once loaded from the server, but also string mid-edit — the input is bound
  // straight to this field (see C2) and the field's own draft text is a valid transient value
  // for it, sent to the server as-is (the server's `money` schema accepts a decimal string).
  creditLimit: number | string | null;
  financeChargeRate: number | string | null;
  // number|null once loaded, string mid-edit — same reason as creditLimit above. Unlike
  // creditLimit this is a real int server-side (z.number().int(), not decimalField), so the
  // commit path (below) parses it to a number itself rather than forwarding the typed text.
  requestDaysOverride: number | string | null;
  creditHold: boolean; cod: boolean; taxable: boolean; surchargeOptOut: boolean;
  // number|null once loaded, string mid-edit — the creditLimit precedent above. Overrides
  // BillingConfig.salesTaxRate (P5A §4.4); only ever applied when `taxable` is true.
  salesTaxRate: number | string | null;
  // Suppresses the certification charge for this customer regardless of the part/plant "bill for
  // cert" chain (P5A §4.4) — a blanket opt-out, the surchargeOptOut shape.
  certChargeSuppressed: boolean;
  /** Certification chain (spec §6.1): null = inherit the plant setting; a part can override
   *  either way. The `inheritedCert*` companions are what that null currently resolves to —
   *  computed server-side (customers.ts) so the three-state controls can label their "Inherit"
   *  option without a settings seam of their own. */
  certRequiredDefault: boolean | null; certScopeDefault: CertScopeValue | null;
  inheritedCertRequired: boolean; inheritedCertScope: CertScopeValue;
  defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string; active: boolean;
};
// `active` on both child types is carried and editable (round 5): the services have always
// supported the flag and their list routes have always accepted includeInactive, but this page
// exposed neither — so a row set inactive through the API vanished from the only screen that
// could have brought it back. Deletion here is soft and `active` is the "keep it for history,
// stop offering it" flag (handoff §5.4), which is a state a shop genuinely wants for an old dock
// or a contact who left.
type Address = {
  id: string; kind: AddressKind; name: string; street: string;
  city: string; state: string; zip: string; isDefault: boolean; active: boolean;
};
type Contact = {
  id: string; name: string; email: string; phone: string;
  getsShippers: boolean; getsInvoices: boolean; getsStatements: boolean; getsCerts: boolean;
  active: boolean;
};
// `active` is carried for the same reason CustomerOption below carries it (R3): an inactive
// terms record assigned to this customer must still appear as an option, labelled rather than
// silently dropped. See the fetch comment on the terms effect below.
type Term = { id: string; name: string; active: boolean };
// Slice of CustomerRow needed for the parent selector — every OTHER non-deleted customer
// (active or not, see R3 below), keyed by id so the current row can be excluded from its own
// option list. `active` is kept so an inactive option can be labelled rather than presented as
// if it were a normal, active customer.
type CustomerOption = { id: string; code: string; name: string; active: boolean };

const emptyAddrDraft = { kind: "SHIP_TO" as AddressKind, name: "", street: "", city: "", state: "", zip: "" };
const emptyContactDraft = { name: "", email: "", phone: "" };

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Next reuses this route's component instance across /customers/A -> /customers/B (only the
  // param changes, no remount). Keying the body by id forces a fresh instance per customer, so
  // the draft state below cannot carry one customer's unsaved content onto another customer's id.
  return <CustomerDetail key={id} id={id} />;
}

function CustomerDetail({ id }: { id: string }) {
  const router = useRouter();
  const [c, setC] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [addrDraft, setAddrDraft] = useState(emptyAddrDraft);
  const [contactDraft, setContactDraft] = useState(emptyContactDraft);
  const [showInactiveAddresses, setShowInactiveAddresses] = useState(false);
  const [showInactiveContacts, setShowInactiveContacts] = useState(false);
  // Add-buttons are disabled while their POST is in flight. Without this a double-click — an
  // ordinary way to press a button — submits the same draft twice, and since addresses and
  // contacts have no uniqueness constraint both requests commit, leaving duplicate rows and
  // duplicate audit entries the user then has to clean up by hand.
  //
  // The authoritative guard is the ref, not the state. `disabled` and the button label are
  // rendered output and only take effect once React has re-rendered; the second click of a
  // double-click can arrive before that, running the same handler closure with a stale `false`.
  // A ref updates synchronously on the first click, so the second one always sees it.
  const addingAddressRef = useRef(false);
  const addingContactRef = useRef(false);
  const [addingAddress, setAddingAddress] = useState(false);
  const [addingContact, setAddingContact] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // H4 (Codex round 3 review, owner ruling 2026-08-01, amends spec §11): deleteCustomer's parts
  // refusal used to be a bare count with nothing to click through — §11's "the parts list already
  // names every blocker" premise didn't hold (no true customer filter, inactive parts hidden by
  // default). Same shape as part-fields' `blocked` state (admin/part-fields/page.tsx): populated
  // only from the delete refusal below, cleared on dismiss.
  const [blocked, setBlocked] = useState<{ list: Blocker[] } | null>(null);
  // F4: a failed Terms or parent-options fetch used to report into `error`, the same state
  // `load()` resets to null on every successful customer refresh (below, and again after save()/
  // saveParent()/call() succeed). That refresh runs far more often than these two effects, so the
  // failure was wiped almost immediately while the corresponding options array stayed empty — and
  // the file's own comment on the Terms/parent <select>s explains why an empty options array is
  // dangerous, not just cosmetic: a controlled <select> whose value matches no <option> silently
  // renders "— none —", misrepresenting stored data and risking overwriting a real (if inactive)
  // Terms or parent on the next interaction. `optionsError` is its own state specifically so that
  // no unrelated refresh can clear it out from under the user; it is rendered as its own banner,
  // separate from `error`/`permsError` below, and reported per-source rather than clobbering an
  // earlier failure if both fetches happen to fail.
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const addOptionsError = useCallback((message: string) => {
    setOptionsError((cur) => (cur ? `${cur} ${message}` : message));
  }, []);
  // Permissions don't change while this page is mounted, so one fetch is enough (usePermissions,
  // src/lib/use-permissions.ts — shared with customers/page.tsx and ReferenceTable.tsx). A
  // failure surfaces through permsError, folded into the same error banner below, instead of
  // leaving every control silently stuck disabled.
  const { permissions: perms, error: permsError } = usePermissions();
  // Every set-of-`c`-from-server routes through `editGuard.applyPayload` so a reload landing
  // mid-typing — most notably save()'s own §5.13 failure-path rollback for a SIBLING field —
  // never resets the customer field the user is actively editing (use-edit-guard.ts; the
  // fix-wave notes-clobber trio, of which CertDetail.tsx and ShipmentDetail.tsx carry the same
  // shape). The address/contact ROW arrays route through the keyed `editGuard.applyRows` (#149): their
  // cells register collection + row id + field via `onFocusCell`, so an arriving server array
  // preserves the one cell under the cursor the same way. The collection scope is load-bearing
  // (Codex PR #154 round 1): applyDetail merges BOTH arrays back-to-back through this one
  // guard, and a focused contact's id is absent from the addresses array by definition — the
  // scope is what stops that absence from releasing (or clobbering) the registration.
  const editGuard = useEditGuard();
  // Every optimistic save registers with this scope and every reload routes through it
  // (save-scope.ts, issues #3/#15): a reload's GET waits out the registered save chains and
  // re-fetches if a save is dispatched mid-fetch, so a §5.13 rollback (or any other reload) can
  // never apply a payload that predates a newer save's optimistic value. The merge above
  // protects only the focused field mid-typing; the scope protects every committed-but-unloaded
  // value, the `addresses`/`contacts` rows included. Its internal latest-gate also orders
  // overlapping reloads (a show-inactive toggle's refetch racing a rollback), which this page —
  // alone among the detail pages — previously had nothing for.
  const saveScope = useSaveScope();

  const fetchDetail = useCallback(() => Promise.all([
    api<Customer>(`/api/customers/${id}`),
    api<Address[]>(`/api/customers/${id}/addresses${showInactiveAddresses ? "?includeInactive=1" : ""}`),
    api<Contact[]>(`/api/customers/${id}/contacts${showInactiveContacts ? "?includeInactive=1" : ""}`),
  ]), [id, showInactiveAddresses, showInactiveContacts]);
  const applyDetail = useCallback(([cust, addr, cont]: [Customer, Address[], Contact[]]) => {
    // applyPayload/applyRows capture the focus session ONCE at dispatch and return a pure
    // updater closed over it (use-edit-guard.ts, the round-3 fixpoint) — React defers the
    // 2nd/3rd updaters here past this whole function, so nothing an updater needs may live in
    // guard state it reads at run time.
    // #227: `salesTaxRate` is stored as a fraction but displayed as percent — convert BEFORE the
    // guard captures/applies, so the edit guard compares like with like (`financeChargeRate` is
    // already a percent number in storage; it passes through untouched).
    const shown: Customer = { ...cust, salesTaxRate: percentFromFraction(cust.salesTaxRate) };
    setC(editGuard.applyPayload(shown));
    setAddresses(editGuard.applyRows("addresses", addr));
    setContacts(editGuard.applyRows("contacts", cont));
  }, [editGuard]);
  const load = useCallback(
    () => saveScope.reload(fetchDetail, (data) => { applyDetail(data); setError(null); }),
    [saveScope, fetchDetail, applyDetail],
  );
  // The rollback variant skips load()'s setError(null): a rollback reload lands AFTER the
  // failure it rolls back was reported, and must never clear that banner (§5.13).
  const rollbackLoad = useCallback(
    () => saveScope.reload(fetchDetail, applyDetail),
    [saveScope, fetchDetail, applyDetail],
  );
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  const canDelete = gate(perms, "customers.delete");
  const canEdit = gate(perms, "customers.edit");
  const receivablesViewGate = gate(perms, "receivables.view");
  // #75: applying a credit memo CREATES an Application, so it takes `receivables.create` —
  // the same gate the route enforces, so the control is disabled-with-a-reason (§5.16)
  // rather than offered and then refused.
  // #211 (owner ruling, 2026-08-25): applying a CREDIT moves value between open items the way a
  // cash application does, so it takes the `apply_payments` named action on top of
  // `receivables.create` — matching POST /api/receivables/credit-applications, the route this
  // gate's controls call. The BatchDetail applyGateRaw shape, whichever-is-actually-the-blocker
  // title (§5.16). The write-off composition below deliberately does NOT build on this gate:
  // its route (POST /api/receivables/write-offs) requires create + write_off and no
  // apply_payments, and the UI gate must match the route it calls (the BatchDetail owner
  // ruling) — over-gating here would disable a control the server would accept.
  const receivablesCreateGate = gate(perms, "receivables.create");
  const applyActionGate = gateDo(perms, "apply_payments");
  const receivablesApplyBlocked = receivablesCreateGate.disabled || applyActionGate.disabled;
  const receivablesApplyGate: Gate = {
    allowed: !receivablesApplyBlocked, disabled: receivablesApplyBlocked,
    title: receivablesCreateGate.disabled ? receivablesCreateGate.title : applyActionGate.title,
  };
  // #77: a standalone write-off needs `receivables.create` AND the `write_off` special action — the
  // exact pair `POST /api/receivables/write-offs` enforces. Combined into ONE gate here (the
  // `BatchDetail` precedent) so the control renders visible-and-disabled naming whichever half is
  // actually blocking; "Requires receivables.create" and "Requires write_off" send an operator to
  // different conversations.
  const writeOffSpecialGate = gateDo(perms, "write_off");
  const writeOffBlocked = receivablesCreateGate.disabled || writeOffSpecialGate.disabled;
  const receivablesWriteOffGate: Gate = {
    allowed: !writeOffBlocked, disabled: writeOffBlocked,
    title: receivablesCreateGate.disabled ? receivablesCreateGate.title : writeOffSpecialGate.title,
  };
  // Voiding a write-off is a delete of the Application row — `receivables.delete`, what
  // `DELETE /api/receivables/applications/[id]` enforces.
  const receivablesVoidGate = gate(perms, "receivables.delete");
  // Terms options are global reference data, not per-customer — fetched once, independent of
  // `load()`. Session-only route (any signed-in user, no admin.view needed): a user holding
  // customers.edit but not admin.view must still see Terms options, and a failure here is
  // reported through `optionsError` (F4) rather than swallowed into a silent empty dropdown that
  // would look exactly like a shop with no terms configured.
  //
  // includeInactive=1 for the same reason the parent selector uses it (R3, below): marking a
  // Terms record inactive hides it from the default reference list but does NOT clear it from
  // the customers already assigned to it, and getCustomer() keeps returning that termsId. A
  // controlled <select> whose value matches no <option> falls back to rendering the blank
  // choice, which would claim no terms are assigned when in fact some are — and the next
  // interaction with the select would write that blank back over real data. Fetching inactive
  // rows too guarantees the assigned record is always present; it is labelled at render time so
  // it isn't mistaken for a normal pick. (Soft-DELETED terms can no longer be assigned at all —
  // assertRefExists in src/server/reference-guards.ts, called from createCustomer/updateCustomer
  // in src/server/customers.ts, rejects them on both create and update — so this list only has
  // to account for the inactive case.)
  useEffect(() => {
    api<Term[]>("/api/picklists/terms?includeInactive=1").then(setTerms)
      .catch((e) => addOptionsError(`Could not load terms: ${(e as Error).message}`));
  }, [addOptionsError]);
  // Parent-selector options: every OTHER non-deleted customer, fetched the same way terms are —
  // once, independent of `load()`, gated on the same customers.view permission that got the
  // user onto this page in the first place, so there's no permission mismatch to worry about
  // (unlike Terms/admin.view above). The current customer excludes itself at render time
  // (F4) rather than here, since `id` never changes for a mounted instance (see the `key={id}`
  // remount comment on CustomerDetailPage) but filtering at the call site keeps this effect
  // identical in shape to the Terms one above.
  //
  // includeInactive=1 (R3): the service permits an inactive customer as a parent and
  // getCustomer() keeps returning that parentId regardless of the parent's active flag. A
  // controlled <select> whose value matches no <option> silently renders as "— none —", which
  // would misrepresent stored data and risk clobbering a real (if inactive) parent on the next
  // interaction with the select. Fetching every non-deleted customer guarantees the assigned
  // parent is always present as an option; inactive ones are labelled at render time so they
  // aren't mistaken for active customers.
  //
  // A failed fetch produces exactly the "— none —" misread described above (the empty options
  // list has no entry matching c.parentId), and saveParent("") on the next interaction would
  // then write parentId: null over a real division link — so, like Terms above, the failure is
  // reported through `optionsError` (F4) rather than swallowed into a silent empty list.
  useEffect(() => {
    api<CustomerOption[]>("/api/customers?includeInactive=1").then(setCustomers)
      .catch((e) => addOptionsError(`Could not load parent options: ${(e as Error).message}`));
  }, [addOptionsError]);

  // Per-key request queue: guards against optimistic saves committing out of order. Without
  // this, two overlapping PUTs for the same field (an ordinary double-click on a checkbox before
  // the first request resolves) race on the network, and if the first happens to land last, the
  // database ends up holding the opposite of what the UI shows — the UI always reflects the LAST
  // optimistic update applied locally, but the database reflects whichever REQUEST happened to
  // be processed last, and those are not guaranteed to be the same request once two are in
  // flight at once. Serializing per key — never starting request N+1 for that key until request
  // N has settled — makes requests complete in the same order they were dispatched, so the last
  // one queued is always the last one to reach the database. A ref (not state) because this is
  // plumbing for in-flight requests, not something that should ever trigger a render.
  const queue = useRef<Map<string, Promise<unknown>>>(new Map());
  function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = queue.current.get(key) ?? Promise.resolve();
    // Chain onto the previous request's SETTLEMENT (success or failure), not its success alone —
    // one field's failed save must not permanently jam every later save to that same field.
    const next = prev.then(fn, fn);
    queue.current.set(key, next.catch(() => {}));
    return next;
  }

  // Optimistic: apply the change to local state immediately so a single click always lands
  // visually, then persist it. A controlled checkbox bound only to post-round-trip server state
  // can revert mid-flight and silently swallow a click; updating first avoids that. Every field
  // this touches is bound to `c` as a controlled value (not defaultValue), so when a rejected
  // save rolls back via load() below, the input's displayed text follows the reverted state
  // instead of continuing to show the text that was just rejected (Fix C2).
  //
  // Returns whether the save succeeded (R2). This is the same contract call() already offers
  // its callers (F6): the caller decides what to do next instead of save() deciding for every
  // caller by reloading unconditionally. That matters here because save() already reloads (and
  // sets the error) on its own failure path — a caller that reloads *again* afterward, without
  // checking success, clears an error that was just set (load() resets `error` to null on
  // success). This is the third time that exact "a reload clears the error that was just set"
  // shape has bitten this page (see the History: C2's own fix comment above, and toggleContact/
  // saveAddressField/saveContactField below which are single-shot and never hit it only because
  // nothing downstream of them reloads again). Returning a boolean here, once, closes the door
  // on every future caller making the same mistake — a caller that wants to reload after success
  // can simply check the return value first, and there is no second reload path left to forget.
  // `display` (#227): a field whose WIRE value differs from its shown text — the percent-typed
  // salesTaxRate sends the fraction — passes the shown text here, or the optimistic set below
  // would flash the wire convention into the input (the PUT echoes {ok:true}, so nothing lands
  // later to correct it).
  async function save(body: Partial<Customer>, display?: Partial<Customer>): Promise<boolean> {
    setC((cur) => (cur ? { ...cur, ...body, ...display } : cur));
    const key = Object.keys(body).sort().join(",");
    const settled = serial(key, async () => {
      try {
        await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(body) });
        setError(null);
        // #220: the header PUT is `auditedUpdate("customer", …)` and this page mounts the
        // customer's own <HistoryPanel> — but only `call()` (the address/contact children) was
        // wired, so a credit-hold flip, the most consequential header edit, never appeared in
        // the panel directly below it until an unrelated child action or a remount. The parts
        // structural twin fires it here; the #158 census could not see the gap, being per-FILE
        // and this file already invalidating elsewhere. Success path, the #124/#131 ordering.
        invalidateHistory();
        return true;
      } catch (e) {
        // §5.13 rollback, detached: report first, then fire rollbackLoad() WITHOUT awaiting it
        // — awaiting from inside this queued fn deadlocks, since the reload waits for every
        // registered save chain (this one included) to settle before its GET dispatches. The
        // no-clear apply means the reload can never wipe this banner however late it lands, and
        // the settle-defer means its payload postdates every save queued behind this one (#3).
        setError((e as Error).message);
        void rollbackLoad().catch(() => {});
        return false;
      }
    });
    // Registered at save call time, beside the optimistic set above: reloads defer to this
    // save's whole chain and re-fetch if it was dispatched mid-fetch (save-scope.ts).
    saveScope.begin(settled);
    return settled;
  }
  // Parent selection needs one extra step beyond a plain save(): the header's "Division of X"
  // text and this row's own option list are both derived from OTHER customers' data, which a
  // bare PUT {parentId} response can't refresh (the PUT only echoes {ok:true}). Reloading is
  // only correct once save() has actually succeeded (R2) — save() already reloads and sets the
  // error itself on failure, so reloading again unconditionally would clear that error before
  // the user ever saw why their selection was rejected (self-parent, cycle, deleted parent; the
  // field-anchored 400 the service already raises, with no client-side re-implementation of
  // those checks needed here).
  async function saveParent(parentId: string) {
    if (await save({ parentId: parentId || null })) await load().catch(() => {});
  }
  // call() never optimistically mutates local state before the request (unlike save() and
  // toggleContactFlag() below), so its catch has nothing to roll back and setError() here can
  // never be raced by a load()-triggered clear. Returns whether the MUTATION succeeded so a
  // caller that holds a draft (add address/add contact, F6) can decide whether it's safe to
  // clear it — clearing unconditionally would wipe a form the user still needs to correct.
  //
  // The mutation and the refresh are reported separately (round 6). They used to share one try,
  // so a GET failing inside load() — a dropped connection a moment after the POST committed —
  // came back as `false` with an error banner, which kept the draft on screen and invited the
  // user to submit it again. The row was already there, so the retry created a duplicate. What
  // the user needs to be told in that case is that the save worked and the screen is stale, not
  // that the save failed.
  // In-flight guard for the row action links (delete, make default), keyed by path+method. The
  // server is now atomic about a repeated delete (auditedSoftDelete claims the row conditionally
  // and the loser gets a 404), so this is not what makes the data correct — it is what stops an
  // ordinary double-click turning into a pointless error banner about a row the user did in fact
  // just delete. A ref, not state, for the same reason the add-buttons use one: the second click
  // can arrive before React re-renders.
  const inFlight = useRef<Set<string>>(new Set());

  async function call(path: string, init: RequestInit): Promise<boolean> {
    const key = `${init.method ?? "GET"} ${path}`;
    if (inFlight.current.has(key)) return false;
    inFlight.current.add(key);
    try {
      await api(path, init);
    } catch (e) {
      setError((e as Error).message);
      inFlight.current.delete(key);
      return false;
    }
    // #14 item 1, extended by #153: every caller of `call()` writes a `customerAddress` or
    // `customerContact` row, both registered children of this page's panel, so each one moves a
    // history the panel is displaying. Wired HERE rather than at the five call sites because
    // this is the single success path they share; on success, before the follow-up load.
    invalidateHistory();
    setError(null);
    try {
      await load();
    } catch (e) {
      setError(`Saved, but the page could not be refreshed — reload to see the current data. (${(e as Error).message})`);
    }
    inFlight.current.delete(key);
    return true;
  }

  // Blur-save guard (round 5/6). Every text field on this page saved unconditionally on blur, so
  // simply tabbing through the form sent a PUT per field and wrote an audit entry whose before
  // and after are identical — filling the history spec §9 promises with events that assert a
  // change nobody made. The snapshot-on-focus guard now lives in `editGuard` (use-edit-guard.ts,
  // the fix-wave notes-clobber trio — CertDetail.tsx and ShipmentDetail.tsx carry the same shape):
  // customer-bound fields register WHICH property is under the cursor (`noteFocusC`), so `load()`'s
  // merge above can preserve an in-flight edit when a failed sibling save's rollback (or any other
  // reload) lands mid-typing. Address/contact cells register WHICH COLLECTION, ROW (by id), and
  // field (`noteFocusCell` → the keyed variant, #149) — they used to carry only the plain no-op
  // guard (`onFocusField(null)`), which left applyDetail's whole-array `setAddresses`/
  // `setContacts` free to reset the cell under the cursor whenever a reload landed mid-typing.
  // The collection names here must match applyDetail's mergeRows calls above — the scope is
  // what keeps the addresses merge from touching a contact cell's registration and vice versa.
  const noteFocusCell = (collection: "addresses" | "contacts", rowId: string, field: string) =>
    editGuard.onFocusCell(collection, rowId, field);
  const noteFocusC = (key: keyof Customer & string) => editGuard.onFocusField(key);
  // `trim` mirrors the server's own zod .trim() on that specific field (customer code and name,
  // contact name). Applying it here as well keeps the input showing what was actually stored:
  // otherwise the server saved "Acme" while the box went on displaying " Acme " indefinitely,
  // since a successful save neither returns nor reloads the normalized row. Trimming also feeds
  // the no-op comparison, so adding and removing a trailing space is correctly seen as no change.
  function onBlurSave(
    e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
    opts: { trim?: boolean },
    commit: (value: string, atFocus: string) => void,
  ) {
    editGuard.onBlurSave(e, commit, opts);
  }
  // Deliberately not routed through call(): call() reloads on success, and this record no longer
  // exists on success — the reload would 404 and replace the list we're navigating to with an
  // error. The failure path matters just as much as the success one here, because deleteCustomer
  // legitimately refuses in cases the user can act on (a customer that still has child
  // customers), and that 400 has to stay on screen instead of being swallowed by a navigation.
  // prompt() rather than confirm() because spec §9 requires a reason on a destructive action,
  // and this is one on three counts: the addresses and contacts go with it, the code becomes
  // reusable by an unrelated future customer, and the row is invisible to every list afterwards.
  // The reason is what lets whoever reads the history later tell a typo cleanup from a real
  // removal. The server requires it too (deleteCustomer), so an empty one is rejected there as
  // well — this check only spares the user a round trip.
  async function removeCustomer() {
    if (!c) return;
    const reason = prompt(
      `Delete customer "${c.code} — ${c.name}"?\n\n` +
      `Its addresses and contacts are deleted with it. The code can be reused later, ` +
      `which starts a fresh customer rather than restoring this one.\n\n` +
      `Reason for deleting (recorded in the audit history):`
    );
    if (reason === null) return; // cancelled
    if (!reason.trim()) {
      setError("A reason is required to delete a customer.");
      return;
    }
    try {
      await api(`/api/customers/${id}`, { method: "DELETE", body: JSON.stringify({ reason }) });
      router.push("/customers");
    } catch (e) {
      // H4: a refusal naming live parts is not a dead end (part-fields/page.tsx's blocked-delete
      // handler precedent) — fetch the list this message's count refers to and make it
      // exportable, rather than leaving the admin with only a number. Matched on "still has" plus
      // "part(s)", "live order(s)" (Task 15's own direct-orders guard, customers.ts), "live
      // quote(s)" (Task 7's quotes guard) or "live payment(s)" (#84's cash guard) so the unrelated
      // "still has child customers" refusal (no blockers route exists for that one) still falls
      // straight through to the plain error banner below. The blockers route itself always returns
      // the UNION of live parts, orders, quotes and payments (route comment,
      // src/app/api/customers/[id]/blockers/route.ts), so whichever guard fired first, the panel
      // still shows everything blocking the delete — never just the category that happened to throw.
      //
      // ⚠️ THIS LIST MUST GROW WITH THE SERVICE'S GUARDS. It is a message-text match, so a new guard
      // whose wording is not added here degrades silently to a bare error banner with no blocker
      // list and no export — a refusal with no route out, which is precisely the dead end §5.14
      // exists to prevent. #84 added the fourth guard and this line with it.
      const message = (e as Error).message;
      if (e instanceof ApiError && e.status === 400 && message.includes("still has")
        && (message.includes("part(s)") || message.includes("live order(s)")
          || message.includes("live quote(s)") || message.includes("live payment(s)"))) {
        try {
          const list = await api<Blocker[]>(`/api/customers/${id}/blockers`);
          if (list.length) { setBlocked({ list }); setError(null); return; }
        } catch (listErr) {
          setError(`${message} — the list of what's using it could not be loaded ` +
            `(${(listErr as Error).message}). Try again.`);
          return;
        }
      }
      setError(message);
    }
  }
  async function toggleContactFlag(ct: Contact, key: (typeof CONTACT_FLAGS)[number]["key"], value: boolean) {
    setContacts((cur) => cur.map((row) => (row.id === ct.id ? { ...row, [key]: value } : row)));
    const settled = serial(`contact:${ct.id}:${key}`, async () => {
      try {
        await api(`/api/customers/${id}/contacts/${ct.id}`, { method: "PUT", body: JSON.stringify({ [key]: value }) });
        invalidateHistory(); // #14 item 1 — success path, before the rollback/refresh branches
        setError(null);
      } catch (e) {
        // Detached no-clear rollback, the save() shape above (§5.13; #15's cross-key clobber —
        // this GET must not revert a sibling row's in-flight optimistic toggle).
        setError((e as Error).message);
        void rollbackLoad().catch(() => {});
      }
    });
    saveScope.begin(settled);
    await settled;
  }
  // Same optimistic-then-persist shape as save()/toggleContactFlag(), scoped to one address or
  // contact row rather than the customer itself — this is what gives existing address/contact
  // rows a way to correct a scalar field (A1/A3) without a modal: type into the cell, blur it.
  // Reports success for the same reason save() does (R2): a caller that needs to refresh
  // server-derived state afterwards must be able to tell success from failure, because the
  // failure path here already reloads and sets the error — reloading again unconditionally
  // would clear that error before the user saw it.
  async function saveAddressField(a: Address, patch: Partial<Address>): Promise<boolean> {
    setAddresses((cur) => cur.map((row) => (row.id === a.id ? { ...row, ...patch } : row)));
    const key = `address:${a.id}:${Object.keys(patch).sort().join(",")}`;
    const settled = serial(key, async () => {
      try {
        await api(`/api/customers/${id}/addresses/${a.id}`, { method: "PUT", body: JSON.stringify(patch) });
        invalidateHistory(); // #14 item 1
        setError(null);
        return true;
      } catch (e) {
        // Detached no-clear rollback, the save() shape above (§5.13).
        setError((e as Error).message);
        void rollbackLoad().catch(() => {});
        return false;
      }
    });
    saveScope.begin(settled);
    return settled;
  }
  // Changing an address's KIND needs the extra reload a scalar edit doesn't (same shape as
  // saveParent above): the server re-normalizes the default flag across both the kind being
  // joined and the kind being vacated, and listAddresses orders rows by kind — neither of which
  // the optimistic local patch can predict. Without the reload the badges and row order would
  // keep describing the old arrangement until something else refreshed the page.
  async function saveAddressKind(a: Address, kind: AddressKind) {
    if (await saveAddressField(a, { kind })) await load().catch(() => {});
  }
  async function saveContactField(ct: Contact, patch: Partial<Contact>) {
    setContacts((cur) => cur.map((row) => (row.id === ct.id ? { ...row, ...patch } : row)));
    const key = `contact:${ct.id}:${Object.keys(patch).sort().join(",")}`;
    const settled = serial(key, async () => {
      try {
        await api(`/api/customers/${id}/contacts/${ct.id}`, { method: "PUT", body: JSON.stringify(patch) });
        invalidateHistory(); // #14 item 1
        setError(null);
      } catch (e) {
        // Detached no-clear rollback, the save() shape above (§5.13).
        setError((e as Error).message);
        void rollbackLoad().catch(() => {});
      }
    });
    saveScope.begin(settled);
    await settled;
  }

  if (!c) return <div className="p-6">{error ?? permsError ?? optionsError ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      {/* R1: code and name were previously static header text — the only way to fix a typo in
          either was to delete and re-create the customer, which is blocked outright once it has
          children and discards its addresses/contacts either way. Editable in place now, using
          the same onChange-sets-local/onBlur-saves shape as defaultPo etc. below: `code` is the
          customer's unique identity and is trimmed/required server-side, so a duplicate or blank
          value comes back as a field-anchored 400 through save()'s existing error path — the
          input reverts to server truth and the error banner explains why, same as every other
          field on this page (Fix C2). */}
      <div className="mb-1 flex flex-wrap items-baseline gap-2">
        <input value={c.code} aria-label="Customer code" onFocus={noteFocusC("code")} readOnly={!canEdit.allowed}
               onChange={(e) => setC({ ...c, code: e.target.value })}
               onBlur={(e) => onBlurSave(e, { trim: true }, (code) => void save({ code }))}
               className="w-40 rounded border px-2 py-1 font-mono text-xl font-semibold read-only:bg-slate-50" />
        <span className="text-2xl font-semibold text-slate-400">—</span>
        <input value={c.name} aria-label="Customer name" onFocus={noteFocusC("name")} readOnly={!canEdit.allowed}
               onChange={(e) => setC({ ...c, name: e.target.value })}
               onBlur={(e) => onBlurSave(e, { trim: true }, (name) => void save({ name }))}
               className="min-w-[16rem] flex-1 rounded border px-2 py-1 text-xl font-semibold read-only:bg-slate-50" />
        <button onClick={removeCustomer} disabled={canDelete.disabled} title={canDelete.title}
                className="ml-auto text-sm text-red-600 disabled:cursor-not-allowed disabled:text-slate-400">
          Delete customer
        </button>
      </div>
      {c.parentCode && <p className="mb-3 text-sm text-slate-500">Division of {c.parentCode}</p>}
      {(error ?? permsError) && (
        <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error ?? permsError}</p>
      )}
      {/* F4: its own banner, its own state — a customer refresh (load(), which resets `error` to
          null on every success) must not be able to silently clear a report that the Terms or
          parent options failed to load, since the Terms/Parent <select>s below stay empty (and
          silently misrepresent stored data) until the page is reloaded. */}
      {optionsError && (
        <p className="mb-3 rounded bg-amber-50 p-2 text-sm text-amber-800">{optionsError}</p>
      )}
      {blocked && (
        <BlockerPanel
          label="customer"
          rowName={`${c.code} — ${c.name}`}
          list={blocked.list}
          action="delete"
          exportHref={`/api/customers/${id}/blockers/export`}
          onDismiss={() => setBlocked(null)}
        />
      )}

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Commercial</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.creditHold} disabled={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => save({ creditHold: e.target.checked })} />
            Credit hold
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.taxable} disabled={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => save({ taxable: e.target.checked })} />
            Taxable
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.cod} disabled={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => save({ cod: e.target.checked })} />
            COD
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.active} disabled={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => save({ active: e.target.checked })} />
            Active
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.surchargeOptOut} disabled={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => save({ surchargeOptOut: e.target.checked })} />
            Surcharge opt-out
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.certChargeSuppressed} disabled={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => save({ certChargeSuppressed: e.target.checked })} />
            Suppress certification charge
          </label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-sm">
            Terms
            <select value={c.termsId ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
                    onChange={(e) => save({ termsId: e.target.value || null })}
                    className="ml-2 rounded border px-2 py-1">
              <option value="">—</option>
              {terms.map((t) => (
                <option key={t.id} value={t.id}>{t.name}{!t.active && " (inactive)"}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Parent
            {/* Blank means no parent. The current customer is excluded from its own option
                list; everything else the service rejects (self-parent, cycle, deleted parent)
                is surfaced through saveParent()'s existing error path rather than re-checked
                here. */}
            <select value={c.parentId ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
                    onChange={(e) => void saveParent(e.target.value)}
                    className="ml-2 rounded border px-2 py-1">
              <option value="">— none —</option>
              {customers.filter((x) => x.id !== id).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.code} — {x.name}{!x.active && " (inactive)"}
                </option>
              ))}
            </select>
          </label>
          <label className="block text-sm">
            Default PO
            <input value={c.defaultPo} onFocus={noteFocusC("defaultPo")} readOnly={!canEdit.allowed}
                   onChange={(e) => setC({ ...c, defaultPo: e.target.value })}
                   onBlur={(e) => onBlurSave(e, {}, (defaultPo) => void save({ defaultPo }))}
                   className="ml-2 rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block text-sm">
            Credit limit
            <input value={c.creditLimit ?? ""} inputMode="decimal" onFocus={noteFocusC("creditLimit")} readOnly={!canEdit.allowed}
                   onChange={(e) => setC({ ...c, creditLimit: e.target.value })}
                   onBlur={(e) => onBlurSave(e, {}, (v) => void save({ creditLimit: v === "" ? null : v }))}
                   className="ml-2 w-32 rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block text-sm">
            Finance charge (monthly %)
            <input value={c.financeChargeRate ?? ""} inputMode="decimal" placeholder="1.5000" onFocus={noteFocusC("financeChargeRate")} readOnly={!canEdit.allowed}
                   onChange={(e) => setC({ ...c, financeChargeRate: e.target.value })}
                   onBlur={(e) => onBlurSave(e, {}, (v) => void save({ financeChargeRate: v === "" ? null : v }))}
                   className="ml-2 w-32 rounded border px-2 py-1 read-only:bg-slate-50" />
          </label>
          <label className="block text-sm">
            {/* Overrides BillingConfig.salesTaxRate (P5A §4.4). Shown and typed as a PERCENT
                (#227), matching admin/billing/page.tsx; the STORED value stays the fraction, so
                the blur converts for the wire and passes the typed text as save()'s display
                override. Blank inherits the plant rate. */}
            Sales tax rate (%)
            <input value={c.salesTaxRate ?? ""} inputMode="decimal" placeholder="4.00"
                   onFocus={noteFocusC("salesTaxRate")} readOnly={!canEdit.allowed}
                   onChange={(e) => setC({ ...c, salesTaxRate: e.target.value })}
                   onBlur={(e) => onBlurSave(e, {}, (v) => void save(
                     { salesTaxRate: v === "" ? null : fractionFromPercent(v) },
                     { salesTaxRate: v === "" ? null : v },
                   ))}
                   className="ml-2 w-32 rounded border px-2 py-1 read-only:bg-slate-50" />
            <span className="ml-2 text-xs text-slate-500">Blank uses the plant default.</span>
          </label>
          <label className="block text-sm">
            Request days override
            {/* A real int server-side (z.number().int()), unlike the decimal fields above — the
                typed text is parsed to a number before save() ever sees it, the parts/[id]/
                IdentitySection.tsx Load qty/Request days override precedent. Blank clears the
                override, falling back to the plant default (spec §7.1's chain — orders.ts). */}
            <input value={c.requestDaysOverride ?? ""} inputMode="numeric" onFocus={noteFocusC("requestDaysOverride")}
                   readOnly={!canEdit.allowed} title={canEdit.title}
                   onChange={(e) => setC({ ...c, requestDaysOverride: e.target.value })}
                   onBlur={(e) => onBlurSave(e, {}, (v, atFocus) => {
                     const trimmed = v.trim();
                     if (trimmed === "") { void save({ requestDaysOverride: null }); return; }
                     const n = Number(trimmed);
                     if (!Number.isInteger(n)) {
                       // Roll the box back to what it held on entry — `atFocus` is the guard's
                       // own snapshot (use-edit-guard.ts), the old `focusedValue.current`.
                       setC((cur) => (cur ? { ...cur, requestDaysOverride: atFocus } : cur));
                       setError("Request days override must be a whole number.");
                       return;
                     }
                     void save({ requestDaysOverride: n });
                   })}
                   className="ml-2 w-20 rounded border px-2 py-1 read-only:bg-slate-50" />
            <span className="ml-2 text-xs text-slate-500">Blank uses the plant default.</span>
          </label>
          {/* Certification chain (spec §6.1, Task 17): three-state, never a checkbox — an
              explicit "No" and "inherit the plant" are different answers, and a part can still
              override either way. The Inherit option names what it currently resolves to (the
              plant settings — `inheritedCert*`, computed server-side), the parts/[id]/
              IdentitySection sibling of the same control. */}
          <label className="block text-sm">
            Certification required default
            <select value={c.certRequiredDefault === null ? "" : c.certRequiredDefault ? "yes" : "no"}
                    disabled={!canEdit.allowed} title={canEdit.title}
                    onChange={(e) => save({ certRequiredDefault: e.target.value === "" ? null : e.target.value === "yes" })}
                    className="ml-2 rounded border px-2 py-1 disabled:bg-slate-100">
              <option value="">Inherit plant — currently {c.inheritedCertRequired ? "Yes" : "No"}</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </label>
          <label className="block text-sm">
            Certification scope default
            <select value={c.certScopeDefault ?? ""} disabled={!canEdit.allowed} title={canEdit.title}
                    onChange={(e) => save({ certScopeDefault: e.target.value === "" ? null : e.target.value as CertScopeValue })}
                    className="ml-2 rounded border px-2 py-1 disabled:bg-slate-100">
              <option value="">Inherit plant — currently {CERT_SCOPE_LABELS[c.inheritedCertScope]}</option>
              {CERT_SCOPES.map((s) => <option key={s} value={s}>{CERT_SCOPE_LABELS[s]}</option>)}
            </select>
          </label>
        </div>
      </section>

      <SurchargeOverridesSection customerId={id} perms={perms} onError={setError} onOptionsError={addOptionsError} />

      <TemplateAssignmentsSection customerId={id} perms={perms} onError={setError} onOptionsError={addOptionsError} />

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Standing notes</h2>
        {([["orderNotes", "At order entry"], ["shippingNotes", "At shipping"], ["invoiceNotes", "At invoicing"]] as const)
          .map(([key, label]) => (
            <label key={key} className="mb-2 block text-sm">
              {label}
              <textarea value={c[key]} rows={2} onFocus={noteFocusC(key)} readOnly={!canEdit.allowed}
                        onChange={(e) => setC({ ...c, [key]: e.target.value })}
                        onBlur={(e) => onBlurSave(e, {}, (v) => void save({ [key]: v }))}
                        className="mt-1 w-full rounded border p-2 read-only:bg-slate-50" />
            </label>
          ))}
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Addresses</h2>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={showInactiveAddresses}
                   onChange={(e) => setShowInactiveAddresses(e.target.checked)} />
            Show inactive
          </label>
        </div>
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="py-1">Kind</th><th>Name</th><th>Street</th><th>City</th><th>State</th><th>Zip</th>
              <th className="px-1">Active</th><th /><th />
            </tr>
          </thead>
          <tbody>
            {addresses.map((a) => (
              <tr key={a.id} className="border-t">
                {/* Editable rather than static text: an address typed as Bill To when it should
                    have been Ship To was previously correctable only by deleting the row and
                    re-keying all six fields, even though updateAddress() has always accepted a
                    kind change — and it handles the consequences properly, re-normalizing the
                    default flag for BOTH the kind being joined and the one being vacated, so a
                    moved default neither duplicates nor disappears. Same optimistic
                    onChange-saves shape as the scalar cells beside it. */}
                <td className="py-1">
                  <select value={a.kind} className="rounded border px-1 py-0.5" disabled={!canEdit.allowed}
                          title={canEdit.title}
                          onChange={(e) => void saveAddressKind(a, e.target.value as AddressKind)}>
                    {ADDRESS_KINDS.map((k) => (
                      <option key={k} value={k}>{ADDRESS_KIND_LABELS[k]}</option>
                    ))}
                  </select>
                </td>
                <td>
                  <input value={a.name} className="w-28 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("addresses", a.id,"name")} readOnly={!canEdit.allowed}
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, name: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (name) => void saveAddressField(a, { name }))} />
                </td>
                <td>
                  <input value={a.street} className="w-28 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("addresses", a.id,"street")} readOnly={!canEdit.allowed}
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, street: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (street) => void saveAddressField(a, { street }))} />
                </td>
                <td>
                  <input value={a.city} className="w-20 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("addresses", a.id,"city")} readOnly={!canEdit.allowed}
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, city: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (city) => void saveAddressField(a, { city }))} />
                </td>
                <td>
                  <input value={a.state} className="w-12 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("addresses", a.id,"state")} readOnly={!canEdit.allowed}
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, state: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (state) => void saveAddressField(a, { state }))} />
                </td>
                <td>
                  <input value={a.zip} className="w-16 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("addresses", a.id,"zip")} readOnly={!canEdit.allowed}
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, zip: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (zip) => void saveAddressField(a, { zip }))} />
                </td>
                {/* Round 5: deactivating re-normalizes the kind's default flag server-side
                    (normalizeDefaultsIn drops the flag from an inactive row and promotes another),
                    so this reloads on success like the kind change does rather than trusting the
                    optimistic patch. */}
                <td className="px-1 text-center">
                  <input type="checkbox" checked={a.active} aria-label={`Address ${a.name} active`}
                         disabled={!canEdit.allowed} title={canEdit.title}
                         onChange={async (e) => {
                           if (await saveAddressField(a, { active: e.target.checked })) {
                             await load().catch(() => {});
                           }
                         }} />
                </td>
                <td>{a.isDefault && <span className="rounded bg-slate-200 px-1 text-xs">default</span>}</td>
                <td className="text-right">
                  {!a.isDefault && (
                    <button className="mr-3 text-xs text-slate-600 disabled:cursor-not-allowed disabled:text-slate-400"
                            disabled={canEdit.disabled} title={canEdit.title}
                            onClick={() => call(`/api/customers/${id}/addresses/${a.id}`,
                              { method: "PUT", body: JSON.stringify({ isDefault: true }) })}>
                      make default
                    </button>
                  )}
                  <button className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400"
                          disabled={canEdit.disabled} title={canEdit.title}
                          onClick={() => call(`/api/customers/${id}/addresses/${a.id}`, { method: "DELETE" })}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex flex-wrap gap-1">
          <select value={addrDraft.kind} className="rounded border px-2 py-1 text-sm"
                  onChange={(e) => setAddrDraft({ ...addrDraft, kind: e.target.value as AddressKind })}>
            {ADDRESS_KINDS.map((k) => <option key={k} value={k}>{ADDRESS_KIND_LABELS[k]}</option>)}
          </select>
          <input value={addrDraft.name} placeholder="Name" className="w-28 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, name: e.target.value })} />
          <input value={addrDraft.street} placeholder="Street" className="w-32 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, street: e.target.value })} />
          <input value={addrDraft.city} placeholder="City" className="w-24 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, city: e.target.value })} />
          <input value={addrDraft.state} placeholder="State" className="w-14 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, state: e.target.value })} />
          <input value={addrDraft.zip} placeholder="Zip" className="w-20 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, zip: e.target.value })} />
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50"
                  disabled={addingAddress || canEdit.disabled}
                  title={canEdit.disabled ? canEdit.title : undefined}
                  // F6: the draft is cleared only once the POST has actually succeeded — call()
                  // now reports success/failure, so a failed save leaves everything the user
                  // typed in place to correct and resubmit, instead of wiping a six-field form
                  // out from under them before the response even comes back.
                  onClick={async () => {
                    if (addingAddressRef.current) return;
                    addingAddressRef.current = true;
                    setAddingAddress(true);
                    try {
                      if (await call(`/api/customers/${id}/addresses`,
                        { method: "POST", body: JSON.stringify(addrDraft) })) {
                        setAddrDraft(emptyAddrDraft);
                      }
                    } finally {
                      addingAddressRef.current = false;
                      setAddingAddress(false);
                    }
                  }}>
            {addingAddress ? "Adding…" : "Add address"}
          </button>
        </div>
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Contacts</h2>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={showInactiveContacts}
                   onChange={(e) => setShowInactiveContacts(e.target.checked)} />
            Show inactive
          </label>
        </div>
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>Name</th><th>Email</th><th>Phone</th>
              {CONTACT_FLAGS.map((f) => <th key={f.key} className="px-1">{f.label}</th>)}
              <th className="px-1">Active</th><th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((ct) => (
              <tr key={ct.id} className="border-t">
                <td className="py-1">
                  <input value={ct.name} className="w-28 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("contacts", ct.id,"name")} readOnly={!canEdit.allowed}
                         onChange={(e) => setContacts((cur) =>
                           cur.map((row) => (row.id === ct.id ? { ...row, name: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, { trim: true }, (name) => void saveContactField(ct, { name }))} />
                </td>
                <td>
                  <input value={ct.email} className="w-36 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("contacts", ct.id,"email")} readOnly={!canEdit.allowed}
                         onChange={(e) => setContacts((cur) =>
                           cur.map((row) => (row.id === ct.id ? { ...row, email: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (email) => void saveContactField(ct, { email }))} />
                </td>
                <td>
                  <input value={ct.phone} className="w-24 rounded border px-1 py-0.5 read-only:bg-slate-50"
                         onFocus={noteFocusCell("contacts", ct.id,"phone")} readOnly={!canEdit.allowed}
                         onChange={(e) => setContacts((cur) =>
                           cur.map((row) => (row.id === ct.id ? { ...row, phone: e.target.value } : row)))}
                         onBlur={(e) => onBlurSave(e, {}, (phone) => void saveContactField(ct, { phone }))} />
                </td>
                {CONTACT_FLAGS.map((f) => (
                  <td key={f.key} className="px-1 text-center">
                    <input type="checkbox" checked={ct[f.key]} disabled={!canEdit.allowed} title={canEdit.title}
                           onChange={(e) => toggleContactFlag(ct, f.key, e.target.checked)} />
                  </td>
                ))}
                <td className="px-1 text-center">
                  <input type="checkbox" checked={ct.active} aria-label={`Contact ${ct.name} active`}
                         disabled={!canEdit.allowed} title={canEdit.title}
                         onChange={(e) => saveContactField(ct, { active: e.target.checked })} />
                </td>
                <td className="text-right">
                  <button className="text-xs text-red-600 disabled:cursor-not-allowed disabled:text-slate-400"
                          disabled={canEdit.disabled} title={canEdit.title}
                          onClick={() => call(`/api/customers/${id}/contacts/${ct.id}`, { method: "DELETE" })}>
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-1">
          <input value={contactDraft.name} placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setContactDraft({ ...contactDraft, name: e.target.value })} />
          <input value={contactDraft.email} placeholder="Email" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setContactDraft({ ...contactDraft, email: e.target.value })} />
          <input value={contactDraft.phone} placeholder="Phone" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setContactDraft({ ...contactDraft, phone: e.target.value })} />
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white disabled:opacity-50"
                  disabled={addingContact || canEdit.disabled}
                  title={canEdit.disabled ? canEdit.title : undefined}
                  // F6: same fix as "Add address" above — reset only after the POST succeeds,
                  // and the same double-submit guard.
                  onClick={async () => {
                    if (addingContactRef.current) return;
                    addingContactRef.current = true;
                    setAddingContact(true);
                    try {
                      if (await call(`/api/customers/${id}/contacts`,
                        { method: "POST", body: JSON.stringify(contactDraft) })) {
                        setContactDraft(emptyContactDraft);
                      }
                    } finally {
                      addingContactRef.current = false;
                      setAddingContact(false);
                    }
                  }}>
            {addingContact ? "Adding…" : "Add contact"}
          </button>
        </div>
      </section>

      <ReceivablesSection
        customerId={id}
        viewGate={receivablesViewGate}
        applyGate={receivablesApplyGate}
        writeOffGate={receivablesWriteOffGate}
        voidGate={receivablesVoidGate}
      />

      <HistoryPanel entity="customer" entityId={c.id} />
    </div>
  );
}
