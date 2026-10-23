import { describe, expect, it } from "vitest";
import { buildLocalSources, localSourceTitle, localSourceUrl } from "./sources";
import type { RetrievedChunk } from "./types";

const text: RetrievedChunk = {
  content: "片段",
  documentId: "doc-1",
  documentName: "notes.md",
  kind: "TEXT",
};

const image: RetrievedChunk = {
  content: "OCR 文本",
  documentId: "doc-2",
  documentName: "receipt.png",
  kind: "IMAGE",
};

describe("buildLocalSources", () => {
  it("没有片段时返回空来源", () => {
    const result = buildLocalSources([]);
    expect(result.sources).toEqual([]);
    expect(result.indexByDocumentId.size).toBe(0);
  });

  it("同一文档多个 chunk 只产生一个来源", () => {
    const result = buildLocalSources([
      text,
      { ...text, content: "第二个片段" },
      image,
    ]);

    expect(result.sources).toHaveLength(2);
    expect(result.indexByDocumentId.get("doc-1")).toBe(1);
    expect(result.indexByDocumentId.get("doc-2")).toBe(2);
  });

  it("文本来源使用文档名和 raw 链接", () => {
    const result = buildLocalSources([text]);
    expect(result.sources[0]).toEqual({
      index: 1,
      title: "notes.md",
      url: "/api/documents/doc-1/raw",
    });
  });

  it("图片来源标题标注 OCR", () => {
    const result = buildLocalSources([image]);
    expect(result.sources[0].title).toBe("图片：receipt.png（OCR）");
  });

  it("编号按首次命中顺序", () => {
    const result = buildLocalSources([image, text]);
    expect(result.indexByDocumentId.get("doc-2")).toBe(1);
    expect(result.indexByDocumentId.get("doc-1")).toBe(2);
  });
});

describe("source helpers", () => {
  it("文本标题不加前缀", () => {
    expect(localSourceTitle(text)).toBe("notes.md");
  });

  it("documentId 会做 URL 编码", () => {
    expect(localSourceUrl("a/b")).toBe("/api/documents/a%2Fb/raw");
  });
});
