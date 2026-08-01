/** Thrown by `api()` on a non-OK response. Carries the HTTP status alongside the server's own
 *  error message, so a caller can tell a specific, expected refusal (e.g. the reference-delete
 *  guard's 400 "still in use by N records") apart from a 500 or a network failure — a plain
 *  `Error` loses the status the moment it's thrown. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError((body as { error?: string }).error ?? `Request failed (${res.status})`, res.status);
  }
  return body as T;
}
