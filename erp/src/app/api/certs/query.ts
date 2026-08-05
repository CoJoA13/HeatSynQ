// Not a route — the orders/query.ts precedent: GET /api/certs and GET /api/certs/export must
// agree on exactly what a given query string means, so the parse lives here once.
import { HttpError } from "@/server/http";
import type { CertFilter } from "@/server/certs";
import { CERT_SCOPES, type CertScopeValue } from "@/lib/cert-constants";

const SCOPE_VALUES = new Set<string>(CERT_SCOPES);

function orUndefined(value: string | null): string | undefined {
  return value === null || value === "" ? undefined : value;
}

/** Rejects an unrecognized token as a field-anchored 400 naming it — the orders/query.ts
 *  `parseStatus` precedent: `listCerts`/`exportCerts` hand `scope` straight to Prisma's
 *  `{ scope: ... }`, and an enum value Prisma has never heard of throws a status-less
 *  `PrismaClientValidationError` there rather than this clean 400. */
function parseScope(url: URL): CertScopeValue | undefined {
  const raw = orUndefined(url.searchParams.get("scope"));
  if (raw === undefined) return undefined;
  if (!SCOPE_VALUES.has(raw)) throw new HttpError(400, `Unknown certification scope "${raw}"`);
  return raw as CertScopeValue;
}

/** `printed=1` / `printed=0` / absent — mirrors `includeVoided`'s own `"1"` convention rather
 *  than accepting `true`/`false`, so every boolean-shaped filter in this app reads the same way
 *  off a query string. */
function parsePrinted(url: URL): boolean | undefined {
  const raw = url.searchParams.get("printed");
  if (raw === null || raw === "") return undefined;
  return raw === "1";
}

export function parseCertFilter(url: URL): CertFilter {
  return {
    customerId: orUndefined(url.searchParams.get("customerId")),
    scope: parseScope(url),
    printed: parsePrinted(url),
    includeVoided: url.searchParams.get("includeVoided") === "1",
    search: orUndefined(url.searchParams.get("search")),
  };
}
