"use client";
import { Button } from "@/lib/ui/button";
import { Input } from "@/lib/ui/input";
import { StatusPill, KpiTile, EmptyState, ErrorPanel, SkeletonRows, PageHeader, ListCard, FormField, MonoId } from "@/components/patterns";
import { quoteStatusMeta, orderStatusMeta, invoiceStatusMeta } from "@/lib/domain/enums";

export default function PatternsPage() {
  const allStatuses = [
    ...Object.values(quoteStatusMeta), ...Object.values(orderStatusMeta), ...Object.values(invoiceStatusMeta),
  ];
  return (
    <div className="space-y-8">
      <PageHeader title="Design patterns" subtitle="Reference states for the build — buttons, status, forms, empty, loading, error." />

      <section className="space-y-2">
        <h2 className="font-semibold">Buttons</h2>
        <div className="flex flex-wrap gap-2 rounded-card border border-border bg-surface p-4">
          <Button>Primary</Button>
          <Button variant="outline">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Delete</Button>
          <Button disabled>Disabled</Button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Status vocabulary</h2>
        <div className="flex flex-wrap gap-2 rounded-card border border-border bg-surface p-4">
          {allStatuses.map((s) => <StatusPill key={s.label} tone={s.tone}>{s.label}</StatusPill>)}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">KPI tiles</h2>
        <div className="grid grid-cols-3 gap-3">
          <KpiTile label="Open Orders" value="86" sub="4 today" />
          <KpiTile label="On-Time %" value="94.2" delta="▲ 1.1 pts" />
          <KpiTile label="Late Orders" value="5" sub="2 ship today" tone="danger" />
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Identifiers</h2>
        <div className="rounded-card border border-border bg-surface p-4"><MonoId>WO-48211</MonoId></div>
      </section>

      <section className="grid grid-cols-2 gap-4">
        <div className="space-y-2"><h2 className="font-semibold">Form field</h2>
          <div className="rounded-card border border-border bg-surface p-4">
            <FormField label="Part number" htmlFor="pn" error="Required"><Input id="pn" /></FormField>
          </div>
        </div>
        <div className="space-y-2"><h2 className="font-semibold">List</h2>
          <ListCard headers={["WORK ORDER","STATUS"]} rows={[[<MonoId key="a">WO-48211</MonoId>, <StatusPill key="b" tone="info">In Process</StatusPill>]]} />
        </div>
      </section>

      <section className="grid grid-cols-3 gap-4">
        <div className="space-y-2"><h2 className="font-semibold">Empty</h2><EmptyState title="No quotes yet" description="Create your first quote." action={<Button>New quote</Button>} /></div>
        <div className="space-y-2"><h2 className="font-semibold">Loading</h2><SkeletonRows count={4} /></div>
        <div className="space-y-2"><h2 className="font-semibold">Error</h2><ErrorPanel message="Failed to load." onRetry={() => {}} /></div>
      </section>
    </div>
  );
}
