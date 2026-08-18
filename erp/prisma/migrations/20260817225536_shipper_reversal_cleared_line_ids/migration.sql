-- #65: the ORIGINAL shipment's ShipperLine ids whose `lineComplete` this reversal cleared at
-- creation (reverseShipperInTx step 6b's completeLineIds), written once when the reversal row is
-- created. voidShipper reads it when the reversal is voided (the blessed undo) to restore those
-- flags on the original. Existing reversals keep the [] default and restore nothing — dev/practice
-- data only, the shop is not live.

-- AlterTable
ALTER TABLE "Shipper" ADD COLUMN     "reversalClearedLineIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
