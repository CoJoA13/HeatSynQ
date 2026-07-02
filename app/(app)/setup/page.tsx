"use client";
import { PageHeader } from "@/components/patterns";
import { SetupGrid } from "@/components/setup/setup-grid";

export default function SetupPage() {
  return (
    <div>
      <PageHeader title="Setup" subtitle="Configuration once buried under Maintain ▸ … ▸ …, now flat" />
      <SetupGrid />
    </div>
  );
}
