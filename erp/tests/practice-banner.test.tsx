import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The root layout resolves the practice flag through practiceMode(); mock it so we can drive both
// branches without a real erp_practice database. (The repo tests UI via E2E and has no DOM test env,
// so we render the presentational banner to static markup and inspect the layout's element tree —
// structure, not pixels. The banner-on-login E2E is T15's opt-in practice-pointed run.)
// layout.tsx does `import "./globals.css"` (same resolved file as @/app/globals.css); stub it so
// vitest's vite pipeline does not run the Tailwind-v4 PostCSS plugin on it (the repo has no DOM
// test env, and CSS is irrelevant to the element-tree assertions here).
vi.mock("@/app/globals.css", () => ({}));
vi.mock("@/server/practice-mode", () => ({ practiceMode: vi.fn() }));

import { practiceMode } from "@/server/practice-mode";
import RootLayout from "@/app/layout";
import { PracticeBanner } from "@/components/PracticeBanner";
import { Shell } from "@/components/Shell";

const mockPracticeMode = vi.mocked(practiceMode);

// RootLayout returns <html><body>{banner?}<Shell/></body></html>; pull out <body>'s children.
function bodyChildren(tree: React.ReactElement): React.ReactElement[] {
  const html = tree as unknown as { props: { children: { props: { children: unknown } } } };
  const kids = html.props.children.props.children;
  return (Array.isArray(kids) ? kids : [kids]) as React.ReactElement[];
}

describe("PracticeBanner + RootLayout (Phase 8B §5.1)", () => {
  beforeEach(() => mockPracticeMode.mockReset());

  it("PracticeBanner renders the PRACTICE mark", () => {
    expect(renderToStaticMarkup(<PracticeBanner />)).toContain("PRACTICE");
  });

  it("mounts the banner ABOVE Shell when in practice mode (so it survives /login + me-null)", async () => {
    mockPracticeMode.mockResolvedValue(true);
    const kids = bodyChildren(await RootLayout({ children: "x" }));
    const bannerIdx = kids.findIndex((c) => c && c.type === PracticeBanner);
    const shellIdx = kids.findIndex((c) => c && c.type === Shell);
    expect(bannerIdx).toBeGreaterThanOrEqual(0);
    expect(shellIdx).toBeGreaterThanOrEqual(0);
    expect(bannerIdx).toBeLessThan(shellIdx);
  });

  it("omits the banner in production mode", async () => {
    mockPracticeMode.mockResolvedValue(false);
    const kids = bodyChildren(await RootLayout({ children: "x" }));
    expect(kids.some((c) => c && c.type === PracticeBanner)).toBe(false);
  });
});
