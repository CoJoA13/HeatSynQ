-- Phase 6 Task 1, part 1 of 2 — the two enum values Quoting needs (design spec §9).
--
-- Its own directory, ahead of 20260810120100_quoting, because Postgres refuses to USE a new enum
-- value inside the same transaction that ADDed it, and `migrate deploy` runs one directory per
-- transaction (the 20260804122600_document_kind_values / 20260806221400_document_kind_invoice_values /
-- 20260808230000_document_kind_statement_value precedent). The _quoting migration is the first
-- that may use either value — its re-stated StoredDocument_kind_owner_check names 'QUOTE'.

-- AlterEnum
ALTER TYPE "DocumentKind" ADD VALUE 'QUOTE';

-- AlterEnum
ALTER TYPE "PriceSource" ADD VALUE 'QUOTE';
