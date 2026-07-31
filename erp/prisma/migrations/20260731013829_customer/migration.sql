-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "termsId" TEXT,
    "creditLimit" DECIMAL(12,2),
    "creditHold" BOOLEAN NOT NULL DEFAULT false,
    "cod" BOOLEAN NOT NULL DEFAULT false,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "defaultPo" TEXT NOT NULL DEFAULT '',
    "orderNotes" TEXT NOT NULL DEFAULT '',
    "shippingNotes" TEXT NOT NULL DEFAULT '',
    "invoiceNotes" TEXT NOT NULL DEFAULT '',
    "surchargeOptOut" BOOLEAN NOT NULL DEFAULT false,
    "financeChargeRate" DECIMAL(6,4),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Customer_code_key" ON "Customer"("code");

-- CreateIndex
CREATE INDEX "Customer_name_idx" ON "Customer"("name");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_termsId_fkey" FOREIGN KEY ("termsId") REFERENCES "Terms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
