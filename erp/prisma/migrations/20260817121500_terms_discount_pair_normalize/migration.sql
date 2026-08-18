-- Repair any half-populated early-pay discount pair BEFORE the constraint that follows validates it.
--
-- WHY THE TIMESTAMP IS OUT OF AUTHORING ORDER: this was written AFTER
-- `20260817121500`'s successor `..._terms_discount_pair_check` (review round 1 of PR #135) and
-- deliberately slotted ahead of it. `ADD CONSTRAINT` validates existing rows immediately, so on an
-- UPGRADED install carrying a half-pair — precisely the state the TOCTOU race that constraint exists
-- to close could have produced — `migrate deploy` would fail, and production applies migrations
-- automatically on container start. Checking the local `erp`/`erp_test` databases said nothing about
-- anyone else's.
--
-- Nulling BOTH halves is behaviour-preserving, not a data decision: `discountFor`
-- (`applications.ts`) already returns 0 unless BOTH are set, so a half-pair has always meant "no
-- early-pay discount". This writes down what the row already meant. Idempotent — a second run
-- matches nothing.
UPDATE "Terms"
SET "discountPercent" = NULL,
    "discountDays"    = NULL
WHERE ("discountPercent" IS NULL) <> ("discountDays" IS NULL);
