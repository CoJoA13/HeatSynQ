// Pure functions over the flat permission-key array /api/auth/me returns. Client-safe:
// no server imports (importing src/server/** would drag Prisma into the browser bundle).
import type { SpecialAction } from "./permission-constants";

export type Gate = { allowed: boolean; disabled: boolean; title: string | undefined };

function decide(held: string[] | undefined, key: string, label: string): Gate {
  const allowed = (held ?? []).includes(key);
  return { allowed, disabled: !allowed, title: allowed ? undefined : `Requires ${label}` };
}

/** Gate a control on an area permission, e.g. gate(me.permissions, "customers.delete"). */
export function gate(held: string[] | undefined, key: string): Gate {
  return decide(held, key, key);
}

/** Gate on a named special action. /api/auth/me keys these as `action.<name>`, but the tooltip
 *  names the action the way the roles screen does, without the prefix. */
export function gateDo(held: string[] | undefined, special: SpecialAction): Gate {
  return decide(held, `action.${special}`, special);
}
