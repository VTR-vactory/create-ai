import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWebSearchConfigured, searchWeb } from "./web-search";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("TAVILY_API_KEY", "test-key");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("searchWeb", () => {
  it("未配置 Key：返回空，且不发请求", async () => {
    vi.stubEnv("TAVILY_API_KEY", "");
    expect(isWebSearchConfigured()).toBe(false);

    await expect(searchWeb("问题")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("空问题：不发请求", async () => {
    await expect(searchWeb("   ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("只发送问题文本，并映射结果", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "标题", url: "https://example.com", content: "摘要" }],
      }),
    });

    const results = await searchWeb("  问题  ");
    expect(results).toEqual([
      { title: "标题", url: "https://example.com", content: "摘要" },
    ]);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("问题");
    // 隐私：请求体只包含问题与搜索参数，不含任何本地资料
    expect(Object.keys(body).sort()).toEqual([
      "max_results",
      "query",
      "search_depth",
    ]);
    expect(init.headers.Authorization).toBe("Bearer test-key");
  });

  it("非 200：返回空，不抛错", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    await expect(searchWeb("问题")).resolves.toEqual([]);
  });

  it("网络异常：返回空，不抛错", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    await expect(searchWeb("问题")).resolves.toEqual([]);
  });

  it("过滤没有 url 的结果", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: "无链接", content: "x" }],
      }),
    });
    await expect(searchWeb("问题")).resolves.toEqual([]);
  });
});
