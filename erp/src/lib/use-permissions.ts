"use client";
// Client-safe: no src/server/** imports, only `react` and the sibling fetcher (the
// permission-ui.ts precedent; see CLAUDE.md "Constraints that will bite you").
//
// Lives here, in src/lib/ alongside permission-ui.ts, rather than beside whichever component
// happened to need it first: the /api/auth/me effect below was independently copied verbatim
// into three components (customers/page.tsx, customers/[id]/page.tsx, ReferenceTable.tsx)
// before any parts screen existed, and 2C-2 adds four more screens that would each have been a
// fourth copy — the "reimplemented rather than shared" pattern handoff §6 names as this repo's
// recurring defect shape. gate()/gateDo() already live in src/lib/permission-ui.ts and consume
// exactly what this hook returns, so keeping both in src/lib/ keeps every permission-UI helper
// in one place instead of splitting the concern between src/lib and src/components.
import { useEffect, useState } from "react";
import { api } from "./fetcher";

export type PermissionsState = { permissions: string[] | undefined; error: string | null };

/** Fetches the signed-in user's permission keys once per mount.
 *
 *  `permissions` is `undefined` while the request is in flight. Callers pass it straight to
 *  `gate`/`gateDo` (src/lib/permission-ui.ts), which already treat an absent array as "no
 *  permissions" — so every gated control stays correctly disabled during the fetch rather than
 *  flashing open and then locking, which is what returning `[]` in the meantime would cause.
 *
 *  A failed fetch is reported via `error`, never swallowed: an empty permissions array on
 *  failure is indistinguishable from a real "no grants" account, and every control on the page
 *  would silently and permanently disable with no way for the user to tell why. Callers fold
 *  `error` into their own error banner alongside their other fetch failures. */
export function usePermissions(): PermissionsState {
  const [permissions, setPermissions] = useState<string[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ permissions: string[] }>("/api/auth/me").then((me) => setPermissions(me.permissions))
      .catch((e) => setError((e as Error).message));
  }, []);

  return { permissions, error };
}
