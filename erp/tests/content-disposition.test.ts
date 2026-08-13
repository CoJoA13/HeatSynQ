import { describe, it, expect, beforeEach } from "vitest";
import { prisma, truncateAll } from "./helpers/db";
import { signInWith } from "./helpers/auth";
import { storeDocument } from "@/server/documents";
import { contentDispositionValue } from "@/server/content-disposition";
import { POST as printStatementRoute } from "@/app/api/receivables/statements/route";
import { GET as documentRoute } from "@/app/api/documents/[docId]/route";

/**
 * Phase 7 Task 13 — issue #87: a customer `code` carrying a newline/quote is interpolated straight
 * into the `Content-Disposition` header of every filename-emitting document route. Before the fix,
 * constructing the response `Headers` for such a name throws — and on the statement PRINT path this
 * happens AFTER the document has already been archived, so the operator sees a failed print while an
 * unseen archive committed. These pin the two filename-emitting routes the brief names (the statement
 * print route AND the generic /api/documents/[docId] download) against a hostile code: a clean,
 * sanitized, non-crashing response.
 */

const withParams = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

function bodyReq(url: string, cookie: string | undefined, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
const getReq = (url: string, cookie?: string): Request =>
  new Request(url, { headers: cookie ? { cookie } : {} });

describe("contentDispositionValue — the shared leaf", () => {
  it("leaves a plain ASCII name byte-for-byte today's header (no filename* — the download tests' pin)", () => {
    expect(contentDispositionValue("inline", "statement-C100.pdf"))
      .toBe('inline; filename="statement-C100.pdf"');
    expect(contentDispositionValue("inline", "traveler-71246.pdf"))
      .toBe('inline; filename="traveler-71246.pdf"');
  });

  it("strips CR/LF (header-injection / crash defense) — the whole value is free of line breaks", () => {
    const value = contentDispositionValue("inline", "x\r\nSet-Cookie: evil=1.pdf");
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toBe('inline; filename="xSet-Cookie: evil=1.pdf"');
  });

  it("escapes a quote/backslash so the parameter cannot be terminated early", () => {
    expect(contentDispositionValue("inline", 'a"b.pdf')).toBe('inline; filename="a\\"b.pdf"');
    expect(contentDispositionValue("inline", "a\\b.pdf")).toBe('inline; filename="a\\\\b.pdf"');
  });

  it("adds the faithful RFC 5987 filename*= only when the name is non-ASCII", () => {
    const value = contentDispositionValue("inline", "測定.pdf");
    expect(value).toContain('filename="__.pdf"'); // one "_" per non-ASCII codepoint in the fallback
    const match = /filename\*=UTF-8''([^;]+)/.exec(value);
    expect(match).not.toBeNull();
    expect(decodeURIComponent(match![1])).toBe("測定.pdf"); // round-trips to the real name
  });

  it("alwaysExtended forces filename*= even for an ASCII name (the attachments surface's behavior)", () => {
    expect(contentDispositionValue("attachment", "data.csv", { alwaysExtended: true }))
      .toBe("attachment; filename=\"data.csv\"; filename*=UTF-8''data.csv");
  });
});

// A trimmed customer code carrying a CR, an LF and a double-quote — issue #87's exact shape. The
// code column is a plain string among live rows, so a row created directly can hold what the create
// route's own validation might not; the header layer must be safe regardless of how the code got in.
const HOSTILE_CODE = 'ACME\r\n"OH';

describe("#87 — the statement print route sanitizes a hostile customer code (no crash, no orphaned archive)", () => {
  beforeEach(truncateAll);

  it("returns a clean 200 with a sanitized Content-Disposition and still archives the document", async () => {
    const customer = await prisma.customer.create({ data: { code: HOSTILE_CODE, name: "Hostile Co" } });
    const cookie = await signInWith(["receivables.view"]);

    const res = await printStatementRoute(
      bodyReq("http://t/api/receivables/statements", cookie, { customerId: customer.id }),
      withParams({}),
    );

    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition")!;
    // No raw CR/LF survived into the header — the header-injection / Headers-constructor-crash defense.
    expect(cd).not.toMatch(/[\r\n]/);
    // The control chars are stripped and the quote escaped for the quoted-string form.
    expect(cd).toContain('statement-ACME');
    expect(cd).toContain('OH.pdf');
    expect(cd).toContain('ACME\\"OH'); // the embedded quote is backslash-escaped, not left raw
    // The archive committed and its id is returned — not orphaned behind a failed header build.
    expect(res.headers.get("x-document-id")).toBeTruthy();
  });
});

describe("#87 — the generic document download sanitizes a hostile customer code", () => {
  beforeEach(truncateAll);

  it("returns a clean 200 with a sanitized Content-Disposition for a STATEMENT document", async () => {
    const customer = await prisma.customer.create({ data: { code: HOSTILE_CODE, name: "Hostile Co" } });
    const doc = await prisma.$transaction((tx) =>
      storeDocument(tx, { kind: "STATEMENT", customerId: customer.id }, Buffer.from("%PDF-1.7\n")));
    const cookie = await signInWith(["receivables.view"]);

    const res = await documentRoute(
      getReq(`http://t/api/documents/${doc.id}`, cookie),
      withParams({ docId: doc.id }),
    );

    expect(res.status).toBe(200);
    const cd = res.headers.get("content-disposition")!;
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toContain('statement-ACME');
    expect(cd).toContain('OH.pdf');
  });
});
