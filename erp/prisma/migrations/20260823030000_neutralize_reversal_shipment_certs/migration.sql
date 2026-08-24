-- #183 (2026-08-23): void any SHIPMENT-scope certification hand-raised on a REVERSING shipment
-- before createCert began refusing it. A reversal's ShipperLines carry NEGATIVE quantities, so such
-- a cert prints a record of un-shipping. Voiding it removes it from BOTH print paths — printCert's
-- assertPrintable throws on a voided cert, and resolveShipmentCerts filters `deletedAt IS NULL` — so
-- no reversal certification can continue producing negative-quantity documents. New ones can no
-- longer be created (the createCert reversal guard). Data-only migration; no schema change.
UPDATE "Cert" AS c
SET "deletedAt" = now()
FROM "Shipper" AS s
WHERE c."shipperId" = s."id"
  AND c."scope" = 'SHIPMENT'
  AND c."deletedAt" IS NULL
  AND s."reversesShipperId" IS NOT NULL;
