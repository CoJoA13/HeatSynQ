import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReportView } from "./report-view";
import type { ReportDef, ReportResult } from "@/lib/logic/reports";

const def: ReportDef = {
  key: "past-due-detail",
  title: "Past-Due Detail",
  framing: "Open invoices only.",
  empty: "Nothing past due.",
  build: () => ({ kpis: [], table: { columns: [], rows: [] } }),
};
const emptyResult: ReportResult = {
  kpis: [{ label: "Past due", value: "$0" }, { label: "Invoices", value: "0" }],
  table: { columns: ["INVOICE"], rows: [] },
};

describe("ReportView", () => {
  it("renders title, framing, deterministic as-of line, KPI strip, and honest empty state", () => {
    render(<ReportView def={def} result={emptyResult} asOf="2026-06-30T12:00:00.000Z" />);
    expect(screen.getByRole("heading", { name: "Past-Due Detail" })).toBeInTheDocument();
    expect(screen.getByText("Open invoices only.")).toBeInTheDocument();
    expect(screen.getByText("As of Jun 30, 2026")).toBeInTheDocument();
    expect(screen.getByTestId("report-kpis")).toHaveTextContent("Past due");
    expect(screen.getByText("Nothing past due.")).toBeInTheDocument();
    expect(screen.queryByTestId("report-table")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reports/ })).toHaveAttribute("href", "/reports");
  });
});
