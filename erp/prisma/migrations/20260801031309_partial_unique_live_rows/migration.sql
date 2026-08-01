-- DropIndex
DROP INDEX "Carrier_name_key";

-- DropIndex
DROP INDEX "CommentSnippet_name_key";

-- DropIndex
DROP INDEX "ContainerType_name_key";

-- DropIndex
DROP INDEX "Customer_code_key";

-- DropIndex
DROP INDEX "GlAccount_name_key";

-- DropIndex
DROP INDEX "InspectionCode_name_key";

-- DropIndex
DROP INDEX "InspectionScale_name_key";

-- DropIndex
DROP INDEX "Material_name_key";

-- DropIndex
DROP INDEX "PaymentType_name_key";

-- DropIndex
DROP INDEX "ProcessStepCode_code_key";

-- DropIndex
DROP INDEX "Role_name_key";

-- DropIndex
DROP INDEX "Specification_name_key";

-- DropIndex
DROP INDEX "Terms_name_key";

-- CreateIndex
CREATE UNIQUE INDEX "Carrier_name_key" ON "Carrier"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "CommentSnippet_name_key" ON "CommentSnippet"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ContainerType_name_key" ON "ContainerType"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "GlAccount_name_key" ON "GlAccount"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionCode_name_key" ON "InspectionCode"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "InspectionScale_name_key" ON "InspectionScale"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Material_name_key" ON "Material"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentType_name_key" ON "PaymentType"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessStepCode_code_key" ON "ProcessStepCode"("code") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Specification_name_key" ON "Specification"("name") WHERE ("deletedAt" IS NULL);

-- CreateIndex
CREATE UNIQUE INDEX "Terms_name_key" ON "Terms"("name") WHERE ("deletedAt" IS NULL);
