-- Terms' early-pay discount is all-or-nothing: `discountPercent` and `discountDays` are both set or
-- both null. The service already validated this (`requireDiscountPair` on the payload,
-- `assertDiscountPairAfterUpdate` on the merged row), but that read runs BEFORE the row-locking
-- update at the default isolation level, so two concurrent PATCHes could each validate against the
-- same stale stored row: one clears both fields, the other changes only `discountDays` against the
-- old percent, and if the clear commits first the survivor is `discountPercent = NULL,
-- discountDays = 20` — exactly the state the validation exists to prevent (#82).
--
-- A CHECK closes it at the only layer both transactions share. Prisma's schema language has no
-- check constraints, so this is hand-written and re-stated whole if it ever changes — the
-- `Application_source_check` / `StoredDocument_kind_owner_check` precedent. `(a IS NULL) = (b IS
-- NULL)` is a plain boolean and never NULL, so the constraint is deterministic rather than
-- accidentally permissive on nulls.
--
-- Verified before writing: zero violating rows in `erp` and `erp_test`.
ALTER TABLE "Terms" ADD CONSTRAINT "Terms_discount_pair_check" CHECK (
  ("discountPercent" IS NULL) = ("discountDays" IS NULL)
);
