"use client";
import { useCustomers, useSpecifications } from "@/lib/query/hooks";
import { DetailHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { CertDefaults } from "@/components/setup/cert-defaults";

export default function SetupCertDefaultsPage() {
  const customers = useCustomers();
  const specs = useSpecifications();
  return (
    <div>
      <DetailHeader backHref="/setup" backLabel="Setup" title="Certifications & Forms"
        subtitle="Cert formats, defaults and form / message inserts." />
      {customers.isLoading || specs.isLoading ? (
        <SkeletonRows />
      ) : customers.isError || specs.isError ? (
        <ErrorPanel message="Failed to load cert defaults." onRetry={() => { customers.refetch(); specs.refetch(); }} />
      ) : !customers.data || customers.data.length === 0 ? (
        <EmptyState title="No customers" />
      ) : (
        <CertDefaults customers={customers.data} specifications={specs.data ?? []} />
      )}
    </div>
  );
}
