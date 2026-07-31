import { describe, it, expect } from "vitest";
import { HttpError } from "@/server/errors";
import { HttpError as ReExported } from "@/server/http";

describe("HttpError", () => {
  it("carries status and message", () => {
    const err = new HttpError(404, "Not found");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Not found");
    expect(err).toBeInstanceOf(Error);
  });

  it("is the same class when imported via http (re-export, not a copy)", () => {
    expect(ReExported).toBe(HttpError);
    expect(new ReExported(400, "x")).toBeInstanceOf(HttpError);
  });

  it("errors.ts imports nothing — the module graph stays acyclic", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/server/errors.ts", import.meta.url), "utf8"));
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
