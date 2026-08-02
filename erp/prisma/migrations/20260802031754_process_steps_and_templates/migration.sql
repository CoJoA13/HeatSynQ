-- CreateTable
CREATE TABLE "PartProcessRevision" (
    "id" TEXT NOT NULL,
    "partId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PartProcessRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartProcessStep" (
    "id" TEXT NOT NULL,
    "revisionId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "codeId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PartProcessStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PartProcessStepValue" (
    "id" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "fieldDefId" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "PartProcessStepValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessTemplateStep" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "codeId" TEXT NOT NULL,
    "boilerplate" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ProcessTemplateStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PartProcessRevision_partId_idx" ON "PartProcessRevision"("partId");

-- CreateIndex
CREATE UNIQUE INDEX "PartProcessRevision_partId_revisionNumber_key" ON "PartProcessRevision"("partId", "revisionNumber");

-- CreateIndex
CREATE INDEX "PartProcessStep_revisionId_idx" ON "PartProcessStep"("revisionId");

-- CreateIndex
CREATE INDEX "PartProcessStep_codeId_idx" ON "PartProcessStep"("codeId");

-- CreateIndex
CREATE UNIQUE INDEX "PartProcessStep_revisionId_position_key" ON "PartProcessStep"("revisionId", "position");

-- CreateIndex
CREATE INDEX "PartProcessStepValue_fieldDefId_idx" ON "PartProcessStepValue"("fieldDefId");

-- CreateIndex
CREATE UNIQUE INDEX "PartProcessStepValue_stepId_fieldDefId_key" ON "PartProcessStepValue"("stepId", "fieldDefId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessTemplate_name_key" ON "ProcessTemplate"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE INDEX "ProcessTemplateStep_templateId_idx" ON "ProcessTemplateStep"("templateId");

-- CreateIndex
CREATE INDEX "ProcessTemplateStep_codeId_idx" ON "ProcessTemplateStep"("codeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessTemplateStep_templateId_position_key" ON "ProcessTemplateStep"("templateId", "position");

-- AddForeignKey
ALTER TABLE "PartProcessRevision" ADD CONSTRAINT "PartProcessRevision_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartProcessStep" ADD CONSTRAINT "PartProcessStep_revisionId_fkey" FOREIGN KEY ("revisionId") REFERENCES "PartProcessRevision"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartProcessStep" ADD CONSTRAINT "PartProcessStep_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ProcessStepCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartProcessStepValue" ADD CONSTRAINT "PartProcessStepValue_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "PartProcessStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PartProcessStepValue" ADD CONSTRAINT "PartProcessStepValue_fieldDefId_fkey" FOREIGN KEY ("fieldDefId") REFERENCES "ProcessStepFieldDef"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessTemplateStep" ADD CONSTRAINT "ProcessTemplateStep_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "ProcessTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessTemplateStep" ADD CONSTRAINT "ProcessTemplateStep_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ProcessStepCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
