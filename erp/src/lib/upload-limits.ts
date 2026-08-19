// Client-safe leaf (#38). MIRRORS src/server/attachments.ts's MAX_SIZE cap and its exact refusal
// message by convention rather than importing src/server/** — a client component pulling from
// there drags node:async_hooks and Prisma into the browser bundle (CLAUDE.md "Constraints that
// will bite you"; the AttachmentsSection type-mirror precedent). tests/upload-limits.test.ts is
// the drift guard: it reads attachments.ts and fails if either the cap or the message moves
// without this file moving with it.

/** src/server/attachments.ts's MAX_SIZE — the byte-length cap on any one uploaded file. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * The server's refusal for an oversized file, verbatim, or null when the size is acceptable.
 * Checking `file.size` before building the FormData spares the user a 20MB+ upload that can only
 * end in this same message — and shows the identical words the server would have sent, so the
 * pre-check never invents a second wording for one refusal (§5.16's say-the-real-reason spirit).
 */
export function attachmentSizeError(bytes: number): string | null {
  return bytes > MAX_ATTACHMENT_BYTES ? "Attachments cannot exceed 20 MB" : null;
}
