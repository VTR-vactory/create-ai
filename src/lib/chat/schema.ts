import { z } from "zod";
import type { UIMessage } from "ai";

/** 最小结构校验：确保是合法的 UIMessage，避免后续处理崩溃 */
export function isUIMessage(value: unknown): value is UIMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { id?: unknown; role?: unknown; parts?: unknown };
  const roleOk = message.role === "user" || message.role === "assistant";
  return (
    typeof message.id === "string" &&
    message.id.length > 0 &&
    roleOk &&
    Array.isArray(message.parts)
  );
}

export const chatSchema = z.object({
  chatId: z.string().min(1),
  messages: z.array(z.custom<UIMessage>(isUIMessage)).min(1),
  // 本轮随消息附带的文档 id（先经 /api/documents 上传获得）
  attachmentIds: z.array(z.string().cuid()).max(10).default([]),
  // 是否允许在本地无命中时联网搜索（默认关闭）
  useWebSearch: z.boolean().default(false),
});

export type ChatRequest = z.infer<typeof chatSchema>;

/** 把 UIMessage 里的 text parts 拼成字符串 */
export function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

/** 找到消息列表里的最后一条用户消息 */
export function findLastUserMessage(
  messages: UIMessage[],
): UIMessage | undefined {
  return [...messages].reverse().find((message) => message.role === "user");
}
