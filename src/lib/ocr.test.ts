import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractImageText, OcrError } from "./ocr";

const originalKey = process.env.ZHIPU_API_KEY;
const originalModel = process.env.ZHIPU_OCR_MODEL;

vi.spyOn(console, "log").mockImplementation(() => {});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function completion(text: string) {
  return jsonResponse({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
  });
}

describe("extractImageText", () => {
  beforeEach(() => {
    process.env.ZHIPU_API_KEY = "test-key";
    delete process.env.ZHIPU_OCR_MODEL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) {
      delete process.env.ZHIPU_API_KEY;
    } else {
      process.env.ZHIPU_API_KEY = originalKey;
    }
    if (originalModel === undefined) {
      delete process.env.ZHIPU_OCR_MODEL;
    } else {
      process.env.ZHIPU_OCR_MODEL = originalModel;
    }
  });

  it("成功返回文本，并关闭 thinking", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("退款周期：14 个工作日"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractImageText("raw-base64", { retryDelayMs: 0 });

    expect(result.text).toBe("退款周期：14 个工作日");
    expect(result.attempts).toBe(1);
    expect(result.usage.promptTokens).toBe(500);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      temperature: number;
      thinking: { type: string };
      messages: Array<{
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;
    };
    expect(body.model).toBe("glm-4.6v-flash");
    expect(body.temperature).toBe(0);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.messages[0].content[0].image_url?.url).toBe("raw-base64");
  });

  it("去掉 data URI 前缀后再发送", async () => {
    const fetchMock = vi.fn().mockResolvedValue(completion("文字"));
    vi.stubGlobal("fetch", fetchMock);

    await extractImageText("data:image/png;base64,abc123", { retryDelayMs: 0 });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      messages: Array<{
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;
    };
    expect(body.messages[0].content[0].image_url?.url).toBe("abc123");
  });

  it("429 后重试并成功", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "1305", message: "busy" } }, 429),
      )
      .mockResolvedValueOnce(completion("第二次成功"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await extractImageText("abc", { retryDelayMs: 0 });

    expect(result.text).toBe("第二次成功");
    expect(result.attempts).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("401 不重试，直接抛错", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      extractImageText("abc", { retryDelayMs: 0 }),
    ).rejects.toMatchObject({ code: "OCR_REQUEST_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("识别结果为空时抛 OCR_EMPTY", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(completion("   ")));

    await expect(
      extractImageText("abc", { retryDelayMs: 0 }),
    ).rejects.toMatchObject({ code: "OCR_EMPTY" });
  });

  it("未配置 Key 时不发请求", async () => {
    delete process.env.ZHIPU_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(extractImageText("abc")).rejects.toBeInstanceOf(OcrError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
