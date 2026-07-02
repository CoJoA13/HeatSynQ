"use client";
import { use } from "react";
import { useAuth, useCan } from "@/lib/auth/provider";
import {
  useWorkOrder, useCustomer, useProcessMaster, useCertifications,
  useReleaseCertification, useTransitionOrder, useShipOrder, useTrackInStep, useTrackOutStep,
} from "@/lib/query/hooks";
import { SkeletonRows, ErrorPanel, EmptyState } from "@/components/patterns";
import { OrderDetail } from "@/components/orders/order-detail";
import { rollUpOrderStatus } from "@/lib/logic/tracking";
import { DEMO_NOW } from "@/lib/clock";

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
  const trackIn = useTrackInStep();
  const trackOut = useTrackOutStep();

  if (order.isLoading || !operator) return <SkeletonRows />;
  if (order.isError) return <ErrorPanel message="Failed to load order." onRetry={() => order.refetch()} />;
  if (!order.data) return <EmptyState title="Order not found" />;
  const o = order.data;

  if (o.certifyRequired && certs.isLoading) return <SkeletonRows />;
  if (o.certifyRequired && certs.isError)
    return <ErrorPanel message="Failed to load certification." onRetry={() => { order.refetch(); certs.refetch(); }} />;

  if (customer.isLoading) return <SkeletonRows />;
  if (customer.isError)
    return <ErrorPanel message="Failed to load customer." onRetry={() => { order.refetch(); customer.refetch(); }} />;

  const cert = (certs.data ?? []).find((c) => c.workOrderId === o.id) ?? null;
  const now = () => DEMO_NOW;
  const actor = operator.name;
  const busy = release.isPending || transition.isPending || ship.isPending || trackIn.isPending || trackOut.isPending;

  return (
    <OrderDetail
      order={o} customer={customer.data ?? null} processMaster={pm.data ?? null} cert={cert}
      canRelease={canRelease} busy={busy}
      onRelease={() => cert && release.mutate({ id: cert.id, version: cert.version })}
      onShip={() => ship.mutate({ order: o, cert, actor, at: now(), customer: customer.data ?? null })}
      onTrackIn={(stepN) => trackIn.mutate({ order: o, stepN, operator })}
      onTrackOut={(stepN, inspectResult) => trackOut.mutate({ order: o, stepN, operator, cert, inspectResult })}
      onHold={() => transition.mutate({ order: o, to: "on_hold", actor, at: now() })}
      onResume={() => transition.mutate({ order: o, to: rollUpOrderStatus(o.steps, "received"), actor, at: now() })}
    />
  );
}
