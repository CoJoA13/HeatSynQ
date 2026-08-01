import { describe, it, expect, afterEach, vi } from "vitest";
import { api, ApiError } from "@/lib/fetcher";

// Node's global fetch (undici), stubbed per test — no jsdom needed for this one, since `api()`
// only touches fetch/Response shapes, not the DOM.
describe("api() fetcher", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("resolves the parsed JSON body on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ hello: "world" }),
    }));
    await expect(api("/x")).resolves.toEqual({ hello: "world" });
  });

  // ReferenceTable.remove() (src/components/ReferenceTable.tsx) needs to tell the delete guard's
  // 400 ("still in use by N records") apart from a 500 or a network failure, so it can fetch the
  // blocker list only for the former — reporting a genuine server error as "N records use it"
  // would misdiagnose what actually happened. That requires the status to survive the throw.
  it("throws an ApiError carrying the response status and the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 400, json: async () => ({ error: "That terms is still in use by 1 record(s)" }),
    }));
    await expect(api("/x")).rejects.toBeInstanceOf(ApiError);
    await expect(api("/x")).rejects.toMatchObject({
      message: "That terms is still in use by 1 record(s)", status: 400,
    });
  });

  it("falls back to a generic message when the failed response has no JSON error body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, json: async () => { throw new Error("not json"); },
    }));
    await expect(api("/x")).rejects.toMatchObject({ message: "Request failed (500)", status: 500 });
  });
});
