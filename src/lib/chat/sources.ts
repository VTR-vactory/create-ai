import type { RetrievedChunk, SourceLink } from "./types";

export function localSourceTitle(
  chunk: Pick<RetrievedChunk, "kind" | "documentName">,
): string {
  const name = chunk.documentName || "未命名文档";
  return chunk.kind === "IMAGE" ? `图片：${name}（OCR）` : name;
}

export function localSourceUrl(documentId: string): string {
  return `/api/documents/${encodeURIComponent(documentId)}/raw`;
}

/**
 * 把检索片段转成文档级来源。
 *
 * - 同一文档的多个 chunk 只保留一个来源
 * - 编号按首次命中顺序，从 1 开始
 * - 图片标题带「OCR」，点击打开原图
 */
export function buildLocalSources(chunks: readonly RetrievedChunk[]): {
  sources: SourceLink[];
  indexByDocumentId: Map<string, number>;
} {
  const sources: SourceLink[] = [];
  const indexByDocumentId = new Map<string, number>();

  for (const chunk of chunks) {
    if (indexByDocumentId.has(chunk.documentId)) continue;

    const index = sources.length + 1;
    indexByDocumentId.set(chunk.documentId, index);
    sources.push({
      index,
      title: localSourceTitle(chunk),
      url: localSourceUrl(chunk.documentId),
    });
  }

  return { sources, indexByDocumentId };
}
