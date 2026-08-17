-- Re-derive the frozen discount pair from each invoice's OWN issued label, correcting the backfill
-- in `20260817121950_invoice_terms_discount_snapshot` (review round 4 of PR #135).
--
-- THE BUG IN THAT BACKFILL: it copied the customer's CURRENT terms. For an invoice finalized before
-- the customer was moved between terms, that is the very relation #79 exists to stop reading — so a
-- `Net 30` invoice could be handed a discount it never offered, or a `2/10 Net 30` invoice lose one
-- it did, permanently, the moment this feature shipped. The invoice's own frozen `termsName` is
-- better evidence of what it was issued under than the customer's terms today.
--
-- `Terms.name` is unique among LIVE rows (a partial index), so a name match is unambiguous.
UPDATE "Invoice" i
SET "termsDiscountPercent" = t."discountPercent",
    "termsDiscountDays"    = t."discountDays"
FROM "Terms" t
WHERE t."deletedAt" IS NULL
  AND t."name" = i."termsName"
  AND i."kind" = 'INVOICE'
  AND i."finalizedAt" IS NOT NULL;

-- An invoice whose label matches no live terms row gets NO discount. Two cases, both correct:
-- a BLANK label (issued for a customer with no terms at all — there was never a discount), and a
-- label naming terms since deleted (§5.14 blocks deleting terms a customer points at, so this is
-- already unlikely — and where it happens, the percent/day count are simply not recoverable, and
-- inventing them from an unrelated customer's current terms is exactly the error above).
UPDATE "Invoice" i
SET "termsDiscountPercent" = NULL,
    "termsDiscountDays"    = NULL
WHERE i."kind" = 'INVOICE'
  AND i."finalizedAt" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Terms" t WHERE t."deletedAt" IS NULL AND t."name" = i."termsName"
  );
