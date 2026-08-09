-- AlterTable
ALTER TABLE "BillingConfig" ADD COLUMN     "arGlAccountId" TEXT,
ADD COLUMN     "discountGlAccountId" TEXT,
ADD COLUMN     "writeOffGlAccountId" TEXT;

-- CreateTable
CREATE TABLE "ClosePeriod" (
    "id" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CLOSED',
    "beginningAr" DECIMAL(12,2) NOT NULL,
    "invoicedTotal" DECIMAL(12,2) NOT NULL,
    "creditTotal" DECIMAL(12,2) NOT NULL,
    "paymentTotal" DECIMAL(12,2) NOT NULL,
    "discountTotal" DECIMAL(12,2) NOT NULL,
    "writeOffTotal" DECIMAL(12,2) NOT NULL,
    "endingAr" DECIMAL(12,2) NOT NULL,
    "agingEndingAr" DECIMAL(12,2) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT,
    "reopenedAt" TIMESTAMP(3),
    "reopenReason" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClosePeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlExportBatch" (
    "id" TEXT NOT NULL,
    "exportNumber" INTEGER NOT NULL,
    "closePeriodId" TEXT NOT NULL,
    "periodEnd" DATE NOT NULL,
    "emittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "emittedById" TEXT,
    "fileName" TEXT NOT NULL,
    "fileContentType" TEXT NOT NULL DEFAULT 'text/csv',
    "file" BYTEA NOT NULL,
    "registerContentType" TEXT NOT NULL DEFAULT 'application/pdf',
    "register" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GlExportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlPosting" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "glDate" DATE NOT NULL,
    "glAccountId" TEXT,
    "glAccountName" TEXT NOT NULL DEFAULT '',
    "debit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "side" TEXT NOT NULL,
    "memo" TEXT NOT NULL DEFAULT '',
    "isReversal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlPosting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClosePeriod_year_month_key" ON "ClosePeriod"("year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "GlExportBatch_exportNumber_key" ON "GlExportBatch"("exportNumber");

-- CreateIndex
CREATE INDEX "GlExportBatch_closePeriodId_idx" ON "GlExportBatch"("closePeriodId");

-- CreateIndex
CREATE INDEX "GlPosting_sourceType_sourceId_idx" ON "GlPosting"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "GlPosting_batchId_idx" ON "GlPosting"("batchId");

-- CreateIndex
CREATE INDEX "GlPosting_glDate_idx" ON "GlPosting"("glDate");

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_arGlAccountId_fkey" FOREIGN KEY ("arGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_discountGlAccountId_fkey" FOREIGN KEY ("discountGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingConfig" ADD CONSTRAINT "BillingConfig_writeOffGlAccountId_fkey" FOREIGN KEY ("writeOffGlAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClosePeriod" ADD CONSTRAINT "ClosePeriod_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlExportBatch" ADD CONSTRAINT "GlExportBatch_closePeriodId_fkey" FOREIGN KEY ("closePeriodId") REFERENCES "ClosePeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlExportBatch" ADD CONSTRAINT "GlExportBatch_emittedById_fkey" FOREIGN KEY ("emittedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlPosting" ADD CONSTRAINT "GlPosting_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "GlExportBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GlPosting" ADD CONSTRAINT "GlPosting_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
