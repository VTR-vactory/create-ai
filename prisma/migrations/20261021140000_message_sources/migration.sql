-- 记录助手回答的联网来源，供前端渲染可点击引用
ALTER TABLE "Message" ADD COLUMN "sources" JSONB;
