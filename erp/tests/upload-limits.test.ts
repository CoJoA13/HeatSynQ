import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ATTACHMENT_BYTES, attachmentSizeError } from "@/lib/upload-limits";

// #38 — the client-side pre-check leaf. The component mirrors the server's cap and message by
// convention rather than importing src/server/** (client components must not — CLAUDE.md), so
// this suite pins BOTH halves: the leaf's behavior at the boundary, and that the mirrored
// literals still match what src/server/attachments.ts actually enforces (a drift guard, the
// backup-permission-backfill style — if the server's cap or message ever moves, this test names
// the two files that must move together).
describe("upload limits (#38)", () => {
  it("accepts a file exactly at the 20 MB cap and refuses one byte over", () => {
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES)).toBeNull();
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES - 1)).toBeNull();
    expect(attachmentSizeError(0)).toBeNull();
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES + 1)).toBe("Attachments cannot exceed 20 MB");
  });

  it("mirrors the server's exact cap and refusal message (drift guard)", () => {
    const server = readFileSync(join(process.cwd(), "src/server/attachments.ts"), "utf8");
    // The cap: attachments.ts declares MAX_SIZE = 20 * 1024 * 1024 and refuses strictly-greater
    // byte lengths; the leaf's constant must be that same number.
    expect(server).toMatch(/MAX_SIZE = 20 \* 1024 \* 1024/);
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    // The message: the client shows the server's refusal VERBATIM, so a user who slips past the
    // pre-check (or never had it) reads the identical words either way.
    expect(server).toContain('"Attachments cannot exceed 20 MB"');
    expect(attachmentSizeError(MAX_ATTACHMENT_BYTES + 1)).toBe("Attachments cannot exceed 20 MB");
  });
});
