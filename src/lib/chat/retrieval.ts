import { findRelevantChunks, findRelevantChunksForDocuments } from "@/lib/rag";
import { searchWeb } from "@/lib/web-search";
import type { RetrievedChunk, SourceTier, WebResult } from "./types";

export type RetrievalResult = {
  chunks: RetrievedChunk[];
  webResults: WebResult[];
  sourceTier: SourceTier;
  latencyMs: number;
  webSearchEnabled: boolean;
  usedWebSearch: boolean;
};

/**
 * 按检索契约选择数据源（docs/retrieval-contract.md）：
 * - 有附件          → 只在该轮附件范围内检索
 * - 无附件          → 只检索当前用户的文档
 * - 均未命中        → 只有开关打开时才联网（useWebSearch）
 *
 * 隐私红线：所有本地检索都带 userId，禁止跨用户 / 全库检索；
 * 联网只发送用户问题文本，不发送任何本地资料。
 */
export async function retrieveChunks(params: {
  userId: string;
  userText: string;
  attachmentIds: string[];
  useWebSearch?: boolean;
}): Promise<RetrievalResult> {
  const { userId, userText, attachmentIds } = params;
  const webSearchEnabled = params.useWebSearch ?? false;

  const startedAt = Date.now();
  const chunks = attachmentIds.length
    ? await findRelevantChunksForDocuments(userId, userText, attachmentIds)
    : await findRelevantChunks(userId, userText);

  // 只有本地完全没有命中，且用户显式开启时，才联网
  const shouldSearchWeb = webSearchEnabled && chunks.length === 0;
  const webResults = shouldSearchWeb ? await searchWeb(userText) : [];
  const latencyMs = Date.now() - startedAt;

  const sourceTier: SourceTier = chunks.length
    ? attachmentIds.length
      ? "attachment"
      : "user"
    : webResults.length
      ? "web"
      : "none";

  // 观测：命中层级 / 数量 / 是否联网 / 是否降级
  console.log("[chat] retrieval", {
    sourceTier,
    hitCount: chunks.length,
    attachmentCount: attachmentIds.length,
    pureAttachment: attachmentIds.length > 0 && !userText,
    webSearchEnabled,
    usedWebSearch: shouldSearchWeb,
    webResultCount: webResults.length,
    degraded: shouldSearchWeb && webResults.length === 0,
    latencyMs,
  });

  return {
    chunks,
    webResults,
    sourceTier,
    latencyMs,
    webSearchEnabled,
    usedWebSearch: shouldSearchWeb,
  };
}
