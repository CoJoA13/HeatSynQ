import { describe, it, expect } from "vitest";
import { prisma } from "./helpers/db";
import { practiceMode, assertPracticeDatabase, PRACTICE_DB_NAME } from "@/server/practice-mode";
import { HttpError } from "@/server/errors";

// The vitest process connects to erp_test (tests/helpers/setup.ts rewrites DATABASE_URL), so
// current_database() is 'erp_test' — never 'erp_practice'. That makes both the negative resolution
// and the reset-guard refusal RED-verifiable here with NO stubbing (the §5.3 safety property).
describe("practiceMode / assertPracticeDatabase (Phase 8B §5.1/§5.3)", () => {
  it("names the practice database once", () => {
    expect(PRACTICE_DB_NAME).toBe("erp_practice");
  });

  it("resolves false in the erp_test process (db-identity authoritative)", async () => {
    await expect(practiceMode()).resolves.toBe(false);
  });

  it("memoizes — repeated calls share one cached promise (computed once, no per-call round-trip)", async () => {
    const p1 = practiceMode();
    const p2 = practiceMode();
    expect(p1).toBe(p2); // same promise reference — resolved once, not re-queried per call
    expect(await p1).toBe(false);
  });

  it("assertPracticeDatabase refuses with a 403 when the DB is not erp_practice", async () => {
    await expect(assertPracticeDatabase(prisma)).rejects.toBeInstanceOf(HttpError);
    await expect(assertPracticeDatabase(prisma)).rejects.toMatchObject({ status: 403 });
  });
});
