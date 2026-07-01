"use client";
import { useSpecifications } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { SpecificationsList } from "@/components/specifications/specifications-list";

export default function SpecificationsPage() {
  const { data, isLoading, isError, refetch } = useSpecifications();
  return (
    <div>
      <PageHeader title="Specifications" subtitle="Quality & industry specs referenced by parts and certs." />
      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorPanel message="Failed to load specifications." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No specifications" description="No specifications on file yet." />
      ) : (
        <SpecificationsList specifications={data} />
      )}
    </div>
  );
}
