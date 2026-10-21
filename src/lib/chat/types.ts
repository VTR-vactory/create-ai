/** 检索命中的一个片段 */
export type RetrievedChunk = {
  content: string;
  documentName: string;
};

/** 联网搜索返回的一条结果 */
export type WebResult = {
  title: string;
  url: string;
  content: string;
};

/** 本次回答命中哪一级数据源（与 docs/retrieval-contract.md 一致） */
export type SourceTier = "attachment" | "user" | "web" | "none";
