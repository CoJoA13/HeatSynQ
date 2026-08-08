-- Phase 5A Task 2, part 1 of 2. DocumentKind widens from the four Phase 4 documents to six: an
-- invoice and a credit memo are stored paper exactly like a traveler, a ticket, a BOL or a cert
-- (design spec §10), both owned by StoredDocument."invoiceId".
--
-- These two values are split into their own migration directory ON PURPOSE, and splitting them
-- back out is not a tidy-up — it breaks the deploy. Postgres refuses to USE a newly added enum
-- value in the same transaction that added it:
--
--   ERROR:  unsafe use of new value "INVOICE" of enum type "DocumentKind"
--   HINT:   New enum values must be committed before they can be used.
--
-- The very next migration, 20260806221500_pricing_and_invoicing, re-states the kind/owner CHECK
-- constraint whose expression names both new values, so it must run in a LATER transaction than
-- this one. `prisma migrate deploy` runs each migration directory in its own transaction, which
-- is exactly what makes two directories the fix. This is the same split, for the same reason,
-- that 20260804122600_document_kind_values already performs for Phase 4's three values.
--
-- Additive only: every existing row keeps its value untouched.

-- AlterEnum
ALTER TYPE "DocumentKind" ADD VALUE 'INVOICE';
ALTER TYPE "DocumentKind" ADD VALUE 'CREDIT';
