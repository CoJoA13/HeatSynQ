"use client";
import { useAuth } from "@/lib/auth/provider";
import { useWorkOrders, useCustomers, useTrackInStep, useTrackOutStep, useCertifications } from "@/lib/query/hooks";
import { PageHeader, SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { TrackingBoard } from "@/components/tracking/tracking-board";
import { openOrders } from "@/lib/logic/dashboard";
import { DEMO_NOW } from "@/lib/clock";

export default function TrackingPage() {
  const { operator } = useAuth();
  const orders = useWorkOrders();
  const customers = useCustomers();
  const certs = useCertifications();
  const trackIn = useTrackInStep();
  const trackOut = useTrackOutStep();

  if (orders.isLoading || customers.isLoading || certs.isLoading || !operator) return <SkeletonRows />;
  if (orders.isError) return <ErrorPanel message="Failed to load orders." onRetry={() => orders.refetch()} />;
  if (customers.isError) return <ErrorPanel message="Failed to load customers." onRetry={() => customers.refetch()} />;
  if (certs.isError) return <ErrorPanel message="Failed to load certifications." onRetry={() => certs.refetch()} />;

  const open = openOrders(orders.data ?? []);
  const busy = trackIn.isPending || trackOut.isPending;
  const now = DEMO_NOW;

  return (
    <div>
      <PageHeader title="Tracking" subtitle="Live shop-floor status by area — scan orders through their traveler." />
      {open.length === 0 ? (
        <EmptyState title="No open orders" />
      ) : (
        <TrackingBoard
          orders={open} customers={customers.data ?? []} asOf={now} busy={busy}
          onTrackIn={(o, stepN) => trackIn.mutate({ order: o, stepN, operator })}
          onTrackOut={(o, stepN, inspectResult) => {
            const cert = (certs.data ?? []).find((c) => c.workOrderId === o.id) ?? null;
            trackOut.mutate({ order: o, stepN, operator, cert, inspectResult });
          }}
        />
      )}
    </div>
  );
}
