-- Fix-wave R4 finding 5: the order entry form's idempotency nonce.
--
-- Two tabs resuming the SAME autosaved draft submit the SAME intent. The order save runs
-- Serializable, so a genuine collision aborts the loser with 40001 -> the retryable 409 the entry
-- page already retries automatically — and that retry, being a fresh request, used to create a
-- SECOND order carrying the next number. This column is what lets the server recognize the retry
-- as the same request and hand back the order it already created.
--
-- Additive and nullable: every existing row gets NULL, and NULLs never collide in a Postgres
-- unique index, so both the historic rows and any caller that sends no nonce are unaffected.
-- Plain unique rather than live-rows-only, deliberately: a voided order keeps its request id
-- forever (the same no-reuse rule Order.orderNumber follows, spec §4).
-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "clientRequestId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_clientRequestId_key" ON "Order"("clientRequestId");
