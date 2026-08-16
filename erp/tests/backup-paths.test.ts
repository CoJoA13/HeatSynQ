import { describe, it, expect } from "vitest";
import {
  resolveBackupDir, archivePath, statusPath, stampFor, manualArchiveName, tempNameFor,
} from "@/server/backup-paths";
import { isArchiveName, archiveSourceOf, DEFAULT_STALE_HOURS } from "@/lib/backup-constants";
import { HttpError } from "@/server/errors";

describe("backup archive names", () => {
  it("recognises the nightly and manual shapes, and nothing else", () => {
    expect(isArchiveName("erp_2026-08-16_020000.sql.gz")).toBe(true);
    expect(isArchiveName("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz")).toBe(true);
    // The status file, temp files, and anything else in the folder are NOT archives.
    expect(isArchiveName("backup-status.json")).toBe(false);
    expect(isArchiveName(".erp_2026-08-16_020000.sql.tmp")).toBe(false);
    expect(isArchiveName("erp_2026-08-16_020000.sql")).toBe(false);
    expect(isArchiveName("../../etc/passwd")).toBe(false);
    expect(isArchiveName("erp_2026-08-16_020000.sql.gz/../x")).toBe(false);
  });

  it("classifies the source from the name", () => {
    expect(archiveSourceOf("erp_2026-08-16_020000.sql.gz")).toBe("nightly");
    expect(archiveSourceOf("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz")).toBe("manual");
    expect(archiveSourceOf("nonsense")).toBe(null);
  });

  it("builds a manual name that is itself a valid archive name, and its temp partner", () => {
    const d = new Date(2026, 7, 16, 14, 30, 12); // local time, matching the sh script's `date`
    expect(stampFor(d)).toBe("2026-08-16_143012");
    const name = manualArchiveName(d, "a7f3b1c9");
    expect(name).toBe("erp_manual_2026-08-16_143012_a7f3b1c9.sql.gz");
    expect(isArchiveName(name)).toBe(true);
    // The temp partner is a dotfile so it never appears in a listing, and is NOT an archive name.
    expect(tempNameFor(name)).toBe(".erp_manual_2026-08-16_143012_a7f3b1c9.sql.tmp");
    expect(isArchiveName(tempNameFor(name))).toBe(false);
  });

  it("pads single-digit month/day/time components", () => {
    expect(stampFor(new Date(2026, 0, 2, 3, 4, 5))).toBe("2026-01-02_030405");
  });

  it("exposes the owner-settled default staleness threshold", () => {
    expect(DEFAULT_STALE_HOURS).toBe(36);
  });
});

describe("resolveBackupDir", () => {
  it("defaults to /backups when BACKUP_DIR is unset", () => {
    expect(resolveBackupDir(undefined)).toBe("/backups");
  });

  it("resolves a relative dev path to an absolute one", () => {
    expect(resolveBackupDir("./backups")).toBe(`${process.cwd()}/backups`);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveBackupDir("  /backups  ")).toBe("/backups");
  });

  it("refuses an empty value", () => {
    expect(() => resolveBackupDir("   ")).toThrow(HttpError);
  });

  it("refuses shell metacharacters even though the value is deploy-set", () => {
    for (const bad of ["/backups; rm -rf /", "/backups && x", "/back`ups`", "/back$ups", "/back|ups",
                       "/back>ups", "/back*ups", "/back'ups", '/back"ups', "/back\nups"]) {
      expect(() => resolveBackupDir(bad), bad).toThrow(HttpError);
    }
  });

  it("refuses .. segments in the RAW value (path.resolve would silently normalise them away)", () => {
    expect(() => resolveBackupDir("/backups/../etc")).toThrow(HttpError);
    expect(() => resolveBackupDir("../backups")).toThrow(HttpError);
  });
});

describe("archivePath", () => {
  it("joins a valid archive name onto the folder", () => {
    expect(archivePath("/backups", "erp_2026-08-16_020000.sql.gz"))
      .toBe("/backups/erp_2026-08-16_020000.sql.gz");
  });

  it("refuses any name that is not a valid archive name — the escape guard", () => {
    for (const bad of ["../../etc/passwd", "/etc/passwd", "erp_x.sql.gz", "backup-status.json", ""]) {
      expect(() => archivePath("/backups", bad), bad).toThrow(HttpError);
    }
  });

  it("puts the status file in the same folder", () => {
    expect(statusPath("/backups")).toBe("/backups/backup-status.json");
  });
});
