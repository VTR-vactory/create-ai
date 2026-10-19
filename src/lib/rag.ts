/**
 * RAG（检索增强生成）工具库
 *
 * 核心功能：
 * 1. splitText       - 把长文档切成小块（chunk）
 * 2. createEmbedding - 把文本转成向量（调智谱 embedding API）
 * 3. cosineSimilarity- 算两个向量的相似度
 * 4. findRelevantChunks - 从用户的文档里找出最相关的片段
 *
 * RAG 流程：
 *   上传时：文档 → 切块 → 每块转向量 → 存数据库
 *   提问时：问题转向量 → 和每块算相似度 → 取 Top 4 → 塞进 prompt
 */

import { prisma } from "@/lib/prisma";

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
 * - 把文字转成一串数字（如 2048 维数组）
 * - "意思相近"的文字，向量也相近
 * - 用于"语义搜索"——不靠字面匹配，靠意思匹配
 *
 * @param input 要转向量的文本
 * @returns     2048 维的向量数组
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
    body: JSON.stringify({ model: "embedding-3", input }),
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
 * 计算两个向量的余弦相似度
 *
 * 公式：
 *   cos(A, B) = (A · B) / (|A| * |B|)
 *
 * 其中：
 *   A · B = 向量点积（对应位置相乘后求和）
 *   |A|   = A 的模长（sqrt(各分量平方和)）
 *
 * 返回值范围：-1 到 1
 *   - 1：完全相同方向（最相似）
 *   - 0：完全无关（垂直）
 *   - -1：完全相反方向
 *
 * 实际使用中，文本向量大多在 0 到 1 之间，
 * 越接近 1 越相似。
 *
 * @param left  向量 A
 * @param right 向量 B
 * @returns     相似度（0-1，越大越相似）
 */
export function cosineSimilarity(left: number[], right: number[]): number {
  // ① 检查长度是否一致（不一致无法比较）
  if (left.length !== right.length || left.length === 0) return 0;

  // ② 累加点积、模长
  let dot = 0; // A · B
  let leftNorm = 0; // |A|²
  let rightNorm = 0; // |B|²

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; // 累加点积
    leftNorm += left[index] ** 2; // 累加 A 的平方和
    rightNorm += right[index] ** 2; // 累加 B 的平方和
  }

  // ③ 计算最终相似度
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * 找出与问题最相关的文档片段（RAG 检索核心）
 *
 * 流程：
 *   ① 把问题转向量
 *   ② 查当前用户的所有文档块
 *   ③ 逐个算相似度
 *   ④ 过滤低分、排序、取 Top 4
 *
 * @param userId   当前用户 ID（数据隔离）
 * @param question 用户的问题
 * @returns        最相关的片段数组（含内容、文档名、相似度）
 */
export async function findRelevantChunks(userId: string, question: string) {
  // ① 把问题转成向量
  const questionEmbedding = await createEmbedding(question);

  // ② 查当前用户的所有文档块
  //    - where: 只能查当前用户的（数据隔离）
  //    - include: 带出文档名（用于后续展示引用来源）
  //    - take: 最多取 200 条（防止全表扫描）
  const chunks = await prisma.documentChunk.findMany({
    where: { document: { userId } },
    include: { document: { select: { name: true } } },
    take: 200,
  });

  // ③ 算相似度 + 过滤 + 排序 + 取 Top 4
  return (
    chunks
      .map((chunk) => ({
        content: chunk.content,
        documentName: chunk.document.name,
        // 算"问题"和"这一块"的相似度
        score: cosineSimilarity(questionEmbedding, chunk.embedding as number[]),
      }))
      // 过滤：相似度低于 0.45 的不要（避免塞无关内容）
      .filter((chunk) => chunk.score >= 0.45)
      // 排序：相似度高的在前
      .sort((first, second) => second.score - first.score)
      // 取前 4 条
      .slice(0, 4)
  );
}

/**
 * 只在指定的若干文档（会话附件）范围内检索。
 *
 * 与全量检索的区别：
 * - 范围锁定在 documentIds（且仍校验 userId，防止越权）
 * - 问题为空时（纯附件、无文字），不做语义检索，直接取前几块
 *   让模型能"读懂附件"，而不是返回空
 */
export async function findRelevantChunksForDocuments(
  userId: string,
  question: string,
  documentIds: string[],
) {
  if (!documentIds.length) return [];

  const chunks = await prisma.documentChunk.findMany({
    where: { documentId: { in: documentIds }, document: { userId } },
    include: { document: { select: { name: true } } },
    take: 300,
  });

  if (!chunks.length) return [];

  // 纯附件提问：没有可用的语义问题，直接给出前几块作为上下文
  if (!question.trim()) {
    return chunks.slice(0, 4).map((chunk) => ({
      content: chunk.content,
      documentName: chunk.document.name,
      score: 1,
    }));
  }

  const questionEmbedding = await createEmbedding(question);

  return chunks
    .map((chunk) => ({
      content: chunk.content,
      documentName: chunk.document.name,
      score: cosineSimilarity(questionEmbedding, chunk.embedding as number[]),
    }))
    .filter((chunk) => chunk.score >= 0.45)
    .sort((first, second) => second.score - first.score)
    .slice(0, 4);
}
