-- Phase 7 Task 3, part 1 of 2 — the template-designer data layer (design spec §4.1–§4.2, §9).
-- Structures only; part 2 (<ts>_seed_standard_templates) seeds the eight "Standard" rows.
--
-- No enum ADD VALUE anywhere (TemplateDocType is a brand-new type, and DocumentKind is
-- deliberately untouched — Phase 7 adds no ninth document), so the two-directory ADD-VALUE rule
-- stays dormant and one directory is correct.
--
-- StoredDocument.templateVersionId is render metadata present on every kind, NOT a seventh
-- owner column: the hand-written StoredDocument_kind_owner_check (last re-stated in
-- 20260810120100_quoting) is deliberately untouched — its arms govern which owner FK identifies
-- the document, which this column never does.
--
-- DocumentTemplateVersion has NO deletedAt and no delete path at all (spec §4.1): published
-- rows are immutable, discard is a status flip, and the rows are append-only history — so its
-- [templateId, versionNumber] unique is a plain (not live-rows-only) index, deliberately. Its
-- templateId FK cascades: a version is an owned child of its template (the
-- SurchargeStepCode.surchargeId shape; templates themselves only ever soft-delete).
--
-- The DocumentTemplate [docType, name] and CustomerTemplateAssignment [customerId, docType]
-- uniques are the usual live-rows-only partial indexes.

-- CreateEnum
CREATE TYPE "TemplateDocType" AS ENUM ('TRAVELER', 'SHIPPER', 'MOS_SHIPPER', 'BOL', 'CERT', 'INVOICE', 'STATEMENT', 'QUOTE');

-- AlterTable
ALTER TABLE "Part" ADD COLUMN     "processName" TEXT NOT NULL DEFAULT '';

-- AlterTable
ALTER TABLE "StoredDocument" ADD COLUMN     "templateVersionId" TEXT;

-- CreateTable
CREATE TABLE "DocumentTemplate" (
    "id" TEXT NOT NULL,
    "docType" "TemplateDocType" NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "publishedVersionId" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentTemplateVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "config" JSONB NOT NULL,
    "logoImage" BYTEA,
    "logoMimeType" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerTemplateAssignment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "docType" "TemplateDocType" NOT NULL,
    "templateId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerTemplateAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplate_docType_name_key" ON "DocumentTemplate"("docType", "name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTemplateVersion_templateId_versionNumber_key" ON "DocumentTemplateVersion"("templateId", "versionNumber");

-- CreateIndex
CREATE INDEX "CustomerTemplateAssignment_customerId_idx" ON "CustomerTemplateAssignment"("customerId");

-- CreateIndex
CREATE INDEX "CustomerTemplateAssignment_templateId_idx" ON "CustomerTemplateAssignment"("templateId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerTemplateAssignment_customerId_docType_key" ON "CustomerTemplateAssignment"("customerId", "docType") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "StoredDocument_templateVersionId_idx" ON "StoredDocument"("templateVersionId");

-- AddForeignKey
ALTER TABLE "StoredDocument" ADD CONSTRAINT "StoredDocument_templateVersionId_fkey" FOREIGN KEY ("templateVersionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplate" ADD CONSTRAINT "DocumentTemplate_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "DocumentTemplateVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplateVersion" ADD CONSTRAINT "DocumentTemplateVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentTemplateVersion" ADD CONSTRAINT "DocumentTemplateVersion_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTemplateAssignment" ADD CONSTRAINT "CustomerTemplateAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerTemplateAssignment" ADD CONSTRAINT "CustomerTemplateAssignment_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "DocumentTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
