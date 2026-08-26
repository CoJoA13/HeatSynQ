import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #212 / #225 — two commitments about src/app/globals.css, pinned as text because no other gate
 * can see them (tsc/eslint don't read CSS, and the failure modes are visual):
 *
 *   - #212: the UI is light-only BY DECISION. The create-next-app scaffold shipped a
 *     `prefers-color-scheme: dark` block that flipped `--foreground` to #ededed on `body` while
 *     every component stayed hardcoded light (`bg-white` cards, zero `dark:` variants repo-wide),
 *     so any OS/browser preferring dark rendered most text at ~1.2:1 on white. A future
 *     scaffold upgrade or well-meaning "add dark mode" half-step would reintroduce exactly that;
 *     dark-mode support, if ever wanted, must arrive as themed components, not a root color flip.
 *
 *   - #225: font utilities must resolve to REAL font stacks. The scaffold's `@theme` block mapped
 *     `--font-sans`/`--font-mono` to `var(--font-geist-sans)`/`var(--font-geist-mono)` after the
 *     Geist `next/font` loading had been removed from layout.tsx — an undefined var() makes the
 *     declaration invalid at computed-value time, so all 40+ `font-mono` sites (part numbers,
 *     serials, order/shipper/BOL numbers) silently fell back to body Arial. With no override,
 *     Tailwind v4's own `--font-sans`/`--font-mono` defaults apply to the utilities.
 */
const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

describe("globals.css commitments (#212, #225)", () => {
  it("carries no prefers-color-scheme override — the UI is light-only by decision (#212)", () => {
    expect(css).not.toMatch(/prefers-color-scheme/);
  });

  it("maps no font token to the removed Geist variables (#225)", () => {
    expect(css).not.toMatch(/--font-geist/);
  });
});
