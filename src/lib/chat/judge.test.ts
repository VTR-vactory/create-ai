import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { judgeAnswerable } from "./judge";

const originalKey = process.env.ZHIPU_API_KEY;

function mockCompletion(
  content: string,
  status = 200,
  usage?: { prompt_tokens: number; completion_tokens: number },
) {
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        ...(usage ? { usage } : {}),
      }),
      { status },
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("judgeAnswerable", () => {
  beforeEach(() => {
    process.env.ZHIPU_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) {
      delete process.env.ZHIPU_API_KEY;
    } else {
      process.env.ZHIPU_API_KEY = originalKey;
    }
  });

  it("解析 fenced JSON，判定可回答", async () => {
    mockCompletion(
      '```json\n{"answerable": true, "reason": "有依据"}\n```',
      200,
      { prompt_tokens: 120, completion_tokens: 12 },
    );

    const verdict = await judgeAnswerable({
      question: "支持哪些格式？",
      chunks: [{ content: "Markdown/TXT/CSV", documentName: "doc.md" }],
    });

    expect(verdict.answerable).toBe(true);
    expect(verdict.reason).toBe("有依据");
    expect(verdict.latencyMs).toBeGreaterThanOrEqual(0);
    expect(verdict.promptTokens).toBe(120);
    expect(verdict.completionTokens).toBe(12);
  });

  it("判定不可回答", async () => {
    mockCompletion('{"answerable": false, "reason": "没有事实"}');

    const verdict = await judgeAnswerable({
      question: "创始人是谁？",
      chunks: [{ content: "产品说明", documentName: "doc.md" }],
    });

    expect(verdict.answerable).toBe(false);
  });

  it("JSON 不完整时用正则兜底", async () => {
    mockCompletion('结论: "answerable": true');

    const verdict = await judgeAnswerable({
      question: "q",
      chunks: [{ content: "c", documentName: "d" }],
    });

    expect(verdict.answerable).toBe(true);
  });

  it("HTTP 失败时抛错，交给调用方 fail-open", async () => {
    mockCompletion("", 500);

    await expect(
      judgeAnswerable({
        question: "q",
        chunks: [{ content: "c", documentName: "d" }],
      }),
    ).rejects.toThrow("HTTP 500");
  });

  it("没有片段时不调用模型", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const verdict = await judgeAnswerable({ question: "q", chunks: [] });

    expect(verdict.answerable).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
