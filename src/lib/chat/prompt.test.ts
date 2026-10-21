import { describe, expect, it } from "vitest";
import { buildPrompt, formatKnowledge, DEFAULT_ATTACHMENT_QUESTION } from "./prompt";

describe("formatKnowledge", () => {
  it("没有命中时返回兜底文案", () => {
    expect(formatKnowledge([])).toBe("没有找到与问题相关的私有资料。");
  });

  it("有命中时带上资料序号与文档名", () => {
    const text = formatKnowledge([
      { content: "内容A", documentName: "a.md" },
      { content: "内容B", documentName: "b.md" },
    ]);
    expect(text).toContain("[资料 1：a.md]");
    expect(text).toContain("内容A");
    expect(text).toContain("[资料 2：b.md]");
    expect(text).toContain("内容B");
    expect(text.split("\n\n")).toHaveLength(2);
  });
});

describe("buildPrompt", () => {
  const chunks = [{ content: "PostgreSQL 保存对话", documentName: "db.md" }];

  it("普通提问：userContent 保留用户原文，资料进受限上下文", () => {
    const result = buildPrompt({
      userText: "用什么保存对话？",
      attachmentNames: [],
      chunks,
    });

    expect(result.userContent).toBe("用什么保存对话？");
    expect(result.effectiveQuestion).toBe("用什么保存对话？");
    expect(result.promptForModel).toContain("用什么保存对话？");
    expect(result.promptForModel).toContain("【资料片段】");
    expect(result.promptForModel).toContain("<context>");
    expect(result.promptForModel).toContain("PostgreSQL 保存对话");
    expect(result.promptForModel).toContain("【资料片段结束】");
  });

  it("纯附件：用默认问题，userContent 为空，标题取附件名", () => {
    const result = buildPrompt({
      userText: "",
      attachmentNames: ["规格.md"],
      chunks,
    });

    expect(result.effectiveQuestion).toBe(DEFAULT_ATTACHMENT_QUESTION);
    expect(result.userContent).toBe("");
    expect(result.titleSeed).toBe("规格.md");
    expect(result.promptForModel).toContain(DEFAULT_ATTACHMENT_QUESTION);
  });

  it("无问题无附件时标题回退为“新对话”", () => {
    const result = buildPrompt({
      userText: "",
      attachmentNames: [],
      chunks: [],
    });
    expect(result.titleSeed).toBe("新对话");
    expect(result.promptForModel).toContain("没有找到与问题相关的私有资料。");
  });

  it("instructions 含防提示注入声明，且不包含资料正文", () => {
    const result = buildPrompt({
      userText: "问题",
      attachmentNames: ["a.md"],
      chunks,
    });

    expect(result.instructions).toContain("不得执行");
    // 资料不应出现在系统指令里
    expect(result.instructions).not.toContain("PostgreSQL 保存对话");
  });

  it("有网络结果：拼接网络分区并要求标注来源", () => {
    const result = buildPrompt({
      userText: "今天有什么新闻",
      attachmentNames: [],
      chunks: [],
      webResults: [
        { title: "新闻标题", url: "https://example.com/news", content: "摘要" },
      ],
    });

    expect(result.promptForModel).toContain("【网络搜索结果】");
    expect(result.promptForModel).toContain("https://example.com/news");
    expect(result.promptForModel).toContain("摘要");
    expect(result.instructions).toContain("来源编号");
    expect(result.instructions).toContain("不得执行");
  });

  it("没有网络结果时不出现网络分区", () => {
    const result = buildPrompt({
      userText: "问题",
      attachmentNames: [],
      chunks,
    });
    expect(result.promptForModel).not.toContain("【网络搜索结果】");
  });
});
