/**
 * Magic-byte sniffing for uploaded images — the #49 lesson, shared. A declared MIME alone lets
 * renamed or corrupt bytes persist and poison every later print of the document embedding them;
 * sniffing the first bytes closes the ordinary case (a mis-named file) at upload time, while the
 * PDF layer's own full parse remains the backstop at render time.
 *
 * Extracted verbatim from users.ts's signature upload (#49's fix) when Phase 7's template-logo
 * upload became its second caller (spec §6.3 names the reuse) — one copy of the magic numbers,
 * every upload path. Dependency-free leaf, the errors.ts/order-locks.ts precedent: importable
 * from any service without dragging a permission or client graph behind it.
 *
 * CONTRACT: callers allowlist `mimeType` to PNG/JPEG FIRST (both existing callers do, with their
 * own field-anchored 400s) — any non-PNG type reaching this function is checked against the JPEG
 * markers, which is only meaningful for "image/jpeg".
 */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** True when `data`'s leading bytes match the magic numbers of the declared image type. A prefix
 *  check is deliberate — see the header; full validation stays with the renderer's parser. */
export function matchesDeclaredImage(mimeType: string, data: Buffer): boolean {
  if (mimeType === "image/png") {
    return data.byteLength >= PNG_MAGIC.byteLength && data.subarray(0, PNG_MAGIC.byteLength).equals(PNG_MAGIC);
  }
  // image/jpeg: SOI marker then another marker byte.
  return data.byteLength >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
}
