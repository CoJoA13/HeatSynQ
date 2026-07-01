"use client";
import { useRouter } from "next/navigation";
import { useParts, useProcessMasters } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { PartsList } from "@/components/parts/parts-list";

export default function PartsPage() {
  const router = useRouter();
  const parts = useParts();
  const processMasters = useProcessMasters();
  return (
    <div>
      <PageHeader title="Part Maintenance" subtitle="Customer part records, specs and assigned recipes." />
      {parts.isLoading ? (
        <SkeletonRows />
      ) : parts.isError ? (
        <ErrorPanel message="Failed to load parts." onRetry={() => parts.refetch()} />
      ) : !parts.data || parts.data.length === 0 ? (
        <EmptyState title="No parts" />
      ) : (
        <PartsList parts={parts.data} processMasters={processMasters.data ?? []} onSelect={(id) => router.push(`/parts/${id}`)} />
      )}
    </div>
  );
}
