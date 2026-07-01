"use client";
import { useStandards } from "@/lib/query/hooks";
import { DEMO_NOW } from "@/lib/clock";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { StandardsList } from "@/components/standards/standards-list";

export default function StandardsPage() {
  const { data, isLoading, isError, refetch } = useStandards();
  return (
    <div>
      <PageHeader title="Standards" subtitle="Quality & process standards library." />
      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorPanel message="Failed to load standards." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No standards" description="No standards on file yet." />
      ) : (
        <StandardsList standards={data} asOf={DEMO_NOW} />
      )}
    </div>
  );
}
