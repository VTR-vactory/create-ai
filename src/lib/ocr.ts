const DEFAULT_MODEL = "glm-4.6v-flash";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 2000;

const OCR_PROMPT = [
  "你是 OCR 引擎。",
  "只输出图片中的文字，按自然阅读顺序。",
  "表格用 Markdown 表示。",
  "不要解释、不要翻译、不要总结、不要补充图片里没有的内容。",
  "不要输出代码块围栏。",
  "如果图片没有文字，输出空字符串。",
].join("\n");

export type OcrResult = {
  text: string;
  provider: "zhipu";
  model: string;
  latencyMs: number;
  attempts: number;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
};

export type OcrErrorCode =
  | "OCR_NOT_CONFIGURED"
  | "OCR_INVALID_IMAGE"
  | "OCR_EMPTY"
  | "OCR_RATE_LIMITED"
  | "OCR_REQUEST_FAILED"
  | "OCR_INVALID_RESPONSE";

export class OcrError extends Error {
  readonly code: OcrErrorCode;

  constructor(code: OcrErrorCode, message: string) {
    super(message);
    this.name = "OcrError";
    this.code = code;
  }
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

type OcrOptions = {
  model?: string;
  maxAttempts?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
};

function stripDataUri(base64: string): string {
  return base64
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "")
    .trim();
}

function normalizeText(raw: string): string {
  let text = raw.trim();
  const fenced = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/);
  if (fenced) text = fenced[1].trim();
  return text;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 503;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 用视觉模型把图片转成可检索文本。
 *
 * - 默认 glm-4.6v-flash（免费，但有限流）
 * - 关闭 thinking，降低延迟与输出 token
 * - 429/503/网络超时会退避重试
 * - 空文本视为失败，避免生成空文档
 */
export async function extractImageText(
  base64: string,
  options: OcrOptions = {},
): Promise<OcrResult> {
  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    throw new OcrError("OCR_NOT_CONFIGURED", "ZHIPU_API_KEY 未配置");
  }

  const image = stripDataUri(base64);
  if (!image) {
    throw new OcrError("OCR_INVALID_IMAGE", "图片内容为空");
  }

  const baseUrl =
    process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
  const model = options.model ?? process.env.ZHIPU_OCR_MODEL ?? DEFAULT_MODEL;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

  let lastError: OcrError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const startedAt = Date.now();

    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "image_url", image_url: { url: image } },
                { type: "text", text: OCR_PROMPT },
              ],
            },
          ],
          thinking: { type: "disabled" },
          temperature: 0,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const raw = await response.text();
      let data: ChatResponse;
      try {
        data = JSON.parse(raw) as ChatResponse;
      } catch {
        throw new OcrError(
          "OCR_INVALID_RESPONSE",
          `OCR 返回非 JSON（HTTP ${response.status}）`,
        );
      }

      if (isRetryableStatus(response.status)) {
        lastError = new OcrError(
          "OCR_RATE_LIMITED",
          `OCR 服务繁忙（HTTP ${response.status}）`,
        );
      } else if (!response.ok) {
        throw new OcrError(
          "OCR_REQUEST_FAILED",
          `OCR 请求失败（HTTP ${response.status}）`,
        );
      } else {
        const content = data.choices?.[0]?.message?.content ?? "";
        const text = normalizeText(content);
        if (!text) {
          throw new OcrError("OCR_EMPTY", "图片中没有识别到文字");
        }

        const latencyMs = Date.now() - startedAt;
        const usage = {
          promptTokens: data.usage?.prompt_tokens,
          completionTokens: data.usage?.completion_tokens,
          totalTokens: data.usage?.total_tokens,
        };

        console.log("[ocr]", {
          provider: "zhipu",
          model,
          attempts: attempt,
          latencyMs,
          textLength: text.length,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        });

        return {
          text,
          provider: "zhipu",
          model,
          latencyMs,
          attempts: attempt,
          usage,
        };
      }
    } catch (error) {
      if (error instanceof OcrError) {
        if (error.code !== "OCR_RATE_LIMITED") throw error;
        lastError = error;
      } else if (
        error instanceof DOMException &&
        error.name === "TimeoutError"
      ) {
        lastError = new OcrError("OCR_REQUEST_FAILED", "OCR 请求超时");
      } else {
        lastError = new OcrError(
          "OCR_REQUEST_FAILED",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (attempt < maxAttempts) {
      await sleep(retryDelayMs * attempt);
    }
  }

  throw (
    lastError ??
    new OcrError("OCR_REQUEST_FAILED", "OCR 请求失败，已达到最大重试次数")
  );
}
