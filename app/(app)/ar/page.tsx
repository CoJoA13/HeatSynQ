"use client";
import { useState } from "react";
import { useInvoices, useCustomers } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { SkeletonRows, ErrorPanel } from "@/components/patterns";
import { ARView } from "@/components/ar/ar-view";
import { DEMO_NOW } from "@/lib/clock";

export default function ArPage() {
  const invoices = useInvoices();
  const customers = useCustomers();
  const canClose = useCan("close_period");
  const [closedNote, setClosedNote] = useState<string | null>(null);

  if (invoices.isLoading || customers.isLoading) return <SkeletonRows />;
  if (invoices.isError || customers.isError) return <ErrorPanel message="Failed to load A/R." onRetry={() => { invoices.refetch(); customers.refetch(); }} />;

  return (
    <ARView
      invoices={invoices.data ?? []} customers={customers.data ?? []} asOf={DEMO_NOW}
      canClose={canClose} closedNote={closedNote}
      onClosePeriod={() => setClosedNote("Period closed — invoices are locked from edits (advisory).")}
    />
  );
}
