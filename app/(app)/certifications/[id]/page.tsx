"use client";
import { use } from "react";
import { useCan } from "@/lib/auth/provider";
import { useCertification, useWorkOrder, useCustomer, useSpecifications, useReleaseCertification } from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CertificationDetail } from "@/components/certifications/certification-detail";

export default function CertificationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const canRelease = useCan("release_cert");
  const cert = useCertification(id);
  const workOrder = useWorkOrder(cert.data?.workOrderId ?? "");
  const customer = useCustomer(cert.data?.customerId ?? "");
  const specs = useSpecifications();
  const release = useReleaseCertification();

  if (cert.isLoading) return <SkeletonRows />;
  if (cert.isError) return <ErrorPanel message="Failed to load certification." onRetry={() => cert.refetch()} />;
  if (!cert.data) return <EmptyState title="Certification not found" />;
  const c = cert.data;

  if (workOrder.isLoading || customer.isLoading || specs.isLoading) return <SkeletonRows />;
  if (workOrder.isError || customer.isError || specs.isError)
    return <ErrorPanel message="Failed to load certification context." onRetry={() => { workOrder.refetch(); customer.refetch(); specs.refetch(); }} />;

  const specification = c.specificationId ? (specs.data ?? []).find((s) => s.id === c.specificationId) ?? null : null;

  return (
    <CertificationDetail
      cert={c} workOrder={workOrder.data ?? null} customer={customer.data ?? null} specification={specification}
      canRelease={canRelease} busy={release.isPending}
      onRelease={() => release.mutate({ id: c.id, version: c.version })}
    />
  );
}
