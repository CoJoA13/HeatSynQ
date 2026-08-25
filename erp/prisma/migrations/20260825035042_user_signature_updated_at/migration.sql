-- #171: a signature-specific revision that moves whenever the stored image does, surfaced by
-- listUsers as the preview URL's cache-bust token so a failed preview retries by construction on
-- ANY change (this admin's OR another's). See prisma/schema.prisma and src/server/users.ts.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "signatureUpdatedAt" TIMESTAMP(3);

-- Backfill existing signatures so an already-stored image gets a deterministic, non-null revision
-- at once (rather than a null token that only becomes real on the next write). `updatedAt` is the
-- best available proxy for "when this row last changed"; any later setSignature/clearSignature
-- overwrites it with a fresh stamp. Rows with no signature stay NULL.
UPDATE "User" SET "signatureUpdatedAt" = "updatedAt" WHERE "signatureImage" IS NOT NULL;
