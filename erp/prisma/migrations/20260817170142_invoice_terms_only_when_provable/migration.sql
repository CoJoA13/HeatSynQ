-- Keep a backfilled discount pair ONLY where it can be PROVEN, and clear it everywhere else.
--
-- The three backfills before this one were successively better guesses, and each round of review
-- found the next way a guess could be wrong: the customer's current terms (wrong after a customer is
-- reassigned), then the invoice's own label (wrong if that Terms row's FIGURES changed after the
-- invoice was finalized, or if the row was RENAMED — `updateReference` permits changing name and
-- figures independently). The lesson is that history which was never recorded cannot be
-- reconstructed, so this stops inferring and draws the line at what the data can actually prove.
--
-- `Terms.updatedAt` is that proof. If a terms row has not been touched since the invoice was
-- finalized, its CURRENT figures are necessarily the figures the invoice was issued under. If it has
-- been touched, they may not be — and no amount of joining recovers what the old values were.
--
-- Conservative on purpose: `updatedAt` bumps on ANY field change (a rename, an `active` toggle,
-- `netDays`), so this declines some rows whose discount never actually moved. Declining costs an
-- early-pay discount that an operator can grant by hand; guessing costs money out the door on paper
-- the shop cannot take back. Rows left null read as "no early-pay discount", which is also what
-- every one of these invoices did before #79 existed for any customer since reassigned.
--
-- NOTE for whoever reads this later: an invoice whose terms row has been edited since it was
-- finalized now carries NO early-pay discount. If a customer claims one, unlock and re-finalize the
-- invoice (which re-stamps from the terms in force) or handle it as a manual DISCOUNT application.
UPDATE "Invoice" i
SET "termsDiscountPercent" = NULL,
    "termsDiscountDays"    = NULL
WHERE i."kind" = 'INVOICE'
  AND i."finalizedAt" IS NOT NULL
  AND i."termsDiscountPercent" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "Terms" t
    WHERE t."deletedAt" IS NULL
      AND t."name" = i."termsName"
      AND t."updatedAt" <= i."finalizedAt"   -- untouched since issue ⇒ today's figures ARE the issued ones
  );
