"use client";
import { useOperators, useSetOperatorQuoteLimit } from "@/lib/query/hooks";
import { useCan } from "@/lib/auth/provider";
import { DetailHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OperatorsSecurity } from "@/components/setup/operators-security";

export default function SetupOperatorsPage() {
  const canEdit = useCan("edit_setup");
  const operators = useOperators();
  const setLimit = useSetOperatorQuoteLimit();
  return (
    <div>
      <DetailHeader backHref="/setup" backLabel="Setup" title="Operators & Security"
        subtitle="Operator IDs, roles, module permissions and signatures." />
      {operators.isLoading ? (
        <SkeletonRows />
      ) : operators.isError ? (
        <ErrorPanel message="Failed to load operators." onRetry={() => operators.refetch()} />
      ) : !operators.data || operators.data.length === 0 ? (
        <EmptyState title="No operators" />
      ) : (
        <OperatorsSecurity operators={operators.data} canEdit={canEdit} busy={setLimit.isPending}
          onSetLimit={(operator, quoteAuthLimitCents) => setLimit.mutate({ operator, quoteAuthLimitCents })} />
      )}
    </div>
  );
}
