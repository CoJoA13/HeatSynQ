// No imports, deliberately. This module is the graph's leaf so that services can throw
// HttpError without pulling in next/server or Prisma, which is what created the
// settings -> http -> sessions -> settings cycle. (Enforced by tests/errors.test.ts — the
// shared ZodError-to-message translation that also needs a `zod` import lives in
// ./error-message.ts instead, precisely so this file can stay at zero.)
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
