-- Clear negative `Customer.financeChargeRate` overrides left by the validation gap #86 closed.
--
-- The service now refuses a negative rate, but that only stops FUTURE writes: a row an upgraded
-- install already stored keeps overriding the plant rate, keeps making `financeCharge` return a
-- negative, and keeps having that collapsed to null by the `> 0` gate — so the silent
-- not-being-charged #86 is about persists until somebody happens to edit that one field.
--
-- Null means "inherit the plant rate", which is the default state and the only meaning a negative
-- value could ever have had (no code path can produce or honour one). In practice this changes
-- nothing today: finance charges are opt-in per statement run, and `BillingConfig.financeChargeRate`
-- is itself null unless configured — so an affected customer starts being charged only if the shop
-- has set a plant rate AND opts in, which is exactly the behaviour a customer with no override gets.
UPDATE "Customer"
SET "financeChargeRate" = NULL
WHERE "financeChargeRate" < 0;
