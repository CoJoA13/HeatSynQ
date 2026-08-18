-- #52 follow-up (Codex PR #141 review): `listDocumentsForOrder` matches whole-set paper with
-- `coveredOrderIds @> ARRAY[orderId]` (Prisma `has`), and no scalar index serves array
-- membership — on this permanent, append-only table that scan grows with every whole-set
-- ticket/BOL ever printed, the exact growth shape the orderId index was added for. GIN with the
-- default array_ops opclass.

-- CreateIndex
CREATE INDEX "StoredDocument_coveredOrderIds_idx" ON "StoredDocument" USING GIN ("coveredOrderIds");
