-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "clientId" TEXT,
ADD COLUMN     "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill deterministic ordering for existing rows:
-- USER before ASSISTANT within the same transaction timestamp.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "chatId"
      ORDER BY "createdAt" ASC, ("role" = 'ASSISTANT') ASC
    ) - 1 AS rn
  FROM "Message"
)
UPDATE "Message" AS m
SET "position" = ranked.rn
FROM ranked
WHERE m."id" = ranked."id";

-- DropIndex
DROP INDEX "Message_chatId_createdAt_idx";

-- CreateIndex
CREATE INDEX "Message_chatId_position_idx" ON "Message"("chatId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Message_chatId_clientId_key" ON "Message"("chatId", "clientId");
