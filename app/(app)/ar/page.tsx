"use client";
import { useState } from "react";
import { useInvoices, useCustomers } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ARView } from "@/components/ar/ar-view";

export default function ArPage() {
  const invoices = useInvoices();
  const customers = useCustomers();
  const canClose = useCan("close_period");
  const [closedNote, setClosedNote] = useState<string | null>(null);

  if (invoices.isLoading || customers.isLoading) return <SkeletonRows />;
  if (invoices.isError) return <ErrorPanel message="Failed to load A/R." onRetry={() => invoices.refetch()} />;

  return (
    <ARView
      invoices={invoices.data ?? []} customers={customers.data ?? []} asOf={new Date().toISOString()}
      canClose={canClose} closedNote={closedNote}
      onClosePeriod={() => setClosedNote("Period closed — invoices are locked from edits (advisory).")}
    />
  );
}
