"use client";
import { useAuth } from "@/lib/auth/provider";
import { useWorkOrders, useQuotes, useInvoices, useCertifications } from "@/lib/query/hooks";
import { dashboardKpis } from "@/lib/logic/dashboard";
import { SkeletonRows, ErrorPanel } from "@/components/patterns";
import { TodayDashboard } from "@/components/today/today-dashboard";

export default function TodayPage() {
  const { operator, viewAs, setViewAs } = useAuth();
  const orders = useWorkOrders();
  const quotes = useQuotes();
  const invoices = useInvoices();
  const certs = useCertifications();

  if (orders.isLoading || quotes.isLoading || invoices.isLoading || certs.isLoading) return <SkeletonRows />;

  if (orders.isError || quotes.isError || invoices.isError || certs.isError) {
    return (
      <ErrorPanel
        message="Failed to load dashboard data."
        onRetry={() => {
          orders.refetch();
          quotes.refetch();
          invoices.refetch();
          certs.refetch();
        }}
      />
    );
  }

  const asOf = new Date().toISOString();
  const tiles = dashboardKpis(
    viewAs,
    {
      orders: orders.data ?? [],
      quotes: quotes.data ?? [],
      invoices: invoices.data ?? [],
      certifications: certs.data ?? [],
    },
    asOf,
  );
  const greeting = `Good day, ${operator?.name?.split(" ")[0] ?? "there"}`;

  return <TodayDashboard greeting={greeting} viewAs={viewAs} onViewAs={setViewAs} tiles={tiles} />;
}
