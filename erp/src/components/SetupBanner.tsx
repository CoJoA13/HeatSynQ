"use client";
// The first-run surfacing (Phase 8B §5.5 "reachable from the shell until complete", owner decision
// 5) PLUS the §5.7 dismissible admin-password reminder. Mounted by the root layout above Shell, so
// it survives Shell's early returns; it renders NOTHING for a non-admin or signed-out caller (the
// admin-gated readiness fetch 403s → caught → null) and NOTHING once setup is complete/dismissed.
// The nav is not a static entry (that would stay after completion, contradicting "until complete");
// this dynamic strip is the surfacing. The password reminder's dismiss is CLIENT-side (localStorage)
// — §7 keeps SetupState to two fields, and the live "still admin" signal self-clears the reminder
// once the password changes.
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { api } from "@/lib/fetcher";

type SetupStep = { key: string; complete: boolean };
type Readiness = { steps: SetupStep[]; dismissed: boolean; complete: boolean };

const PW_DISMISS_KEY = "hsq_pw_reminder_dismissed";

export function SetupBanner() {
  const [data, setData] = useState<Readiness | null>(null);
  const [pwDismissed, setPwDismissed] = useState(true); // assume dismissed until localStorage is read

  const pathname = usePathname();
  useEffect(() => {
    setPwDismissed(localStorage.getItem(PW_DISMISS_KEY) === "1");
    // Re-run on navigation: this layout-mounted component is NOT remounted by a client-side login
    // (/login → /), so an empty-dep fetch would never appear after the normal first login. Keying on
    // pathname also refreshes the banner as setup state changes. On /login (signed out), skip (401).
    if (pathname === "/login") {
      setData(null);
      return;
    }
    api<Readiness>("/api/setup/readiness").then(setData).catch(() => setData(null));
  }, [pathname]);

  if (!data) return null;
  const passwordIncomplete = data.steps.some((s) => s.key === "password" && !s.complete);
  const showSetup = !data.complete && !data.dismissed;
  const showPassword = passwordIncomplete && !pwDismissed;
  if (!showSetup && !showPassword) return null;

  return (
    <>
      {showSetup && (
        <div className="bg-blue-600 px-4 py-1.5 text-center text-sm text-white">
          Setup isn’t finished.{" "}
          <Link href="/setup" className="font-semibold underline">Finish setup</Link>
        </div>
      )}
      {showPassword && (
        <div className="flex items-center justify-center gap-3 bg-amber-100 px-4 py-1.5 text-sm text-amber-900">
          <span>
            The admin account still uses the default password.{" "}
            <Link href="/admin/users" className="font-semibold underline">Change it</Link>
          </span>
          <button
            type="button"
            onClick={() => {
              localStorage.setItem(PW_DISMISS_KEY, "1");
              setPwDismissed(true);
            }}
            className="text-amber-700 underline"
          >
            Not now
          </button>
        </div>
      )}
    </>
  );
}
