import { DetailHeader, StatusPill, MonoId, ListCard, EmptyState } from "@/components/patterns";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/lib/ui/tabs";
import { customerStatusMeta, orderStatusMeta, basisLabel } from "@/lib/domain/enums";
import { customerBalanceCents } from "@/lib/logic/ar";
import { formatMoney, formatDate } from "@/lib/utils";
import type {
  Customer, Contact, Part, WorkOrder, Invoice, PriceKey, PricingRule,
} from "@/lib/domain";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-text-muted text-[11px]">{label}</dt>
      <dd className="text-[13px]">{value}</dd>
    </div>
  );
}

export function CustomerDetail({
  customer: c,
  contacts,
  parts,
  orders,
  invoices,
  priceKey,
  pricingRules,
}: {
  customer: Customer;
  contacts: Contact[];
  parts: Part[];
  orders: WorkOrder[];
  invoices: Invoice[];
  priceKey: PriceKey | null;
  pricingRules: PricingRule[];
}) {
  const meta = customerStatusMeta[c.status];
  const balance = customerBalanceCents(invoices, c.id);
  const openOrders = orders.filter((o) => o.status !== "shipped").length;

  return (
    <div>
      <DetailHeader
        backHref="/customers"
        backLabel="Customers"
        title={<span className="flex items-center gap-2"><span>{c.name}</span><MonoId className="text-text-muted">#{c.customerNumber}</MonoId></span>}
        subtitle={c.city || undefined}
        statusPill={<StatusPill tone={meta.tone}>{meta.label}</StatusPill>}
      />
      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="parts">Parts</TabsTrigger>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4">
          <dl className="grid grid-cols-3 gap-4 rounded-card border border-border bg-surface p-4">
            <Field label="Terms" value={c.terms} />
            <Field label="Tax exempt" value={c.taxExempt ? "Yes" : "No"} />
            <Field label="Phone" value={c.phone || "—"} />
            <Field label="Billing address" value={c.billingAddress || "—"} />
            <Field label="YTD sales" value={<span className="font-mono">{formatMoney(c.ytdSalesCents)}</span>} />
            <Field label="A/R balance" value={<span className="font-mono">{formatMoney(balance)}</span>} />
            <Field label="Open orders" value={<span className="font-mono">{openOrders}</span>} />
            <Field label="Default cert" value={c.defaultCertSpecId ? `${c.defaultCertCopies} copies` : "—"} />
            <Field label="Price key" value={priceKey ? <MonoId>{priceKey.code}</MonoId> : "—"} />
          </dl>
        </TabsContent>

        <TabsContent value="contacts" className="pt-4">
          {contacts.length === 0 ? (
            <EmptyState title="No contacts" />
          ) : (
            <ListCard
              headers={["NAME", "ROLE", "EMAIL", "PHONE"]}
              rows={contacts.map((ct) => [ct.name, ct.role, ct.email, ct.phone])}
            />
          )}
        </TabsContent>

        <TabsContent value="parts" className="pt-4">
          {parts.length === 0 ? (
            <EmptyState title="No parts" />
          ) : (
            <ListCard
              headers={["PART", "DESCRIPTION", "MATERIAL", "HARDNESS"]}
              rows={parts.map((p) => [<MonoId key="pn">{p.partNumber}</MonoId>, p.description, p.material, p.hardness])}
            />
          )}
        </TabsContent>

        <TabsContent value="orders" className="pt-4">
          {orders.length === 0 ? (
            <EmptyState title="No orders" />
          ) : (
            <ListCard
              headers={["WORK ORDER", "PROCESS", "DUE", "VALUE", "STATUS"]}
              rows={orders.map((o) => {
                const om = orderStatusMeta[o.status];
                return [
                  <MonoId key="wo">{o.number}</MonoId>,
                  o.processSummary,
                  formatDate(o.due),
                  <span key="v" className="font-mono">{formatMoney(o.orderValueCents)}</span>,
                  <StatusPill key="s" tone={om.tone}>{om.label}</StatusPill>,
                ];
              })}
            />
          )}
        </TabsContent>

        <TabsContent value="documents" className="pt-4">
          <EmptyState title="No documents" description="Document management arrives in a later phase." />
        </TabsContent>

        <TabsContent value="pricing" className="pt-4">
          {!priceKey ? (
            <EmptyState title="No price key" description="This customer has no pricing profile assigned." />
          ) : (
            <div className="space-y-3">
              <div className="text-text-muted text-xs">
                Step pricing overrides · price key <MonoId>{priceKey.code}</MonoId> — {priceKey.description}
              </div>
              <ListCard
                headers={["PROCESS", "BASIS", "RATE", "MIN CHARGE"]}
                rows={pricingRules.map((r) => [
                  r.process,
                  basisLabel[r.basis],
                  <span key="rate" className="font-mono">{formatMoney(r.rateCents)}</span>,
                  <span key="min" className="font-mono">{r.minChargeCents != null ? formatMoney(r.minChargeCents) : "—"}</span>,
                ])}
              />
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
