/**
 * POST /api/chat
 *
 * 编排顺序（每一步都在下面用注释标出）：
 *   鉴权 → 校验 → 会话归属 → 限流 → 附件归属 → 取问题
 *   → 检索 → 组装 Prompt → 流式生成 → 流结束落库
 *
 * 检索规则见 docs/retrieval-contract.md；落库细节见 lib/chat/persist.ts。
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  streamText,
  type UIMessage,
  toUIMessageStream,
  createUIMessageStreamResponse,
  consumeStream,
} from "ai";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/http";
import { chatSchema, findLastUserMessage, messageText } from "@/lib/chat/schema";
import { buildPrompt } from "@/lib/chat/prompt";
import { retrieveChunks } from "@/lib/chat/retrieval";
import { persistTurn } from "@/lib/chat/persist";
import { createNoBasisResponse, NO_BASIS_TEXT } from "@/lib/chat/no-basis";
import { chatRateLimit } from "@/lib/ratelimit";

const AI = createOpenAICompatible({
  name: "zhipu",
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL: process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
});

export async function POST(request: Request) {
  // 1. 鉴权
  const session = await auth();
  if (!session?.user?.id) {
    return apiError("UNAUTHORIZED", "请先登录", 401);
  }
  const userId = session.user.id;

  try {
    // 2. 校验请求体（request.json() 只能读一次）
    const parsed = chatSchema.safeParse(await request.json());
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "聊天请求格式不正确。");
    }

    // 3. 会话归属
    const ownedChat = await prisma.chat.findFirst({
      where: { id: parsed.data.chatId, userId },
      select: { id: true },
    });
    if (!ownedChat) {
      return apiError("NOT_FOUND", "对话不存在。", 404);
    }

    // 4. 限流
    const limit = await chatRateLimit.limit(userId);
    if (!limit.success) {
      return apiError("RATE_LIMITED", "请求过于频繁，请稍后再试。", 429, {
        "X-RateLimit-Reset": String(limit.reset),
      });
    }

    // 5. 附件归属（数量必须完全匹配，防止越权引用他人文档）
    const attachmentIds = parsed.data.attachmentIds;
    let attachments: { id: string; name: string }[] = [];
    if (attachmentIds.length) {
      attachments = await prisma.document.findMany({
        where: { id: { in: attachmentIds }, userId },
        select: { id: true, name: true },
      });
      if (attachments.length !== attachmentIds.length) {
        return apiError("INVALID_ATTACHMENT", "附件不存在或无权访问。");
      }
    }

    // 6. 取本轮问题；允许「有附件、无文字」
    const lastUserMessage = findLastUserMessage(parsed.data.messages);
    const userText = lastUserMessage ? messageText(lastUserMessage).trim() : "";
    if (!userText && !attachments.length) {
      return apiError("EMPTY_MESSAGE", "请输入问题或上传附件。");
    }

    const attachmentNames = attachments.map((doc) => doc.name);
    const userClientId = lastUserMessage?.id ?? null;
    const assistantClientId = userClientId
      ? `${userClientId}::assistant`
      : null;

    // 7. 检索（附件范围 / 当前用户文档；本地无命中且开关开启时才联网）
    const { chunks, webResults } = await retrieveChunks({
      userId,
      userText,
      attachmentIds: attachments.map((doc) => doc.id),
      useWebSearch: parsed.data.useWebSearch,
    });

    // 8. 组装 Prompt：资料 / 网络结果进用户消息，instructions 只放规则
    const prompt = buildPrompt({ userText, attachmentNames, chunks, webResults });

    // 8.5 没有任何依据（本地无命中，且未联网 / 联网无结果）：不调用模型。
    // 模型有自己的通用知识，只靠 prompt 约束仍可能作答；这里必须确定性短路。
    if (!chunks.length && !webResults.length) {
      console.log("[chat] no-basis", {
        attachmentCount: attachments.length,
        webSearchEnabled: parsed.data.useWebSearch,
      });
      return createNoBasisResponse({
        originalMessages: parsed.data.messages,
        onFinish: () =>
          persistTurn({
            chatId: ownedChat.id,
            userId,
            userClientId,
            assistantClientId,
            userContent: prompt.userContent,
            assistantContent: NO_BASIS_TEXT,
            attachmentIds: attachments.map((doc) => doc.id),
            titleSeed: prompt.titleSeed,
          }),
      });
    }

    const modelMessages: UIMessage[] = parsed.data.messages.map((message) =>
      message.role === "user" && message.id === lastUserMessage?.id
        ? { ...message, parts: [{ type: "text", text: prompt.promptForModel }] }
        : message,
    );

    // 9. 流式生成
    const result = streamText({
      model: AI("glm-4-flash"),
      instructions: prompt.instructions,
      messages: await convertToModelMessages(modelMessages.slice(-12)),
      // 绑定请求信号：用户点「停止生成」或浏览器断开时，立刻中止上游模型调用。
      // 取舍：停止要立即生效，因此断开 = 中止，只保留已经生成的内容。
      abortSignal: request.signal,
    });

    // 10. 流结束后落库（幂等 / 原子 position / 附件挂接 / 标题保护）
    const stream = toUIMessageStream({
      stream: result.stream,
      originalMessages: parsed.data.messages,
      onFinish: async ({ responseMessage, isAborted, outcome }) => {
        // 只保留已生成的部分：正常→完整；停止/断开→已生成；一个字都没有→占位文案
        const partial = messageText(responseMessage).trim();
        const assistantContent =
          partial ||
          (isAborted || outcome.status === "aborted"
            ? "（已停止生成）"
            : "（生成失败，可重试）");

        await persistTurn({
          chatId: ownedChat.id,
          userId,
          userClientId,
          assistantClientId,
          userContent: prompt.userContent,
          assistantContent,
          attachmentIds: attachments.map((doc) => doc.id),
          titleSeed: prompt.titleSeed,
        });
      },
      onError: (error) => {
        console.error("model stream failed", error);
        return "模型暂时不可用，请稍后重试。";
      },
    });

    return createUIMessageStreamResponse({
      stream,
      // consumeSseStream：给 SSE 流做一份 tee 副本并独立消费。
      // 客户端断开时响应流被 cancel，但副本仍会把流读到结尾，
      // 保证 onFinish 可靠触发、把「已生成的部分」落库，避免历史消息缺失。
      consumeSseStream: consumeStream,
    });
  } catch (error) {
    console.error("chat failed", error);
    return apiError("INTERNAL_ERROR", "服务暂时不可用，请稍后重试。", 500);
  }
}
