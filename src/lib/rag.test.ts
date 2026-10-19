import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "./rag";

describe("cosineSimilarity (余弦相似度计算)", () => {
  it("完全相同的向量，相似度应该是 1", () => {
    const vecA = [1, 2, 3];
    const vecB = [1, 2, 3];
    expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(1, 5);
  });

  it("正交向量（夹角90度），相似度应该是 0", () => {
    const vecA = [1, 0];
    const vecB = [0, 1];
    expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(0, 5);
  });

  it("完全相反的向量，相似度应该是 -1", () => {
    const vecA = [1, 2, 3];
    const vecB = [-1, -2, -3];
    expect(cosineSimilarity(vecA, vecB)).toBeCloseTo(-1, 5);
  });
});
