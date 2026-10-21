import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rag", () => ({
  findRelevantChunks: vi.fn(),
  findRelevantChunksForDocuments: vi.fn(),
}));
vi.mock("@/lib/web-search", () => ({
  searchWeb: vi.fn(),
}));

import { findRelevantChunks, findRelevantChunksForDocuments } from "@/lib/rag";
import { searchWeb } from "@/lib/web-search";
import { retrieveChunks } from "./retrieval";

const userSearch = findRelevantChunks as unknown as ReturnType<typeof vi.fn>;
const docSearch = findRelevantChunksForDocuments as unknown as ReturnType<
  typeof vi.fn
>;
const webSearch = searchWeb as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
  userSearch.mockResolvedValue([]);
  docSearch.mockResolvedValue([]);
  webSearch.mockResolvedValue([]);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("retrieveChunks", () => {
  it("本地命中：即使开关开着也不联网", async () => {
    userSearch.mockResolvedValue([{ content: "c", documentName: "a.md" }]);

    const result = await retrieveChunks({
      userId: "u",
      userText: "问题",
      attachmentIds: [],
      useWebSearch: true,
    });

    expect(result.sourceTier).toBe("user");
    expect(result.usedWebSearch).toBe(false);
    expect(result.webResults).toEqual([]);
    expect(webSearch).not.toHaveBeenCalled();
  });

  it("有附件：只查附件范围，命中后 sourceTier=attachment", async () => {
    docSearch.mockResolvedValue([{ content: "c", documentName: "a.md" }]);

    const result = await retrieveChunks({
      userId: "u",
      userText: "问题",
      attachmentIds: ["doc-1"],
    });

    expect(docSearch).toHaveBeenCalledWith("u", "问题", ["doc-1"]);
    expect(userSearch).not.toHaveBeenCalled();
    expect(result.sourceTier).toBe("attachment");
  });

  it("本地无命中 + 开关关：不联网", async () => {
    const result = await retrieveChunks({
      userId: "u",
      userText: "问题",
      attachmentIds: [],
      useWebSearch: false,
    });

    expect(result.sourceTier).toBe("none");
    expect(result.usedWebSearch).toBe(false);
    expect(webSearch).not.toHaveBeenCalled();
  });

  it("本地无命中 + 开关开：联网，且只发送问题文本", async () => {
    webSearch.mockResolvedValue([
      { title: "标题", url: "https://example.com", content: "摘要" },
    ]);

    const result = await retrieveChunks({
      userId: "u",
      userText: "问题",
      attachmentIds: [],
      useWebSearch: true,
    });

    expect(webSearch).toHaveBeenCalledWith("问题");
    expect(result.sourceTier).toBe("web");
    expect(result.usedWebSearch).toBe(true);
    expect(result.webResults).toHaveLength(1);
  });

  it("联网为空（失败/未配置）：降级为 none", async () => {
    webSearch.mockResolvedValue([]);

    const result = await retrieveChunks({
      userId: "u",
      userText: "问题",
      attachmentIds: [],
      useWebSearch: true,
    });

    expect(result.sourceTier).toBe("none");
    expect(result.usedWebSearch).toBe(true);
    expect(result.webResults).toEqual([]);
  });
});
