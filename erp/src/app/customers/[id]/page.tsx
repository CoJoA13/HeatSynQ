"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { ADDRESS_KINDS, ADDRESS_KIND_LABELS, CONTACT_FLAGS, type AddressKind } from "@/lib/customer-constants";

type Customer = {
  id: string; code: string; name: string; parentId: string | null; parentCode: string | null;
  termsId: string | null;
  // number|null once loaded from the server, but also string mid-edit — the input is bound
  // straight to this field (see C2) and the field's own draft text is a valid transient value
  // for it, sent to the server as-is (the server's `money` schema accepts a decimal string).
  creditLimit: number | string | null;
  financeChargeRate: number | string | null;
  creditHold: boolean; cod: boolean; taxable: boolean; surchargeOptOut: boolean;
  defaultPo: string; orderNotes: string; shippingNotes: string; invoiceNotes: string; active: boolean;
};
type Address = {
  id: string; kind: AddressKind; name: string; street: string;
  city: string; state: string; zip: string; isDefault: boolean;
};
type Contact = {
  id: string; name: string; email: string; phone: string;
  getsShippers: boolean; getsInvoices: boolean; getsStatements: boolean; getsCerts: boolean;
};
type Term = { id: string; name: string };

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
  const [c, setC] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [terms, setTerms] = useState<Term[]>([]);
  const [addrDraft, setAddrDraft] = useState(emptyAddrDraft);
  const [contactDraft, setContactDraft] = useState(emptyContactDraft);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cust, addr, cont] = await Promise.all([
      api<Customer>(`/api/customers/${id}`),
      api<Address[]>(`/api/customers/${id}/addresses`),
      api<Contact[]>(`/api/customers/${id}/contacts`),
    ]);
    setC(cust); setAddresses(addr); setContacts(cont); setError(null);
  }, [id]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);
  // Terms options are global reference data, not per-customer — fetched once, independent of
  // `load()`. A user without admin.view (Terms lives under the admin reference API) simply sees
  // an empty list rather than a broken page: the select still renders with a blank option.
  useEffect(() => { api<Term[]>("/api/admin/reference/terms").then(setTerms).catch(() => {}); }, []);

  // Optimistic: apply the change to local state immediately so a single click always lands
  // visually, then persist it. A controlled checkbox bound only to post-round-trip server state
  // can revert mid-flight and silently swallow a click; updating first avoids that. Every field
  // this touches is bound to `c` as a controlled value (not defaultValue), so when a rejected
  // save rolls back via load() below, the input's displayed text follows the reverted state
  // instead of continuing to show the text that was just rejected (Fix C2).
  async function save(body: Partial<Customer>) {
    setC((cur) => (cur ? { ...cur, ...body } : cur));
    try {
      await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null);
    } catch (e) {
      // Roll back to server truth first, then report why — load() clears the error on
      // success, so setting the error before the reload lets that clear wipe it out
      // before the user ever sees it.
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }
  // call() never optimistically mutates local state before the request (unlike save() and
  // toggleContactFlag() below), so its catch has nothing to roll back and setError() here can
  // never be raced by a load()-triggered clear.
  async function call(path: string, init: RequestInit) {
    try { await api(path, init); setError(null); await load(); }
    catch (e) { setError((e as Error).message); }
  }
  async function toggleContactFlag(ct: Contact, key: (typeof CONTACT_FLAGS)[number]["key"], value: boolean) {
    setContacts((cur) => cur.map((row) => (row.id === ct.id ? { ...row, [key]: value } : row)));
    try {
      await api(`/api/customers/${id}/contacts/${ct.id}`, { method: "PUT", body: JSON.stringify({ [key]: value }) });
      setError(null);
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }
  // Same optimistic-then-persist shape as save()/toggleContactFlag(), scoped to one address or
  // contact row rather than the customer itself — this is what gives existing address/contact
  // rows a way to correct a scalar field (A1/A3) without a modal: type into the cell, blur it.
  async function saveAddressField(a: Address, patch: Partial<Address>) {
    setAddresses((cur) => cur.map((row) => (row.id === a.id ? { ...row, ...patch } : row)));
    try {
      await api(`/api/customers/${id}/addresses/${a.id}`, { method: "PUT", body: JSON.stringify(patch) });
      setError(null);
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }
  async function saveContactField(ct: Contact, patch: Partial<Contact>) {
    setContacts((cur) => cur.map((row) => (row.id === ct.id ? { ...row, ...patch } : row)));
    try {
      await api(`/api/customers/${id}/contacts/${ct.id}`, { method: "PUT", body: JSON.stringify(patch) });
      setError(null);
    } catch (e) {
      await load().catch(() => {});
      setError((e as Error).message);
    }
  }

  if (!c) return <div className="p-6">{error ?? "Loading…"}</div>;

  return (
    <div className="p-6">
      <h1 className="mb-1 text-2xl font-semibold">
        <span className="font-mono">{c.code}</span> — {c.name}
      </h1>
      {c.parentCode && <p className="mb-3 text-sm text-slate-500">Division of {c.parentCode}</p>}
      {error && <p className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Commercial</h2>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.creditHold} onChange={(e) => save({ creditHold: e.target.checked })} />
            Credit hold
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.taxable} onChange={(e) => save({ taxable: e.target.checked })} />
            Taxable
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.cod} onChange={(e) => save({ cod: e.target.checked })} />
            COD
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.active} onChange={(e) => save({ active: e.target.checked })} />
            Active
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={c.surchargeOptOut}
                   onChange={(e) => save({ surchargeOptOut: e.target.checked })} />
            Surcharge opt-out
          </label>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="block text-sm">
            Terms
            <select value={c.termsId ?? ""} onChange={(e) => save({ termsId: e.target.value || null })}
                    className="ml-2 rounded border px-2 py-1">
              <option value="">—</option>
              {terms.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </label>
          <label className="block text-sm">
            Default PO
            <input value={c.defaultPo} onChange={(e) => setC({ ...c, defaultPo: e.target.value })}
                   onBlur={(e) => save({ defaultPo: e.target.value })}
                   className="ml-2 rounded border px-2 py-1" />
          </label>
          <label className="block text-sm">
            Credit limit
            <input value={c.creditLimit ?? ""} inputMode="decimal"
                   onChange={(e) => setC({ ...c, creditLimit: e.target.value })}
                   onBlur={(e) => save({ creditLimit: e.target.value === "" ? null : e.target.value })}
                   className="ml-2 w-32 rounded border px-2 py-1" />
          </label>
          <label className="block text-sm">
            Finance charge rate
            <input value={c.financeChargeRate ?? ""} inputMode="decimal"
                   onChange={(e) => setC({ ...c, financeChargeRate: e.target.value })}
                   onBlur={(e) => save({ financeChargeRate: e.target.value === "" ? null : e.target.value })}
                   className="ml-2 w-32 rounded border px-2 py-1" />
          </label>
        </div>
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Standing notes</h2>
        {([["orderNotes", "At order entry"], ["shippingNotes", "At shipping"], ["invoiceNotes", "At invoicing"]] as const)
          .map(([key, label]) => (
            <label key={key} className="mb-2 block text-sm">
              {label}
              <textarea value={c[key]} rows={2} onChange={(e) => setC({ ...c, [key]: e.target.value })}
                        onBlur={(e) => save({ [key]: e.target.value })}
                        className="mt-1 w-full rounded border p-2" />
            </label>
          ))}
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Addresses</h2>
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th className="py-1">Kind</th><th>Name</th><th>Street</th><th>City</th><th>State</th><th>Zip</th>
              <th /><th />
            </tr>
          </thead>
          <tbody>
            {addresses.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="py-1">{ADDRESS_KIND_LABELS[a.kind]}</td>
                <td>
                  <input value={a.name} className="w-28 rounded border px-1 py-0.5"
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, name: e.target.value } : row)))}
                         onBlur={(e) => saveAddressField(a, { name: e.target.value })} />
                </td>
                <td>
                  <input value={a.street} className="w-28 rounded border px-1 py-0.5"
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, street: e.target.value } : row)))}
                         onBlur={(e) => saveAddressField(a, { street: e.target.value })} />
                </td>
                <td>
                  <input value={a.city} className="w-20 rounded border px-1 py-0.5"
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, city: e.target.value } : row)))}
                         onBlur={(e) => saveAddressField(a, { city: e.target.value })} />
                </td>
                <td>
                  <input value={a.state} className="w-12 rounded border px-1 py-0.5"
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, state: e.target.value } : row)))}
                         onBlur={(e) => saveAddressField(a, { state: e.target.value })} />
                </td>
                <td>
                  <input value={a.zip} className="w-16 rounded border px-1 py-0.5"
                         onChange={(e) => setAddresses((cur) =>
                           cur.map((row) => (row.id === a.id ? { ...row, zip: e.target.value } : row)))}
                         onBlur={(e) => saveAddressField(a, { zip: e.target.value })} />
                </td>
                <td>{a.isDefault && <span className="rounded bg-slate-200 px-1 text-xs">default</span>}</td>
                <td className="text-right">
                  {!a.isDefault && (
                    <button className="mr-3 text-xs text-slate-600"
                            onClick={() => call(`/api/customers/${id}/addresses/${a.id}`,
                              { method: "PUT", body: JSON.stringify({ isDefault: true }) })}>
                      make default
                    </button>
                  )}
                  <button className="text-xs text-red-600"
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
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
                  onClick={() => { void call(`/api/customers/${id}/addresses`,
                    { method: "POST", body: JSON.stringify(addrDraft) }); setAddrDraft(emptyAddrDraft); }}>
            Add address
          </button>
        </div>
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Contacts</h2>
        <table className="mb-2 w-full text-sm">
          <thead>
            <tr className="text-left">
              <th>Name</th><th>Email</th><th>Phone</th>
              {CONTACT_FLAGS.map((f) => <th key={f.key} className="px-1">{f.label}</th>)}
              <th />
            </tr>
          </thead>
          <tbody>
            {contacts.map((ct) => (
              <tr key={ct.id} className="border-t">
                <td className="py-1">
                  <input value={ct.name} className="w-28 rounded border px-1 py-0.5"
                         onChange={(e) => setContacts((cur) =>
                           cur.map((row) => (row.id === ct.id ? { ...row, name: e.target.value } : row)))}
                         onBlur={(e) => saveContactField(ct, { name: e.target.value })} />
                </td>
                <td>
                  <input value={ct.email} className="w-36 rounded border px-1 py-0.5"
                         onChange={(e) => setContacts((cur) =>
                           cur.map((row) => (row.id === ct.id ? { ...row, email: e.target.value } : row)))}
                         onBlur={(e) => saveContactField(ct, { email: e.target.value })} />
                </td>
                <td>
                  <input value={ct.phone} className="w-24 rounded border px-1 py-0.5"
                         onChange={(e) => setContacts((cur) =>
                           cur.map((row) => (row.id === ct.id ? { ...row, phone: e.target.value } : row)))}
                         onBlur={(e) => saveContactField(ct, { phone: e.target.value })} />
                </td>
                {CONTACT_FLAGS.map((f) => (
                  <td key={f.key} className="px-1 text-center">
                    <input type="checkbox" checked={ct[f.key]}
                           onChange={(e) => toggleContactFlag(ct, f.key, e.target.checked)} />
                  </td>
                ))}
                <td className="text-right">
                  <button className="text-xs text-red-600"
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
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
                  onClick={() => { void call(`/api/customers/${id}/contacts`,
                    { method: "POST", body: JSON.stringify(contactDraft) }); setContactDraft(emptyContactDraft); }}>
            Add contact
          </button>
        </div>
      </section>

      <HistoryPanel entity="customer" entityId={c.id} />
    </div>
  );
}
