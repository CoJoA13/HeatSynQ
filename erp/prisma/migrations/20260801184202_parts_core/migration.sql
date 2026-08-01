-- CreateEnum
CREATE TYPE "PricePer" AS ENUM ('EACH', 'LB', 'PER_100', 'PER_1000', 'LOT');

-- CreateEnum
CREATE TYPE "PartFieldType" AS ENUM ('TEXT', 'NUMBER', 'DATE', 'CHECKBOX');

-- CreateTable
CREATE TABLE "Part" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "partNumber" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "materialId" TEXT,
    "eachWeight" DECIMAL(10,4) NOT NULL,
    "loadQty" INTEGER,
    "loadWeight" DECIMAL(10,2),
    "serializationRequired" BOOLEAN NOT NULL DEFAULT false,
    "setupCharge" DECIMAL(12,2),
    "unitPrice" DECIMAL(12,4),
    "minimumCharge" DECIMAL(12,2),
    "pricePer" "PricePer" NOT NULL DEFAULT 'EACH',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartSpecification" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "specificationId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartSpecification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartInspection" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "inspectionCodeId" TEXT NOT NULL,
    "scaleId" TEXT,
    "min" DECIMAL(10,4),
    "max" DECIMAL(10,4),
    "location" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartInspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartPriceBreak" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "threshold" DECIMAL(12,2) NOT NULL,
    "price" DECIMAL(12,4) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartPriceBreak_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartFieldDef" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "PartFieldType" NOT NULL,
    "sort" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartFieldDef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartFieldValue" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "value" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Part_partNumber_idx" ON "Part"("partNumber");

-- CreateIndex
CREATE INDEX "Part_customerId_idx" ON "Part"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Part_customerId_partNumber_key" ON "Part"("customerId", "partNumber") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "PartSpecification_specificationId_idx" ON "PartSpecification"("specificationId");

-- CreateIndex
CREATE UNIQUE INDEX "PartSpecification_partId_specificationId_key" ON "PartSpecification"("partId", "specificationId") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "PartInspection_partId_idx" ON "PartInspection"("partId");

-- CreateIndex
CREATE INDEX "PartInspection_inspectionCodeId_idx" ON "PartInspection"("inspectionCodeId");

-- CreateIndex
CREATE INDEX "PartInspection_scaleId_idx" ON "PartInspection"("scaleId");

-- CreateIndex
CREATE UNIQUE INDEX "PartPriceBreak_partId_threshold_key" ON "PartPriceBreak"("partId", "threshold") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "PartFieldDef_name_key" ON "PartFieldDef"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "PartFieldValue_fieldId_idx" ON "PartFieldValue"("fieldId");

-- CreateIndex
CREATE UNIQUE INDEX "PartFieldValue_partId_fieldId_key" ON "PartFieldValue"("partId", "fieldId");

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Part" ADD CONSTRAINT "Part_materialId_fkey" FOREIGN KEY ("materialId") REFERENCES "Material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartSpecification" ADD CONSTRAINT "PartSpecification_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartSpecification" ADD CONSTRAINT "PartSpecification_specificationId_fkey" FOREIGN KEY ("specificationId") REFERENCES "Specification"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartInspection" ADD CONSTRAINT "PartInspection_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartInspection" ADD CONSTRAINT "PartInspection_inspectionCodeId_fkey" FOREIGN KEY ("inspectionCodeId") REFERENCES "InspectionCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartInspection" ADD CONSTRAINT "PartInspection_scaleId_fkey" FOREIGN KEY ("scaleId") REFERENCES "InspectionScale"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartPriceBreak" ADD CONSTRAINT "PartPriceBreak_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartFieldValue" ADD CONSTRAINT "PartFieldValue_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartFieldValue" ADD CONSTRAINT "PartFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "PartFieldDef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

