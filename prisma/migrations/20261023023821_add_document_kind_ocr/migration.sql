-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('TEXT', 'IMAGE');

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "kind" "DocumentKind" NOT NULL DEFAULT 'TEXT',
ADD COLUMN     "ocrProvider" TEXT,
ADD COLUMN     "ocrText" TEXT;

-- 回填：已有图片标记为 IMAGE（不自动补 OCR）
UPDATE "Document" SET "kind" = 'IMAGE' WHERE "mimeType" LIKE 'image/%';
