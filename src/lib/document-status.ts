export const REINDEX_STALE_MS = 10 * 60 * 1000;

export type DocumentStatusValue = "PROCESSING" | "READY" | "PARTIAL" | "FAILED";

/**
 * 是否允许手动重建索引：
 * - FAILED / PARTIAL：明确失败，允许重试
 * - PROCESSING 超过 10 分钟：视为卡死，允许接管
 * - READY / 刚进入 PROCESSING：不允许
 */
export function canReindex(
  status: DocumentStatusValue,
  updatedAt: Date,
  now: Date = new Date(),
): boolean {
  if (status === "FAILED" || status === "PARTIAL") return true;
  if (status !== "PROCESSING") return false;
  return now.getTime() - updatedAt.getTime() >= REINDEX_STALE_MS;
}
