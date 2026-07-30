-- CreateEnum
CREATE TYPE "StepFieldType" AS ENUM ('NUMBER', 'TEXT', 'DATE', 'CHECKBOX');

-- CreateTable
CREATE TABLE "ProcessStepCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "glAccountId" TEXT,
    "equipmentTag" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessStepCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessStepFieldDef" (
    "id" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "type" "StepFieldType" NOT NULL,
    "unit" TEXT,
    "sort" INTEGER NOT NULL,

    CONSTRAINT "ProcessStepFieldDef_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessStepCode_code_key" ON "ProcessStepCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessStepFieldDef_codeId_label_key" ON "ProcessStepFieldDef"("codeId", "label");

-- AddForeignKey
ALTER TABLE "ProcessStepCode" ADD CONSTRAINT "ProcessStepCode_glAccountId_fkey" FOREIGN KEY ("glAccountId") REFERENCES "GlAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessStepFieldDef" ADD CONSTRAINT "ProcessStepFieldDef_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ProcessStepCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
