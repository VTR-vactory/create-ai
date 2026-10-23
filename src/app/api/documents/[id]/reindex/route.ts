import { auth } from "@/auth";
import { apiError } from "@/lib/http";
import { prisma } from "@/lib/prisma";
import { canReindex, REINDEX_STALE_MS } from "@/lib/document-status";
import { indexDocument } from "@/lib/documents";
import { extractImageText, OcrError } from "@/lib/ocr";
import { uploadRateLimit } from "@/lib/ratelimit";

export const maxDuration = 60;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/documents/[id]/reindex
 *
 * 重建单个文档的索引：
 * - FAILED / PARTIAL：直接重试
 * - PROCESSING 超过 10 分钟：接管卡死任务
 * - 先原子抢占，再删除旧 chunk，避免并发重复写入
 */
export async function POST(_: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return apiError("UNAUTHORIZED", "请先登录", 401);
  }

  const { id } = await context.params;

  try {
    const document = await prisma.document.findFirst({
      where: { id, userId: session.user.id },
      select: {
        id: true,
        name: true,
        content: true,
        kind: true,
        status: true,
        updatedAt: true,
      },
    });

    if (!document) {
      return apiError("NOT_FOUND", "文件不存在。", 404);
    }

    if (!canReindex(document.status, document.updatedAt)) {
      return apiError(
        "NOT_REINDEXABLE",
        "文件正在处理中或当前状态不允许重试。",
        409,
      );
    }

    const limit = await uploadRateLimit.limit(session.user.id);
    if (!limit.success) {
      return apiError("RATE_LIMITED", "操作过于频繁，请稍后再试。", 429);
    }

    const staleBefore = new Date(Date.now() - REINDEX_STALE_MS);
    const claimed = await prisma.document.updateMany({
      where: {
        id: document.id,
        userId: session.user.id,
        OR: [
          { status: { in: ["FAILED", "PARTIAL"] } },
          { status: "PROCESSING", updatedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: "PROCESSING",
        error: null,
        failedChunks: 0,
        ...(document.kind === "IMAGE"
          ? { ocrText: null, ocrProvider: null }
          : {}),
      },
    });

    if (claimed.count === 0) {
      return apiError(
        "NOT_REINDEXABLE",
        "文件正在处理中，请稍后再试。",
        409,
      );
    }

    let indexed: {
      status: "READY" | "PARTIAL" | "FAILED";
      chunkCount: number;
    };

    try {
      await prisma.documentChunk.deleteMany({
        where: { documentId: document.id },
      });

      if (document.kind === "IMAGE") {
        const ocr = await extractImageText(document.content, {
          timeoutMs: 12_000,
          retryDelayMs: 1_500,
        });

        await prisma.document.update({
          where: { id: document.id },
          data: { ocrText: ocr.text, ocrProvider: ocr.provider },
        });

        indexed = await indexDocument({
          documentId: document.id,
          name: document.name,
          content: ocr.text,
        });
      } else {
        indexed = await indexDocument({
          documentId: document.id,
          name: document.name,
          content: document.content,
        });
      }
    } catch (error) {
      const message =
        error instanceof OcrError ? error.message : "重建索引失败";

      console.error("[documents] reindex failed", {
        documentId: document.id,
        code: error instanceof OcrError ? error.code : "UNKNOWN",
      });

      await prisma.document.update({
        where: { id: document.id },
        data: {
          status: "FAILED",
          error: message,
          failedChunks: 0,
        },
      });

      return Response.json({
        document: {
          id: document.id,
          name: document.name,
          status: "FAILED",
          chunkCount: 0,
          error: message,
        },
      });
    }

    return Response.json({
      document: {
        id: document.id,
        name: document.name,
        status: indexed.status,
        chunkCount: indexed.chunkCount,
      },
    });
  } catch (error) {
    console.error("document reindex failed", error);
    return apiError(
      "INTERNAL_ERROR",
      "重建索引失败，请稍后重试。",
      500,
    );
  }
}
