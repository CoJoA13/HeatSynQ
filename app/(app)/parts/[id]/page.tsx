"use client";
import { use, useState } from "react";
import { usePart, useSpecifications, useProcessMasters, usePriceKeys, useUpdatePart } from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { PartEditor, type PartFormValues } from "@/components/parts/part-editor";

export default function PartEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const part = usePart(id);
  const specs = useSpecifications();
  const processMasters = useProcessMasters();
  const priceKeys = usePriceKeys();
  const update = useUpdatePart();
  const [saved, setSaved] = useState(false);

  if (part.isLoading) return <SkeletonRows />;
  if (part.isError) return <ErrorPanel message="Failed to load part." onRetry={() => part.refetch()} />;
  if (!part.data) return <EmptyState title="Part not found" />;
  const p = part.data;

  return (
    <PartEditor
      part={p}
      specifications={specs.data ?? []}
      processMasters={processMasters.data ?? []}
      priceKeys={priceKeys.data ?? []}
      saving={update.isPending}
      saved={saved}
      onSave={(values: PartFormValues) => {
        setSaved(false);
        update.mutate({ id: p.id, patch: values, version: p.version }, { onSuccess: () => setSaved(true) });
      }}
    />
  );
}
