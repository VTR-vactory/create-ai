// src/lib/documents.ts
import "server-only";
import { prisma } from "@/lib/prisma";
import { splitText, createEmbedding } from "@/lib/rag";

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 120;

/**
 * 对已创建的文档做切块 + 向量化，并维护处理状态。
 *
 * 状态机：
 *   PROCESSING → READY   （至少有一个块成功）
 *   PROCESSING → FAILED  （所有块都失败）
 * 图片等非文本内容不走向量化，创建时直接标记 READY，不调用本函数。
 */
export async function indexDocument(input: {
  documentId: string;
  name: string;
  content: string;
}): Promise<{ status: "READY" | "FAILED"; chunkCount: number }> {
  const chunks = splitText(input.content, CHUNK_SIZE, CHUNK_OVERLAP);

  if (!chunks.length) {
    await prisma.document.update({
      where: { id: input.documentId },
      data: { status: "READY", error: null },
    });
    return { status: "READY", chunkCount: 0 };
  }

  let failed = 0;
  for (const chunk of chunks) {
    try {
      const embedding = await createEmbedding(chunk);
      await prisma.documentChunk.create({
        data: { documentId: input.documentId, content: chunk, embedding },
      });
    } catch (err) {
      // 单块失败不阻断整体，继续处理下一块
      failed += 1;
      console.error(`[documents] chunk embedding failed for ${input.name}:`, err);
    }
  }

  const status: "READY" | "FAILED" =
    failed === chunks.length ? "FAILED" : "READY";

  await prisma.document.update({
    where: { id: input.documentId },
    data: {
      status,
      error: status === "FAILED" ? "Embedding failed for all chunks" : null,
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
