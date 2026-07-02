"use client";
import { PageHeader } from "@/components/patterns";
import { ReportCatalog } from "@/components/reports/report-catalog";

export default function ReportsPage() {
  return (
    <div>
      <PageHeader title="Reports" subtitle="Every report, grouped — no menu hunting." />
      <ReportCatalog />
    </div>
  );
}
