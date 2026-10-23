/** 检索命中的一个片段 */
export type RetrievedChunk = {
  content: string;
  documentId: string;
  documentName: string;
  kind: "TEXT" | "IMAGE";
};

/** 联网搜索返回的一条结果 */
export type WebResult = {
  title: string;
  url: string;
  content: string;
};

/** 展示给前端的来源引用（index 从 1 开始，与回答里的【1】对应） */
export type SourceLink = {
  index: number;
  title: string;
  url: string;
};

/** 本次回答命中哪一级数据源（与 docs/retrieval-contract.md 一致） */
export type SourceTier = "attachment" | "user" | "web" | "none";
