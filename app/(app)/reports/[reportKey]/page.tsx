"use client";
import { use } from "react";
import Link from "next/link";
import { useCustomers, useEquipment, useInvoices, useQuotes, useWorkOrders } from "@/lib/query/hooks";
import { EmptyState, ErrorPanel, SkeletonRows } from "@/components/patterns";
import { ReportView } from "@/components/reports/report-view";
import { reportByKey } from "@/lib/logic/reports";
import { DEMO_NOW } from "@/lib/clock";

export default function ReportPage({ params }: { params: Promise<{ reportKey: string }> }) {
  const { reportKey } = use(params);
  const quotes = useQuotes();
  const orders = useWorkOrders();
  const invoices = useInvoices();
  const customers = useCustomers();
  const equipment = useEquipment();

  const def = reportByKey(reportKey);
  if (!def) {
    return (
      <EmptyState
        title="No such report"
        action={<Link className="text-primary text-xs" href="/reports">Back to Reports</Link>}
      />
    );
  }

  if (quotes.isLoading || orders.isLoading || invoices.isLoading || customers.isLoading || equipment.isLoading)
    return <SkeletonRows />;
  if (quotes.isError || orders.isError || invoices.isError || customers.isError || equipment.isError)
    return (
      <ErrorPanel
        message="Failed to load report data."
        onRetry={() => {
          quotes.refetch();
          orders.refetch();
          invoices.refetch();
          customers.refetch();
          equipment.refetch();
        }}
      />
    );

  const result = def.build(
    {
      quotes: quotes.data ?? [],
      orders: orders.data ?? [],
      invoices: invoices.data ?? [],
      customers: customers.data ?? [],
      equipment: equipment.data ?? [],
    },
    DEMO_NOW,
  );

  return <ReportView def={def} result={result} asOf={DEMO_NOW} />;
}
