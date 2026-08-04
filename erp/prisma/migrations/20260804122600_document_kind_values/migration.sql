-- Phase 4 Task 2, part 1 of 2. DocumentKind widens from TRAVELER-only to the four documents this
-- phase stores: the shipping ticket, the bill of lading and the certification (design spec §4.3).
--
-- These three values are split into their own migration directory ON PURPOSE, and splitting them
-- back out is not a tidy-up — it breaks the deploy. Postgres refuses to USE a newly added enum
-- value in the same transaction that added it:
--
--   ERROR:  unsafe use of new value "SHIPPER" of enum type "DocumentKind"
--   HINT:   New enum values must be committed before they can be used.
--
-- (Verified against this project's own Postgres 18 before writing this file.) The very next
-- migration, 20260804122700_certs_and_shipping, adds the kind/owner CHECK constraint whose
-- expression names all four values, so it must run in a LATER transaction than this one.
-- `prisma migrate deploy` runs each migration directory in its own transaction, which is exactly
-- what makes two directories the fix.
--
-- Additive only: every existing row is a TRAVELER and keeps that value untouched.

-- AlterEnum
ALTER TYPE "DocumentKind" ADD VALUE 'SHIPPER';
ALTER TYPE "DocumentKind" ADD VALUE 'BOL';
ALTER TYPE "DocumentKind" ADD VALUE 'CERT';
