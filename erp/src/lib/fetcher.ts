import { beginWrite, isWriteMethod } from "./in-flight-writes";

/** Thrown by `api()` on a non-OK response. Carries the HTTP status alongside the server's own
 *  error message, so a caller can tell a specific, expected refusal (e.g. the reference-delete
 *  guard's 400 "still in use by N records") apart from a 500 or a network failure — a plain
 *  `Error` loses the status the moment it's thrown. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * `fetch`, with every WRITE counted while it is in flight (#276).
 *
 * The count is what lets the unsaved-edit guard tell the truth: during a save the editing section
 * is still registered dirty (its flag clears only after the response lands), and without this the
 * navigation prompt offered to discard changes that were committing regardless. See
 * `in-flight-writes.ts` for why this is counted centrally rather than registered per save.
 *
 * Exported because `api()` cannot serve every caller: a print streams a `Blob` and reads
 * `x-document-id` off the headers, and an upload sends `FormData` — all of which need the raw
 * `Response`. Those callers use this instead of bare `fetch`, and
 * `tests/unsaved-registration-sweep.test.ts` refuses a bare `fetch` write anywhere under `src/`
 * except `src/server`, `src/app/api` and this file, so the count cannot quietly stop being complete.
 *
 * The counter is released in a `finally`, so a rejected request — a dropped connection, an aborted
 * navigation — releases it exactly like a resolved one.
 *
 * **The `await` on the next line is load-bearing.** Without it the promise is returned rather than
 * awaited, the `finally` runs at request-ISSUE time, and the count is raised for zero async ticks —
 * so `confirmDiscard`, which reads it from a click handler while the response is still outstanding,
 * sees nothing in flight and the untruthful wording is back. It looks like the redundant
 * `return await` some lint rules flag; it is not. `tests/in-flight-writes.test.ts` reds if it goes.
 *
 * The window closes when the response HEADERS arrive, which is when the server has taken the write.
 * An editor that clears its dirty flag from a FOLLOW-UP GET rather than from this response is
 * therefore still briefly dirty-with-nothing-in-flight — see `in-flight-writes.ts` for the two that
 * do, recorded rather than papered over.
 */
export async function trackedFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!isWriteMethod(init?.method)) return fetch(path, init);
  const endWrite = beginWrite();
  try {
    return await fetch(path, init);
  } finally {
    endWrite();
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await trackedFetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}
