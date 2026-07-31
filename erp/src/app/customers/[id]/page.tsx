"use client";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/fetcher";
import { HistoryPanel } from "@/components/HistoryPanel";
import { ADDRESS_KINDS, ADDRESS_KIND_LABELS, CONTACT_FLAGS, type AddressKind } from "@/lib/customer-constants";

type Customer = {
  id: string; code: string; name: string; parentId: string | null; parentCode: string | null;
  creditLimit: number | null; creditHold: boolean; cod: boolean; taxable: boolean;
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

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [c, setC] = useState<Customer | null>(null);
  const [addresses, setAddresses] = useState<Address[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addrDraft, setAddrDraft] = useState<{ kind: AddressKind; name: string }>({ kind: "SHIP_TO", name: "" });
  const [contactDraft, setContactDraft] = useState({ name: "", email: "" });
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [cust, addr, cont] = await Promise.all([
      api<Customer>(`/api/customers/${id}`),
      api<Address[]>(`/api/customers/${id}/addresses`),
      api<Contact[]>(`/api/customers/${id}/contacts`),
    ]);
    setC(cust); setAddresses(addr); setContacts(cont);
  }, [id]);
  useEffect(() => { load().catch((e) => setError(e.message)); }, [load]);

  async function save(body: object) {
    try {
      await api(`/api/customers/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setError(null); await load();
    } catch (e) { setError((e as Error).message); }
  }
  async function call(path: string, init: RequestInit) {
    try { await api(path, init); setError(null); await load(); }
    catch (e) { setError((e as Error).message); }
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
        </div>
        <label className="mt-3 block text-sm">
          Default PO
          <input defaultValue={c.defaultPo} onBlur={(e) => save({ defaultPo: e.target.value })}
                 className="ml-2 rounded border px-2 py-1" />
        </label>
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Standing notes</h2>
        {([["orderNotes", "At order entry"], ["shippingNotes", "At shipping"], ["invoiceNotes", "At invoicing"]] as const)
          .map(([key, label]) => (
            <label key={key} className="mb-2 block text-sm">
              {label}
              <textarea defaultValue={c[key]} rows={2} onBlur={(e) => save({ [key]: e.target.value })}
                        className="mt-1 w-full rounded border p-2" />
            </label>
          ))}
      </section>

      <section className="mb-6 rounded border bg-white p-4">
        <h2 className="mb-2 font-medium">Addresses</h2>
        <table className="mb-2 w-full text-sm">
          <tbody>
            {addresses.map((a) => (
              <tr key={a.id} className="border-t">
                <td className="py-1">{ADDRESS_KIND_LABELS[a.kind]}</td>
                <td>{a.name}</td>
                <td className="text-slate-500">{[a.street, a.city, a.state, a.zip].filter(Boolean).join(", ")}</td>
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
        <div className="flex gap-1">
          <select value={addrDraft.kind} className="rounded border px-2 py-1 text-sm"
                  onChange={(e) => setAddrDraft({ ...addrDraft, kind: e.target.value as AddressKind })}>
            {ADDRESS_KINDS.map((k) => <option key={k} value={k}>{ADDRESS_KIND_LABELS[k]}</option>)}
          </select>
          <input value={addrDraft.name} placeholder="Name" className="flex-1 rounded border px-2 py-1 text-sm"
                 onChange={(e) => setAddrDraft({ ...addrDraft, name: e.target.value })} />
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
                  onClick={() => { void call(`/api/customers/${id}/addresses`,
                    { method: "POST", body: JSON.stringify(addrDraft) }); setAddrDraft({ kind: "SHIP_TO", name: "" }); }}>
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
                <td className="py-1">{ct.name}</td><td>{ct.email}</td><td>{ct.phone}</td>
                {CONTACT_FLAGS.map((f) => (
                  <td key={f.key} className="px-1 text-center">
                    <input type="checkbox" checked={ct[f.key]}
                           onChange={(e) => call(`/api/customers/${id}/contacts/${ct.id}`,
                             { method: "PUT", body: JSON.stringify({ [f.key]: e.target.checked }) })} />
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
          <button className="rounded bg-slate-800 px-3 py-1 text-sm text-white"
                  onClick={() => { void call(`/api/customers/${id}/contacts`,
                    { method: "POST", body: JSON.stringify(contactDraft) }); setContactDraft({ name: "", email: "" }); }}>
            Add contact
          </button>
        </div>
      </section>

      <HistoryPanel entity="customer" entityId={c.id} />
    </div>
  );
}
