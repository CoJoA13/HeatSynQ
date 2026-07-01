"use client";
import { use } from "react";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useWorkOrder, useCustomer, useProcessMaster, useCertifications,
  useReleaseCertification, useTransitionOrder, useShipOrder,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OrderDetail } from "@/components/orders/order-detail";
import type { OrderStatus } from "@/lib/domain";

export default function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { operator } = useAuth();
  const canRelease = useCan("release_cert");
  const order = useWorkOrder(id);
  const customer = useCustomer(order.data?.customerId ?? "");
  const pm = useProcessMaster(order.data?.processMasterId ?? "");
  const certs = useCertifications();
  const release = useReleaseCertification();
  const transition = useTransitionOrder();
  const ship = useShipOrder();

  if (order.isLoading || !operator) return <SkeletonRows />;
  if (order.isError) return <ErrorPanel message="Failed to load order." onRetry={() => order.refetch()} />;
  if (!order.data) return <EmptyState title="Order not found" />;
  const o = order.data;

  // Dependent-query guards (need o.certifyRequired / o.steps / o.processMasterId).
  // Cert (EOV): a released cert must not look absent while certs load/fail, or Release/Ship mis-gate.
  if (o.certifyRequired && certs.isLoading) return <SkeletonRows />;
  if (o.certifyRequired && certs.isError)
    return <ErrorPanel message="Failed to load certification." onRetry={() => { order.refetch(); certs.refetch(); }} />;
  // Process master (EOo): traveler depends on pm.data when steps are unresolved; don't render actions on stale data.
  if (o.steps.length === 0 && o.processMasterId && pm.isLoading) return <SkeletonRows />;
  if (o.steps.length === 0 && o.processMasterId && pm.isError)
    return <ErrorPanel message="Failed to load process master." onRetry={() => { order.refetch(); pm.refetch(); }} />;

  const cert = (certs.data ?? []).find((c) => c.workOrderId === o.id) ?? null;
  const now = () => new Date().toISOString();
  const actor = operator?.name ?? "System";
  const busy = release.isPending || transition.isPending || ship.isPending;

  return (
    <OrderDetail
      order={o} customer={customer.data ?? null} processMaster={pm.data ?? null} cert={cert}
      canRelease={canRelease} busy={busy}
      onRelease={() => cert && release.mutate({ id: cert.id, version: cert.version })}
      onTransition={(to: OrderStatus) => transition.mutate({ order: o, to, actor, at: now() })}
      onShip={() => ship.mutate({ order: o, cert, actor, at: now() })}
    />
  );
}
