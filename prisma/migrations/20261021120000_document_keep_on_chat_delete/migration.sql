-- 删除会话/消息时保留用户上传的文件：
-- 把 Document 与 Chat / Message 的外键从 ON DELETE CASCADE 改为 ON DELETE SET NULL。
-- 这样删除对话只会解除关联，文件仍保留在「我的文件」中，DocumentChunk 也不会被级联删除。

-- DropForeignKey
ALTER TABLE "Document" DROP CONSTRAINT "Document_chatId_fkey";

-- DropForeignKey
ALTER TABLE "Document" DROP CONSTRAINT "Document_messageId_fkey";

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
