-- AlterTable: Chat 上新增原子计数器，记录已分配到的最大 position
ALTER TABLE "Chat" ADD COLUMN     "messageSeq" INTEGER NOT NULL DEFAULT 0;

-- Backfill: 按每个会话已有的最大 position + 1 回填计数器
UPDATE "Chat" c
SET "messageSeq" = COALESCE(
  (SELECT MAX(m."position") + 1 FROM "Message" m WHERE m."chatId" = c.id),
  0
);

-- DropIndex: 旧的普通索引（将被唯一约束取代）
DROP INDEX "Message_chatId_position_idx";

-- CreateIndex: 唯一约束，作为 position 竞态的最后防线
CREATE UNIQUE INDEX "Message_chatId_position_key" ON "Message"("chatId", "position");
