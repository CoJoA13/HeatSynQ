"use client";
import { use } from "react";
import { useProcessMaster, useParts } from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { ProcessMasterDetail } from "@/components/process-masters/process-master-detail";

export default function ProcessMasterDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const pm = useProcessMaster(id);
  const parts = useParts();
  if (pm.isLoading || parts.isLoading) return <SkeletonRows />;
  if (pm.isError) return <ErrorPanel message="Failed to load process master." onRetry={() => pm.refetch()} />;
  if (!pm.data) return <EmptyState title="Process master not found" />;
  const usedBy = (parts.data ?? []).filter((p) => p.processMasterId === id);
  return <ProcessMasterDetail processMaster={pm.data} usedByParts={usedBy} />;
}
