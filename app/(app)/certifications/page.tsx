"use client";
import { useCertifications, useCustomers, useWorkOrders, useSpecifications, useReleaseCertification } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CertificationsList } from "@/components/certifications/certifications-list";

export default function CertificationsPage() {
  const certs = useCertifications();
  const customers = useCustomers();
  const workOrders = useWorkOrders();
  const specs = useSpecifications();
  const release = useReleaseCertification();
  const canRelease = useCan("release_cert");

  if (certs.isLoading) return <SkeletonRows />;
  if (certs.isError) return <ErrorPanel message="Failed to load certifications." onRetry={() => certs.refetch()} />;
  const data = certs.data ?? [];

  return (
    <div>
      <PageHeader title="Certifications" subtitle="A cert must be Released before its order can ship." />
      {data.length === 0 ? (
        <EmptyState title="No certifications" />
      ) : (
        <CertificationsList
          certifications={data}
          customers={customers.data ?? []}
          workOrders={workOrders.data ?? []}
          specifications={specs.data ?? []}
          canRelease={canRelease}
          onRelease={(id) => {
            const c = data.find((x) => x.id === id);
            if (c) release.mutate({ id, version: c.version });
          }}
        />
      )}
    </div>
  );
}
