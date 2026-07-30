// No imports, deliberately. This module is the graph's leaf so that services can throw
// HttpError without pulling in next/server or Prisma, which is what created the
// settings -> http -> sessions -> settings cycle.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
