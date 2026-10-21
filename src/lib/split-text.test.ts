import { describe, it, expect } from "vitest";
import { splitText } from "./rag";

describe("splitText", () => {
  it("处理空字符串时返回空数组", () => {
    expect(splitText("")).toEqual([]);
  });

  it("短文本应该原样作为单个块返回", () => {
    const shortText = "这是一段短文本";
    const result = splitText(shortText);
    expect(result.length).toBe(1);
    expect(result[0]).toBe(shortText);
  });

  it("超长文本应该被切分", () => {
    const longText = "A".repeat(5000);
    const chunks = splitText(longText);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("overlap 为 0 时拼接后长度与原文本一致", () => {
    const longText = "A".repeat(5000);
    const chunks = splitText(longText, 800, 0);
    expect(chunks.join("").length).toBe(longText.length);
  });
});
