-- DropIndex
DROP INDEX "DocumentChunk_documentId_idx";

-- CreateIndex
CREATE INDEX "DocumentChunk_documentId_createdAt_idx" ON "DocumentChunk"("documentId", "createdAt");

-- AlterTable
ALTER TABLE "Document" ALTER COLUMN "updatedAt" DROP DEFAULT;
