import type { WebResult } from "@/lib/chat/types";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_LIMIT = 4;
const TIMEOUT_MS = 5000;
const MAX_QUERY_LENGTH = 500;
const MAX_TITLE_LENGTH = 200;
const MAX_CONTENT_LENGTH = 800;

/** 是否配置了搜索服务（未配置时联网会静默降级为无结果） */
export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.TAVILY_API_KEY);
}

/**
 * 联网搜索（Tavily）。
 *
 * 契约（docs/retrieval-contract.md）：
 * - 只发送用户的问题文本，绝不附加本地资料
 * - 失败 / 超时 / 未配置 Key → 返回 []，不抛错（由上层降级）
 */
export async function searchWeb(
  query: string,
  opts?: { limit?: number },
): Promise<WebResult[]> {
  const trimmed = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!trimmed) return [];

  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("[web-search] TAVILY_API_KEY 未配置，跳过联网搜索");
    return [];
  }

  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(TAVILY_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      // 只发送问题文本；max_results 控制成本
      body: JSON.stringify({
        query: trimmed,
        max_results: limit,
        search_depth: "basic",
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`[web-search] HTTP ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      results?: Array<{ title?: string; url?: string; content?: string }>;
    };

    return (data.results ?? [])
      .slice(0, limit)
      .map((item) => ({
        title: (item.title ?? "").slice(0, MAX_TITLE_LENGTH),
        url: item.url ?? "",
        content: (item.content ?? "").slice(0, MAX_CONTENT_LENGTH),
      }))
      .filter((item) => item.url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[web-search] failed:", message);
    return [];
  } finally {
    clearTimeout(timer);
  }
}
