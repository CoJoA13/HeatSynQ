"use client";
import { useRouter } from "next/navigation";
import { useProcessMasters } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { ProcessMastersList } from "@/components/process-masters/process-masters-list";

export default function ProcessMastersPage() {
  const router = useRouter();
  const { data, isLoading, isError, refetch } = useProcessMasters();
  return (
    <div>
      <PageHeader title="Process Master" subtitle="Rev-controlled recipes that drive the traveler." />
      {isLoading ? (
        <SkeletonRows />
      ) : isError ? (
        <ErrorPanel message="Failed to load process masters." onRetry={() => refetch()} />
      ) : !data || data.length === 0 ? (
        <EmptyState title="No process masters" />
      ) : (
        <ProcessMastersList processMasters={data} onSelect={(id) => router.push(`/process-masters/${id}`)} />
      )}
    </div>
  );
}
