import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/fetcher";
import { normalizeRequestNonce, submitWithConflictRetry } from "@/lib/idempotent-save";

// Fix-wave R4 finding 5, the client half. The order entry page retries a 409 automatically —
// the documented contract is that a Serializable loser wrote nothing and consumed no order
// number, so resending is the safe answer. What made that safe answer dangerous was that the
// retry was, to the server, a brand-new request: it allocated the next number and created a
// SECOND order for one operator action. The server now recognizes the replay by its nonce, and
// this is the client-side property that makes that recognition possible — the retry must carry
// the SAME payload, nonce included, not a freshly rebuilt one.
//
// Pure module (vitest runs `environment: "node"`; this codebase has no component-test harness),
// extracted for exactly that reason — the same shape as `computeOrphanChurn` and
// `makeLatestGate`.

const conflict = () => new ApiError("Another change to that order was saved at the same time", 409);

describe("submitWithConflictRetry", () => {
  it("resends the IDENTICAL body on a 409 — same object, same nonce", async () => {
    const body = { customerId: "c1", clientRequestId: "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e" };
    const seen: unknown[] = [];
    let attempt = 0;

    const result = await submitWithConflictRetry(body, async (sent) => {
      seen.push(sent);
      if (++attempt === 1) throw conflict();
      return { order: { id: "o1" } };
    });

    expect(result).toEqual({ order: { id: "o1" } });
    expect(seen).toHaveLength(2);
    // Reference identity, not a structural match: the retry must not rebuild the payload, because
    // rebuilding is what would mint a new nonce and create the duplicate order.
    expect(seen[0]).toBe(body);
    expect(seen[1]).toBe(body);
  });

  it("passes a non-409 straight through without retrying", async () => {
    let calls = 0;
    await expect(submitWithConflictRetry({ a: 1 }, async () => {
      calls++;
      throw new ApiError("Pick a customer.", 400);
    })).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  it("retries exactly once — a second 409 is reported, not looped on", async () => {
    let calls = 0;
    await expect(submitWithConflictRetry({ a: 1 }, async () => {
      calls++;
      throw conflict();
    })).rejects.toMatchObject({ status: 409 });
    expect(calls).toBe(2);
  });

  it("does not retry at all when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await submitWithConflictRetry({ a: 1 }, async () => { calls++; return "ok"; });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("normalizeRequestNonce", () => {
  it("keeps a v4 uuid exactly as stored — this is what two tabs resuming one draft share", () => {
    const stored = "3f6a1b2c-1111-4d22-8e33-9f0a1b2c3d4e";
    expect(normalizeRequestNonce(stored)).toBe(stored);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["not a uuid", "hello"],
    ["a non-v4 uuid", "3f6a1b2c-1111-1d22-8e33-9f0a1b2c3d4e"],
    ["not a string", 12345],
  ])("mints a fresh nonce when the stored value is %s", (_label, raw) => {
    const minted = normalizeRequestNonce(raw);
    // A draft autosaved before this column existed carries no nonce; anything unrecognizable is
    // replaced rather than sent on to be rejected by the server's own uuid check.
    expect(normalizeRequestNonce(minted)).toBe(minted);
    expect(minted).not.toBe(normalizeRequestNonce(raw)); // a fresh one each time, never a constant
  });
});
