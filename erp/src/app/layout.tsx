import type { Metadata } from "next";
import "./globals.css";
import { Shell } from "@/components/Shell";
import { PracticeBanner } from "@/components/PracticeBanner";
import { SetupBanner } from "@/components/SetupBanner";
import { BackupBanner } from "@/components/BackupBanner";
import { practiceMode } from "@/server/practice-mode";

export const metadata: Metadata = { title: "Shop ERP" };

// The layout resolves practiceMode() — a DB query — so it must render at REQUEST time, never during
// static prerendering: `next build` (and the Docker build in particular, whose build stage points
// DATABASE_URL at an unreachable placeholder) would otherwise execute the identity query at build,
// breaking the build or baking a stale practice decision into static output (Codex P1).
export const dynamic = "force-dynamic";

// A server component, so it can resolve the practice flag server-side and mount the banner ABOVE
// <Shell> — surviving Shell's /login and me-null early returns (Phase 8B §5.1). The flag is never
// read in a client component (§8), and never via /api/auth/me (auth-gated, unreachable on /login).
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const isPractice = await practiceMode();
  return (
    <html lang="en">
      <body className="antialiased">
        {isPractice && <PracticeBanner />}
        <SetupBanner />
        <BackupBanner />
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
