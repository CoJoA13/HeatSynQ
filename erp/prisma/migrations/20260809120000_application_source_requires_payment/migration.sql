-- Phase 5B Codex fix (spec §4.1): a PAYMENT or DISCOUNT application must name a payment source.
--
-- The prior definition (20260808230100_accounts_receivable) allowed a source-less PAYMENT/DISCOUNT
-- — both "paymentId" and "creditInvoiceId" null — which reduces an invoice's open balance while
-- identifying no receipt, so the row can never be reconciled to a deposit (via direct SQL, an
-- import, or a future write path). Only a standalone bad-debt WRITE_OFF may legitimately be
-- source-less; CREDIT is unchanged.
--
-- Every row the current services write already satisfies this: applyPayment always sets "paymentId"
-- for PAYMENT/DISCOUNT/WRITE_OFF; applyCredit sets "creditInvoiceId" + null "paymentId". Both live
-- databases held zero Application rows when this was authored, so the re-ADD validates cleanly.
--
-- Prisma's schema language has no check-constraint syntax (the StoredDocument_kind_owner_check
-- precedent), so this DROPs and re-ADDs the constraint whole rather than editing the already-applied
-- accounts_receivable migration.
ALTER TABLE "Application" DROP CONSTRAINT "Application_source_check";
ALTER TABLE "Application" ADD CONSTRAINT "Application_source_check" CHECK (
  ("type" IN ('PAYMENT','DISCOUNT') AND "paymentId" IS NOT NULL AND "creditInvoiceId" IS NULL)
  OR ("type" = 'WRITE_OFF' AND "creditInvoiceId" IS NULL)
  OR ("type" = 'CREDIT' AND "paymentId" IS NULL AND "creditInvoiceId" IS NOT NULL)
);
