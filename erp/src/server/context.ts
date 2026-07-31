import { AsyncLocalStorage } from "node:async_hooks";
// Type-only import: erased at compile time, so this does NOT create a runtime cycle with
// sessions -> settings -> context.
import type { SessionUser } from "./sessions";

export type Actor = { id: string | null; name: string };
export type RequestContext = { actor: Actor; user: SessionUser | null };

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentActor(): Actor {
  return storage.getStore()?.actor ?? { id: null, name: "system" };
}

export function currentUser(): SessionUser | null {
  return storage.getStore()?.user ?? null;
}
