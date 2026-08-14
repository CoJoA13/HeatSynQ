// The reports catalog — a pure, client-safe module (no src/server/** imports; the nav.ts /
// permission-ui.ts precedent, so a "use client" file can import the type without dragging Prisma
// into the browser bundle). This is the reports analog of nav.ts's NAV array: one entry per report,
// each carrying the AREA that gates its visibility.
//
// GET /api/reports (the index API) filters this list by each entry's own `area` view grant, so a
// cross-area report (Task 6 homes the invoice register and A/R aging under /reports) hides for a
// user who has `reports.view` but not the source area's view — reaching the index needs
// `reports.view`, but each entry still gates on where it actually lives.
import { type Area } from "./permission-constants";

export type ReportEntry = {
  /** Stable key — the React list key and the report's identity; never reused. */
  key: string;
  label: string;
  href: string;
  /** The area whose `.view` grant reveals this entry (usually `reports`; a homed cross-area report
   *  uses its source area, e.g. `invoicing`/`receivables`). */
  area: Area;
  description: string;
};

// Tasks 1–6 register their report here. Each report task also builds src/app/reports/<name>/ and
// src/app/api/reports/<name>/ (the five-part shape in src/server/reports/README.md).
export const REPORTS: ReportEntry[] = [
  {
    key: "backlog", label: "Backlog", href: "/reports/backlog", area: "reports",
    description: "Open orders not yet fully shipped.",
  },
  {
    key: "shipped", label: "Shipped", href: "/reports/shipped", area: "reports",
    description: "Shipped quantity and weight by period.",
  },
];
