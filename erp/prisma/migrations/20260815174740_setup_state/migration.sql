-- CreateTable
CREATE TABLE "SetupState" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "numbersConfirmedAt" TIMESTAMP(3),
    "checklistDismissedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SetupState_pkey" PRIMARY KEY ("id")
);

-- SetupState is a singleton by construction, not by convention (the BillingConfig precedent).
ALTER TABLE "SetupState" ADD CONSTRAINT "SetupState_singleton_check" CHECK ("id" = 'singleton');

-- Seed the one row here rather than lazily on first read, so getSetupState is a plain findFirst
-- and setSetupState is a plain audited update with a real before-snapshot (§7).
INSERT INTO "SetupState" ("id", "updatedAt")
VALUES ('singleton', now())
ON CONFLICT ("id") DO NOTHING;
