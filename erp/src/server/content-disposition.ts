/**
 * A safe `Content-Disposition` header value — the ONE place a filename is turned into that header
 * anywhere in this codebase (issue #87). A filename is attacker-controllable input (a customer
 * `code`, an uploaded attachment name) that lands verbatim in a raw response header, so building
 * the header by string interpolation is a header-injection vector AND a crash: a name carrying a
 * CR/LF or a codepoint outside the Latin1/ByteString range `Headers`/`NextResponse` accept throws
 * when the response is constructed — and on the statement print path that throw fires AFTER the
 * document was archived, so the operator sees a failed print while an unseen archive committed.
 *
 * A dependency-free LEAF (the `errors.ts`/`order-locks.ts` precedent): it imports nothing and holds
 * only pure string work, so it is importable from a route, a service, or another leaf without
 * dragging a graph behind it. `attachments.ts` (the original home of this encoding) now delegates
 * here so the RFC 5987 / quoted-string logic lives in exactly one place; the document-download and
 * statement print routes call it directly.
 */

/** Strips control characters (CR/LF header-injection defense) — the raw filename may be attacker
 *  input landing in a response header, so a name like `x\r\nSet-Cookie: evil=1` must not be able to
 *  inject a second header, and a CR/LF alone must not crash the `Headers` constructor. */
function stripControlChars(name: string): string {
  return name.replace(/[\x00-\x1f\x7f]/g, "");
}

/** Escapes backslash/quote for the quoted-string form (RFC 6266 / RFC 2616 §2.2) — an unescaped
 *  quote would otherwise terminate the `filename="..."` parameter early and let the rest of the
 *  name (or a crafted suffix) read as new header syntax. */
function escapeQuoted(name: string): string {
  return name.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/** ASCII-only approximation for the legacy `filename=` parameter: every codepoint outside printable
 *  ASCII (0x20-0x7e) becomes "_". `Headers`/`NextResponse` require header values to be
 *  Latin1/ByteString, so a raw non-ASCII codepoint here would throw outright; the faithful name is
 *  carried by the RFC 5987 `filename*=` parameter, which every current client reads in preference. */
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_");
}

/**
 * RFC 5987 `ext-value` percent-encoding for the `filename*=UTF-8''...` parameter.
 * `encodeURIComponent` already escapes everything the grammar's `attr-char` set excludes except
 * `* ' ( )` (left literal since all four are legal inside a URI component) — those four are escaped
 * by hand on top so the result is valid `attr-char`-only percent-encoding, and any CR/LF that
 * survived as raw bytes collapses into its own %-encoded form, so this half of the header is immune
 * to header injection independent of the stripping the composer already does up front.
 */
export function rfc5987Encode(name: string): string {
  return encodeURIComponent(name).replace(/[*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * A `Content-Disposition` value: `<disposition>; filename="<sanitized>"`, optionally followed by
 * the faithful RFC 5987 `filename*=UTF-8''...` form. Always safe — control chars stripped, quotes
 * escaped — so a hostile filename can never crash the response or inject a header.
 *
 * `alwaysExtended` controls the RFC 5987 parameter:
 *  - `false` (the default — the document-download / statement print surface): the `filename*=` form
 *    is emitted ONLY when the name carries bytes the ASCII quoted form cannot represent. A plain
 *    ASCII filename's header is therefore byte-for-byte `<disposition>; filename="name.pdf"` — the
 *    exact string every stored-document download test in this codebase already pins — while a
 *    non-ASCII name still downloads under its real name.
 *  - `true` (the attachments surface): the `filename*=` form is sent unconditionally alongside
 *    `filename=` (RFC 6266 §4.3's own recommendation — one code path rather than an ASCII/non-ASCII
 *    fork), which is the behavior `attachments.ts` has always emitted.
 */
export function contentDispositionValue(
  disposition: "inline" | "attachment", filename: string, opts: { alwaysExtended?: boolean } = {},
): string {
  const stripped = stripControlChars(filename);
  const ascii = asciiFallback(stripped);
  let header = `${disposition}; filename="${escapeQuoted(ascii)}"`;
  if (opts.alwaysExtended || stripped !== ascii) {
    header += `; filename*=UTF-8''${rfc5987Encode(stripped)}`;
  }
  return header;
}
