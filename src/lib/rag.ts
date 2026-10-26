/**
 * RAG（检索增强生成）工具库
 *
 * 核心功能：
 * 1. splitText       - 把长文档切成小块（chunk）
 * 2. createEmbedding - 把文本转成向量（调智谱 embedding API）
 * 3. findRelevantChunks - 用 pgvector 在数据库里做相似度检索
 *
 * RAG 流程：
 *   上传时：文档 → 切块 → 每块转向量 → 存数据库（vector 列）
 *   提问时：问题转向量 → 数据库按余弦距离排序 → 取 Top K → 塞进 prompt
 */

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// 余弦距离阈值：distance = 1 - similarity。
// 0.55 约等于相似度 0.45（与原实现保持一致）；过高会过滤掉正确答案，过低会引入噪声。
const MAX_COSINE_DISTANCE = 0.55;

// 1. 定义返回类型
type RawChunkResult = {
  content: string;
  documentId: string;
  documentName: string;
  kind: "TEXT" | "IMAGE";
};

// 智谱 API 地址，优先用环境变量，否则用默认值
const baseUrl =
  process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";

/**
 * 把长文本切成小块
 *
 * 为什么切块？
 * - 一份文档可能几千字，整个塞进 prompt 会超 token 限制
 * - 切成小块后，每次只取"最相关的几块"，节省 token
 * - 小块粒度更细，检索更精准
 *
 * @param text    要切的文本
 * @param size    每块的字符数（默认 800）
 * @param overlap 相邻块的重叠字符数（默认 120）
 * @returns       切好的字符串数组
 *
 * overlap 的作用（重要）：
 * 假设原文是 "ABCDEFGHIJ"，size=5，overlap=0：
 *   块1: "ABCDE"
 *   块2: "FGHIJ"
 * 如果用户问的内容正好横跨 E 和 F 之间，两块都不完整。
 *
 * 加上 overlap=2：
 *   块1: "ABCDE"
 *   块2: "DEFGH"   ← 和块1重叠 "DE"
 *   块3: "GHIJ"
 * 这样"跨界"内容至少在某一块里是完整的。
 */
export function splitText(text: string, size = 800, overlap = 120): string[] {
  // ① 统一换行符（Windows 的 \r\n → \n），并去掉首尾空白
  const normalized = text.replace(/\r\n/g, "\n").trim();

  // ② 存放切好的块
  const chunks: string[] = [];

  // ③ 当前切片的起始位置
  let start = 0;

  // ④ 循环切片，直到文本末尾
  while (start < normalized.length) {
    // 计算这一块的结束位置（不超出文本长度）
    const end = Math.min(start + size, normalized.length);

    // 切片并去掉首尾空白
    const chunk = normalized.slice(start, end).trim();

    // 只添加非空的块
    if (chunk) chunks.push(chunk);

    // 如果已经切到末尾，结束循环
    if (end === normalized.length) break;

    // 下一块从 end - overlap 开始（保留重叠部分）
    start = end - overlap;
  }

  return chunks;
}

/**
 * 把文本转成向量（Embedding）
 *
 * 什么是 Embedding？
 * - 把文字转成一串数字（如 1024 维数组）
 * - "意思相近"的文字，向量也相近
 * - 用于"语义搜索"——不靠字面匹配，靠意思匹配
 *
 * @param input 要转向量的文本
 * @returns     1024 维的向量数组
 */
export async function createEmbedding(input: string): Promise<number[]> {
  // ① 检查 API Key 是否配置
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error("ZHIPU_API_KEY is not configured");

  // ② 调智谱的 embedding API
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    // 请求体：模型名 + 输入文本
    body: JSON.stringify({ model: "embedding-3", input, dimensions: 1024 }),
  });

  // ③ 检查响应状态
  if (!response.ok) {
    throw new Error(`Embedding request failed: ${response.status}`);
  }

  // ④ 解析响应
  //    智谱返回结构：{ data: [{ embedding: [0.1, 0.2, ...] }] }
  const data = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = data.data?.[0]?.embedding;

  // ⑤ 检查向量是否存在
  if (!embedding) throw new Error("Embedding response has no vector");

  return embedding;
}

/**
 * 找出与问题最相关的文档片段（RAG 检索核心）
 *
 * 流程：
 *   ① 把问题转向量
 *   ② 交给数据库按余弦距离（<=>）排序
 *   ③ 取 Top K
 *
 * @param userId   当前用户 ID（数据隔离）
 * @param query    用户的问题
 * @param limit    取前几条（默认 5）
 * @returns        最相关的片段数组（含内容、文档名）
 */
export async function findRelevantChunks(
  userId: string,
  query: string,
  limit = 5,
) {
  // 没有问题文本就无法做语义检索（全局范围内不能瞎取）
  if (!query.trim()) return [];

  let queryVector: number[];
  try {
    queryVector = await createEmbedding(query);
  } catch (error) {
    // 契约要求：embedding 失败视为「本次无命中」，不能把请求打成 500。
    // 只记录长度与错误，不打印问题内容。
    console.warn("[rag] embedding failed; treating as no hit", {
      queryLength: query.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const vectorStr = `[${queryVector.join(",")}]`;

  return await prisma.$queryRaw<RawChunkResult[]>`
    SELECT dc.content,
           d.id AS "documentId",
           d.name AS "documentName",
           d.kind
    FROM "DocumentChunk" dc
    JOIN "Document" d ON dc."documentId" = d.id
    WHERE d."userId" = ${userId}
      AND dc.embedding <=> ${vectorStr}::vector <= ${MAX_COSINE_DISTANCE}
    ORDER BY dc.embedding <=> ${vectorStr}::vector
    LIMIT ${limit};
  `;
}

/**
 * 按创建顺序取指定文档的前 N 块。
 * 仅用于附件范围，仍带 userId 校验。
 */
async function findFirstChunksOfDocuments(
  userId: string,
  documentIds: string[],
  limit: number,
) {
  const chunks = await prisma.documentChunk.findMany({
    where: { documentId: { in: documentIds }, document: { userId } },
    select: {
      content: true,
      document: { select: { id: true, name: true, kind: true } },
    },
    orderBy: [{ documentId: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  return chunks.map((chunk) => ({
    content: chunk.content,
    documentId: chunk.document.id,
    documentName: chunk.document.name,
    kind: chunk.document.kind,
  }));
}

/**
 * 只在指定的若干文档（会话附件）范围内检索。
 *
 * 与全量检索的区别：
 * - 范围锁定在 documentIds（且仍校验 userId，防止越权）
 * - 纯附件提问（没有问题文本）时不做语义检索，直接取附件的前几块
 * - 有文字但语义检索为空时，也回退到附件前几块：
 *   「图片上内容是什么」这类泛化问题与 OCR 文本距离可能超过阈值，
 *   但用户已经明确挂载了附件，应让模型读到附件内容
 */
export async function findRelevantChunksForDocuments(
  userId: string,
  query: string,
  documentIds: string[],
  limit = 5,
) {
  if (!documentIds.length) return [];

  // 纯附件（无文字）：按创建顺序取前 limit 块，无需 embedding
  if (!query.trim()) {
    return findFirstChunksOfDocuments(userId, documentIds, limit);
  }

  let queryVector: number[];
  try {
    queryVector = await createEmbedding(query);
  } catch (error) {
    console.warn("[rag] embedding failed; treating as no hit", {
      queryLength: query.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  const vectorStr = `[${queryVector.join(",")}]`;

  const rows = await prisma.$queryRaw<RawChunkResult[]>`
    SELECT dc.content,
           d.id AS "documentId",
           d.name AS "documentName",
           d.kind
    FROM "DocumentChunk" dc
    JOIN "Document" d ON dc."documentId" = d.id
    WHERE d."userId" = ${userId}
      AND dc."documentId" IN (${Prisma.join(documentIds)})
      AND dc.embedding <=> ${vectorStr}::vector <= ${MAX_COSINE_DISTANCE}
    ORDER BY dc.embedding <=> ${vectorStr}::vector
    LIMIT ${limit};
  `;

  if (rows.length > 0) return rows;

  console.log("[rag] attachment semantic miss; fallback to first chunks", {
    documentCount: documentIds.length,
    queryLength: query.length,
  });

  return findFirstChunksOfDocuments(userId, documentIds, limit);
}
