-- CreateIndex
CREATE INDEX "Invoice_finalizedAt_idx" ON "Invoice"("finalizedAt");

-- CreateIndex
CREATE INDEX "Payment_receivedDate_idx" ON "Payment"("receivedDate");
