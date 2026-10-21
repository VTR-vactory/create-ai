-- 部署就绪迁移：补齐历史迁移里缺失的结构，使「全新数据库」执行 migrate deploy 后
-- 与 prisma/schema.prisma 完全一致。
--
-- 幂等设计：
-- - 本地库已经手动改过（vector 扩展、titleAuto、failedChunks、PARTIAL 都存在），
--   本迁移在本地等价于 no-op，不会重写/清空已有 embedding。
-- - 全新库则会把 init 迁移里的 JSONB 列转成 vector(1024) 并允许 NULL。

-- pgvector 扩展：Supabase 上也可在 Dashboard → Database → Extensions 里预先启用
CREATE EXTENSION IF NOT EXISTS vector;

-- 补枚举值（PG 12+ 允许在事务内 ADD VALUE）
ALTER TYPE "DocumentStatus" ADD VALUE IF NOT EXISTS 'PARTIAL';

-- 补字段
ALTER TABLE "Chat" ADD COLUMN IF NOT EXISTS "titleAuto" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "failedChunks" INTEGER NOT NULL DEFAULT 0;

-- embedding：仅当还是 jsonb 时才转换（本地已是 vector，跳过，避免清空向量）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'DocumentChunk'
      AND column_name = 'embedding'
      AND udt_name = 'jsonb'
  ) THEN
    ALTER TABLE "DocumentChunk" ALTER COLUMN "embedding" DROP NOT NULL;
    -- 全新库没有数据，用 USING NULL 安全丢弃不存在的旧向量
    ALTER TABLE "DocumentChunk" ALTER COLUMN "embedding" TYPE vector(1024) USING NULL;
  END IF;
END $$;
