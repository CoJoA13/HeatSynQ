"use client";
import { useRouter } from "next/navigation";
import { useQuotes, useCustomers } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { Button } from "@/lib/ui/button";
import { QuotesList } from "@/components/quotes/quotes-list";

export default function QuotesPage() {
  const router = useRouter();
  const quotes = useQuotes();
  const customers = useCustomers();
  return (
    <div>
      <PageHeader
        title="Quotes"
        subtitle="Estimates in flight — draft, sent, awaiting approval, won and lost."
        action={<Button onClick={() => router.push("/quotes/new")}>New quote</Button>}
      />
      {quotes.isLoading ? <SkeletonRows />
        : quotes.isError ? <ErrorPanel message="Failed to load quotes." onRetry={() => quotes.refetch()} />
        : !quotes.data || quotes.data.length === 0 ? <EmptyState title="No quotes" />
        : <QuotesList quotes={quotes.data} customers={customers.data ?? []} onSelect={(id) => router.push(`/quotes/${id}`)} />}
    </div>
  );
}
