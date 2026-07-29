import { AsyncLocalStorage } from "node:async_hooks";

export type Actor = { id: string | null; name: string };

const storage = new AsyncLocalStorage<Actor>();

export function runWithActor<T>(actor: Actor, fn: () => Promise<T>): Promise<T> {
  return storage.run(actor, fn);
}

export function currentActor(): Actor {
  return storage.getStore() ?? { id: null, name: "system" };
}
