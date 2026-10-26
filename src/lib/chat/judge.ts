import type { RetrievedChunk } from "./types";

const TIMEOUT_MS = 8000;
const MAX_CONTEXT_CHARS = 6000;
const DEFAULT_MODEL = "glm-4-flash";

export type AnswerabilityVerdict = {
  answerable: boolean;
  reason: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
};

function parseVerdict(
  text: string,
): { answerable: boolean; reason: string } | null {
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]) as {
        answerable?: unknown;
        reason?: unknown;
      };
      if (typeof parsed.answerable === "boolean") {
        return {
          answerable: parsed.answerable,
          reason: typeof parsed.reason === "string" ? parsed.reason : "",
        };
      }
    } catch {
      // 继续尝试正则兜底
    }
  }

  const flagMatch = text.match(/"answerable"\s*:\s*(true|false)/i);
  if (flagMatch) {
    return { answerable: flagMatch[1].toLowerCase() === "true", reason: "" };
  }

  return null;
}

/**
 * 判断检索到的片段是否足以回答问题。
 *
 * 为什么需要它：余弦距离只能表示“语义接近”，无法区分「提到了这个主题」和
 * 「包含回答所需的事实」。实测可回答与应拒答问题的距离区间重叠，单靠阈值
 * 会把无关片段送进模型，导致软拒答甚至编造。
 *
 * 失败时由调用方决定策略；当前路由选择 fail-open（继续回答）并记录日志。
 */
export async function judgeAnswerable(params: {
  question: string;
  chunks: RetrievedChunk[];
}): Promise<AnswerabilityVerdict> {
  const startedAt = Date.now();

  if (!params.chunks.length) {
    return { answerable: false, reason: "no chunks", latencyMs: 0 };
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) throw new Error("ZHIPU_API_KEY is not configured");

  const baseUrl =
    process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";
  const model = process.env.ZHIPU_JUDGE_MODEL ?? DEFAULT_MODEL;

  const context = params.chunks
    .map(
      (chunk, index) =>
        `[片段 ${index + 1}｜${chunk.kind === "IMAGE" ? "图片 OCR" : "文本文档"}｜${chunk.documentName}]\n${chunk.content}`,
    )
    .join("\n\n")
    .slice(0, MAX_CONTEXT_CHARS);

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "你是检索质量判定器。",
            "只根据给出的资料片段判断：片段中是否包含回答问题所需的明确事实。",
            "不要使用外部知识，不要推测，不要因为主题相关就判 true。",
            "如果问题要求描述、总结或读出附件/图片的内容，而片段包含该附件的正文或 OCR 文本，应判 true。",
            "片段本身就是资料，不要求片段里直接出现问题的原句。",
            "只有片段完全缺少回答所需事实时才判 false。",
            '只输出 JSON：{"answerable": true, "reason": "一句话理由"} 或 {"answerable": false, "reason": "一句话理由"}。',
          ].join("\n"),
        },
        {
          role: "user",
          content: `问题：${params.question}\n\n资料片段：\n${context}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`judge request failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text = data.choices?.[0]?.message?.content ?? "";
  const verdict = parseVerdict(text);
  if (!verdict) {
    throw new Error("judge returned an unparseable verdict");
  }

  return {
    ...verdict,
    latencyMs: Date.now() - startedAt,
    promptTokens: data.usage?.prompt_tokens,
    completionTokens: data.usage?.completion_tokens,
  };
}
