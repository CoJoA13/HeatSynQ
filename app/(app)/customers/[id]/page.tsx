"use client";
import { use } from "react";
import {
  useCustomer, useContactsByCustomer, usePartsByCustomer,
  useWorkOrders, useInvoices, usePriceKeys, usePricingRulesByPriceKey,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CustomerDetail } from "@/components/customers/customer-detail";

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const customer = useCustomer(id);
  const contacts = useContactsByCustomer(id);
  const parts = usePartsByCustomer(id);
  const orders = useWorkOrders();
  const invoices = useInvoices();
  const priceKeys = usePriceKeys();
  const priceKeyId = customer.data?.priceKeyId ?? "";
  const rules = usePricingRulesByPriceKey(priceKeyId);

  if (customer.isLoading) return <SkeletonRows />;
  if (customer.isError) return <ErrorPanel message="Failed to load customer." onRetry={() => customer.refetch()} />;
  if (!customer.data) return <EmptyState title="Customer not found" />;
  const c = customer.data;

  const custOrders = (orders.data ?? []).filter((w) => w.customerId === id);
  const custInvoices = (invoices.data ?? []).filter((i) => i.customerId === id);
  const priceKey = (priceKeys.data ?? []).find((k) => k.id === c.priceKeyId) ?? null;

  return (
    <CustomerDetail
      customer={c}
      contacts={contacts.data ?? []}
      parts={parts.data ?? []}
      orders={custOrders}
      invoices={custInvoices}
      priceKey={priceKey}
      pricingRules={rules.data ?? []}
    />
  );
}
