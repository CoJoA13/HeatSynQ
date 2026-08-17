-- #79: freeze the early-pay discount terms onto the invoice.
--
-- `discountAvailable`/`applyPayment` read the invoice CUSTOMER's current `terms` relation, so
-- reassigning a customer retroactively changed what invoices already in their hands were worth: an
-- invoice finalized under 2/10 Net 30 lost its discount when the customer moved to Net 30, and one
-- finalized under Net 30 gained a discount it never offered. An invoice is frozen paper (§5.4).
--
-- `termsName` already snapshotted the LABEL; these are the numbers behind it, written at finalize
-- beside `dueDate` (which already freezes `netDays`' only effect, hence no `netDays` column here).
-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "termsDiscountDays" INTEGER,
ADD COLUMN     "termsDiscountPercent" DECIMAL(5,2);

-- Backfill ALREADY-FINALIZED invoices from their customer's current terms. That is precisely what
-- those invoices compute today, so this preserves their behaviour exactly rather than silently
-- withdrawing a discount from paper the shop has already sent. Without it every existing finalized
-- invoice would read a null pair and offer no discount at all.
--
-- Scoped to kind = 'INVOICE' (a CREDIT offers no early-pay discount and gets no due date either) and
-- to finalized rows (a DRAFT snapshots when it is finalized, like `dueDate`). An invoice whose
-- customer has no terms, or terms with no discount pair, correctly stays null — null means "no
-- discount" here exactly as it does on `Terms`.
UPDATE "Invoice" i
SET "termsDiscountPercent" = t."discountPercent",
    "termsDiscountDays"    = t."discountDays"
FROM "Customer" c
JOIN "Terms" t ON t."id" = c."termsId"
WHERE i."customerId" = c."id"
  AND i."kind" = 'INVOICE'
  AND i."finalizedAt" IS NOT NULL;
