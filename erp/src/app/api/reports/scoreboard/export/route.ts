import { NextResponse } from "next/server";
import { handle, requireUser } from "@/server/http";
import { mustCan } from "@/server/permissions";
import { reportScoreboard, type ScoreboardFigures } from "@/server/reports/scoreboard";
import { toXlsx } from "@/server/excel";
import { parseScoreboardFilter } from "../query";

// GET /api/reports/scoreboard/export — the `reports/sales/export` template: `mustCan`, the SAME
// filter parse the list route uses (`parseScoreboardFilter`, so the on-screen figures and the Excel
// file can never disagree about the window), `reportScoreboard`, then `toXlsx`. The scoreboard is
// three figures, not a row list, so the sheet is one row per figure (metric · basis · value) with the
// window stamped into the file as a caption — the same numbers and window the screen renders.

/** The window, humanized for the caption cell — so the file itself records which period it covers. */
function windowCaption(window: ScoreboardFigures["window"]): string {
  const { from, to } = window;
  if (from && to) return `Comparison scoreboard — ${from} to ${to}`;
  if (from) return `Comparison scoreboard — from ${from}`;
  if (to) return `Comparison scoreboard — through ${to}`;
  return "Comparison scoreboard — all dates";
}

export const GET = handle(async (req) => {
  mustCan(requireUser(), "reports", "view");
  const figures = await reportScoreboard(parseScoreboardFilter(new URL(req.url)));

  const columns = [
    { key: "metric", header: "Metric" },
    { key: "basis", header: "Basis" },
    { key: "value", header: "Value" },
  ];
  const rows = [
    { metric: "Orders entered", basis: "by received date", value: figures.ordersEntered },
    { metric: "Shipped — pieces", basis: "by ship date", value: figures.shipped.qty },
    { metric: "Shipped — weight (lb)", basis: "by ship date", value: figures.shipped.weight },
    { metric: "Invoiced — invoices", basis: "by invoice date", value: figures.invoiced.invoices },
    { metric: "Invoiced — credits", basis: "by invoice date", value: figures.invoiced.credits },
    { metric: "Invoiced — net", basis: "by invoice date", value: figures.invoiced.net },
  ];

  const buf = await toXlsx("Scoreboard", columns, rows, windowCaption(figures.window));
  return new NextResponse(new Uint8Array(buf), {
    status: 200,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="Scoreboard.xlsx"',
    },
  });
});
