// src/lib/documents.ts
import "server-only";
import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { splitText, createEmbedding } from "@/lib/rag";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

// 限制并发数，防止将智谱 API 打挂或内存溢出
const limit = pLimit(5);
const EMBEDDING_TIMEOUT_MS = 15000;

/**
 * 对已创建的文档做切块 + 向量化，并维护处理状态。
 *
 * 状态机：
 *   PROCESSING → READY   （全部成功）
 *   PROCESSING → PARTIAL （部分成功，部分失败）
 *   PROCESSING → FAILED  （所有块都失败）
 */
export async function indexDocument(input: {
  documentId: string;
  name: string;
  content: string;
}): Promise<{ status: "READY" | "PARTIAL" | "FAILED"; chunkCount: number }> {
  const chunks = splitText(input.content, CHUNK_SIZE, CHUNK_OVERLAP);

  // 处理空文件
  if (!chunks.length) {
    await prisma.document.update({
      where: { id: input.documentId },
      data: { status: "READY", error: null },
    });
    return { status: "READY", chunkCount: 0 };
  }

  let failed = 0;
  let firstErrorMsg: string | null = null;

  // 并发处理所有块
  const results = await Promise.allSettled(
    chunks.map((chunk, index) =>
      limit(async () => {
        // 用 Promise.race 实现超时控制（即使 createEmbedding 内部不支持 AbortSignal）
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new Error(`Chunk ${index} 超时 (${EMBEDDING_TIMEOUT_MS}ms)`),
              ),
            EMBEDDING_TIMEOUT_MS,
          );
        });

        try {
          console.log();
          // 将 createEmbedding 与超时机制竞速
          const embedding = await Promise.race([
            createEmbedding(chunk),
            timeoutPromise,
          ]);

          //    await prisma.documentChunk.create({
          //   data: { documentId: input.documentId, content: chunk, embedding },
          // });
          const vectorStr = `[${embedding.join(",")}]`;
          await prisma.$executeRaw`
              INSERT INTO "DocumentChunk" ("id", "documentId", "content", "embedding", "createdAt")
              VALUES (gen_random_uuid(), ${input.documentId}, ${chunk}, ${vectorStr}::vector, NOW())
            `;
        } catch (err) {
          console.error(
            `[documents] chunk ${index} embedding failed for ${input.name}:`,
            err,
          );
          throw err; // 抛出异常交给 allSettled 捕获
        }
      }),
    ),
  );

  // 统计失败情况
  results.forEach((result) => {
    if (result.status === "rejected") {
      failed += 1;
      if (!firstErrorMsg) {
        firstErrorMsg = result.reason?.message || "未知的向量化错误";
      }
    }
  });

  // 计算最终状态
  let status: "READY" | "PARTIAL" | "FAILED" = "READY";
  if (failed === chunks.length) {
    status = "FAILED";
  } else if (failed > 0) {
    status = "PARTIAL";
  }

  // 更新数据库状态并记录错误
  await prisma.document.update({
    where: { id: input.documentId },
    data: {
      status,
      failedChunks: failed,
      error: firstErrorMsg,
    },
  });

  return { status, chunkCount: chunks.length - failed };
}

export async function getDocumentsByIds(ids: string[], userId: string) {
  if (!ids?.length) return [];
  return prisma.document.findMany({
    where: { id: { in: ids }, userId },
  });
}
