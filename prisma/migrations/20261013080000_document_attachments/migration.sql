-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "chatId" TEXT,
ADD COLUMN     "contentHash" TEXT,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "messageId" TEXT,
ADD COLUMN     "status" "DocumentStatus" NOT NULL DEFAULT 'PROCESSING',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: documents created before attachment/status tracking are already usable
UPDATE "Document" SET "status" = 'READY';

-- CreateIndex
CREATE INDEX "Document_chatId_idx" ON "Document"("chatId");

-- CreateIndex
CREATE INDEX "Document_messageId_idx" ON "Document"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "Document_userId_contentHash_key" ON "Document"("userId", "contentHash");

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
