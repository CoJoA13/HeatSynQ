"use client";
import { useRouter } from "next/navigation";
import { useCustomers, useWorkOrders, useInvoices } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CustomersList } from "@/components/customers/customers-list";

export default function CustomersPage() {
  const router = useRouter();
  const customers = useCustomers();
  const workOrders = useWorkOrders();
  const invoices = useInvoices();
  return (
    <div>
      <PageHeader title="Customers" subtitle="Accounts, terms, open work and A/R at a glance." />
      {customers.isLoading ? (
        <SkeletonRows />
      ) : customers.isError ? (
        <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />
      ) : !customers.data || customers.data.length === 0 ? (
        <EmptyState title="No customers" />
      ) : (
        <CustomersList
          customers={customers.data}
          workOrders={workOrders.data ?? []}
          invoices={invoices.data ?? []}
          onSelect={(id) => router.push(`/customers/${id}`)}
        />
      )}
    </div>
  );
}
