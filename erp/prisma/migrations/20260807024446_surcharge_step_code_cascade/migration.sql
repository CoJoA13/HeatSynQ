-- SurchargeStepCode is owned by its Surcharge (Task 6's replace-grid setSurchargeStepCodes
-- deletes/recreates the whole set on every save), the same "owned child, not a usage reference"
-- shape as ProcessStepFieldDef.codeId -> ProcessStepCode. Task 6 makes `surcharge` a
-- BlockerTarget; without this Cascade annotation, reference-links-sweep.test.ts's schemaLinks
-- walker would treat surchargeId as an unregistered usage FK, and registering it as a real
-- blocker would make a surcharge's own step-code list block its own deletion.
-- DropForeignKey
ALTER TABLE "SurchargeStepCode" DROP CONSTRAINT "SurchargeStepCode_surchargeId_fkey";

-- AddForeignKey
ALTER TABLE "SurchargeStepCode" ADD CONSTRAINT "SurchargeStepCode_surchargeId_fkey" FOREIGN KEY ("surchargeId") REFERENCES "Surcharge"("id") ON DELETE CASCADE ON UPDATE CASCADE;
