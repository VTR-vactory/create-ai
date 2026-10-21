import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 只 mock 数据库，不连真实 Postgres（CI 安全）
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    documentChunk: { findMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { findRelevantChunks, findRelevantChunksForDocuments } from "./rag";

const queryRawMock = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const findManyMock = prisma.documentChunk.findMany as unknown as ReturnType<
  typeof vi.fn
>;

const EMBEDDING = [0.1, 0.2, 0.3, 0.4];
const USER = "user-1";
const DOC_A = "doc-a";
// 与 rag.ts 中的 MAX_COSINE_DISTANCE 保持一致
const MAX_DISTANCE = "0.55";

function stubFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({ data: [{ embedding: EMBEDDING }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.ZHIPU_API_KEY = "test-key";
  queryRawMock.mockReset();
  findManyMock.mockReset();
  queryRawMock.mockResolvedValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ZHIPU_API_KEY;
});

describe("findRelevantChunks（纯文字 → 当前用户文档）", () => {
  it("空问题直接返回空，不调用 embedding / 数据库", async () => {
    const fetchMock = stubFetch();

    await expect(findRelevantChunks(USER, "   ")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("SQL 必须带 userId 与距离阈值（用户隔离 + 阈值生效）", async () => {
    const fetchMock = stubFetch();

    await findRelevantChunks(USER, "如何使用");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const sql = JSON.stringify(queryRawMock.mock.calls[0]);
    expect(sql).toContain(USER);
    expect(sql).toContain(MAX_DISTANCE);
  });

  it("原样返回数据库命中的片段", async () => {
    stubFetch();
    queryRawMock.mockResolvedValue([{ content: "c1", documentName: "a.md" }]);

    await expect(findRelevantChunks(USER, "问题")).resolves.toEqual([
      { content: "c1", documentName: "a.md" },
    ]);
  });
});

describe("findRelevantChunksForDocuments（附件范围）", () => {
  it("没有附件 id 时返回空，且不查库", async () => {
    const fetchMock = stubFetch();

    await expect(
      findRelevantChunksForDocuments(USER, "问题", []),
    ).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("纯附件（无文字）取前 N 块，且按 userId + documentId 隔离", async () => {
    const fetchMock = stubFetch();
    findManyMock.mockResolvedValue([
      { content: "块1", document: { name: "a.md" } },
    ]);

    const result = await findRelevantChunksForDocuments(USER, "", [DOC_A]);

    expect(result).toEqual([{ content: "块1", documentName: "a.md" }]);
    // 纯附件不做语义检索，不应调用 embedding
    expect(fetchMock).not.toHaveBeenCalled();

    const args = findManyMock.mock.calls[0][0];
    expect(args.where).toMatchObject({
      documentId: { in: [DOC_A] },
      document: { userId: USER },
    });
  });

  it("有文字时按向量检索，并限定 userId + documentId + 阈值", async () => {
    stubFetch();

    await findRelevantChunksForDocuments(USER, "问题", [DOC_A]);

    const sql = JSON.stringify(queryRawMock.mock.calls[0]);
    expect(sql).toContain(USER);
    expect(sql).toContain(DOC_A);
    expect(sql).toContain(MAX_DISTANCE);
  });
});
