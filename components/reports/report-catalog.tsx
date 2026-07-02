import Link from "next/link";
import { REPORT_GROUPS, REPORTS } from "@/lib/logic/reports";

export function ReportCatalog() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {REPORT_GROUPS.map((g) => (
        <div key={g.key} data-testid={`report-group-${g.key}`} className="rounded-card border-border bg-surface border p-4">
          <div className="mb-2 flex items-center gap-2.5">
            <span className="bg-primary-tint text-primary grid size-8 place-items-center rounded-md text-sm">{g.icon}</span>
            <span className="font-semibold">{g.title}</span>
          </div>
          <div>
            {g.reports.map((key) => (
              <Link
                key={key}
                data-testid={`report-link-${key}`}
                href={`/reports/${key}`}
                className="border-border-faint hover:bg-canvas flex items-center justify-between border-t px-1 py-2.5 text-[13px]"
              >
                {REPORTS[key].title}
                <span className="text-text-faint">→</span>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
