import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  streamText,
  type UIMessage,
  toUIMessageStream,
  createUIMessageStreamResponse,
} from "ai";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { findRelevantChunks, findRelevantChunksForDocuments } from "@/lib/rag";
import { chatRateLimit } from "@/lib/ratelimit";

const AI = createOpenAICompatible({
  name: "zhipu",
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL: process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4",
});
// 最小结构校验：确保是合法的 UIMessage，避免服务端在后续处理时崩溃
function isUIMessage(value: unknown): value is UIMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as { id?: unknown; role?: unknown; parts?: unknown };
  const roleOk =
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "system";
  return (
    typeof message.id === "string" &&
    message.id.length > 0 &&
    roleOk &&
    Array.isArray(message.parts)
  );
}

// 创建校验器
const chatSchema = z.object({
  chatId: z.string().min(1),
  messages: z.array(z.custom<UIMessage>(isUIMessage)).min(1).max(30),
  // 本轮随消息附带的文档 id（先经 /api/documents 上传获得）
  attachmentIds: z.array(z.string().cuid()).max(10).default([]),
});

function messageText(message: UIMessage): string {
  return message.parts
    .filter(
      (part): part is Extract<typeof part, { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

export async function POST(request: Request) {
  const session = await auth();
  // 鉴权
  if (!session?.user?.id) {
    return Response.json(
      { error: { code: "UNAUTHORIZED", message: "请先登录" } },
      { status: 401 },
    );
  }
  const userId = session.user.id;
  try {
    // 格式校验
    const parsed = chatSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        {
          error: { code: "VALIDATION_ERROR", message: "聊天请求格式不正确。" },
        },
        { status: 400 },
      );
    }

    // 校验当前对话是否属于当前用户
    const ownedChat = await prisma.chat.findFirst({
      where: {
        id: parsed.data.chatId,
        userId: session.user.id,
      },
      select: { id: true },
    });
    if (!ownedChat) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "对话不存在。" } },
        { status: 404 },
      );
    }

    // 限流

    const limit = await chatRateLimit.limit(session.user.id);
    if (!limit.success) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message: "请求过于频繁，请稍后再试。",
          },
        },
        {
          status: 429,
          headers: { "X-RateLimit-Reset": String(limit.reset) },
        },
      );
    }

    // 解析本轮附件（仍校验归属，防止越权引用他人文档）
    const attachmentIds = parsed.data.attachmentIds;
    let attachments: { id: string; name: string }[] = [];
    if (attachmentIds.length) {
      attachments = await prisma.document.findMany({
        where: { id: { in: attachmentIds }, userId },
        select: { id: true, name: true },
      });
      if (attachments.length !== attachmentIds.length) {
        return Response.json(
          {
            error: {
              code: "INVALID_ATTACHMENT",
              message: "附件不存在或无权访问。",
            },
          },
          { status: 400 },
        );
      }
    }

    // 找到当前对话的最后一个用户消息

    const lastUserMessage = [...parsed.data.messages]
      .reverse()
      .find((m) => m.role === "user");
    const userText = lastUserMessage ? messageText(lastUserMessage).trim() : "";

    // 允许「有附件、无文字」：纯附件提问是合法场景
    if (!userText && !attachments.length) {
      return Response.json(
        { error: { code: "EMPTY_MESSAGE", message: "请输入问题或上传附件。" } },
        { status: 400 },
      );
    }

    const attachmentNames = attachments.map((doc) => doc.name);
    // 纯附件提问时，给模型一个明确指令，否则它只会看到空文本而回复寒暄
    const effectiveQuestion =
      userText || "请阅读并总结我刚上传的资料，说明它讲了什么。";
    // 只保留用户真正输入的文字；纯附件时为空，历史里仅显示附件 chip
    const userContent = userText;
    const titleSeed = userText || attachmentNames[0] || "新对话";

    // RAG 检索：有附件时只在该轮附件范围内检索，否则检索用户全部资料
    const userClientId = lastUserMessage?.id ?? null;
    const assistantClientId = userClientId
      ? `${userClientId}::assistant`
      : null;
    const relevantChunks = attachments.length
      ? await findRelevantChunksForDocuments(
          userId,
          userText,
          attachments.map((doc) => doc.id),
        )
      : await findRelevantChunks(userId, userText);
    const hasAttachments = attachments.length > 0;
    const knowledge = relevantChunks.length
      ? relevantChunks
          .map(
            (chunk, index) =>
              `[资料 ${index + 1}：${chunk.documentName}]\n${chunk.content}`,
          )
          .join("\n\n")
      : "没有找到与问题相关的私有资料。";

    // 有附件时把“文件内容”放进用户消息（比只塞 system 更不容易被判成“无法访问文件”）
    const promptForModel = hasAttachments
      ? `${effectiveQuestion}\n\n【本轮上传文件的内容】\n${knowledge}`
      : effectiveQuestion;

    // 把内容/指令写回最后一条用户消息，模型才有明确的上下文与任务
    const modelMessages: UIMessage[] = parsed.data.messages.map((message) =>
      message.role === "user" && message.id === lastUserMessage?.id
        ? { ...message, parts: [{ type: "text", text: promptForModel }] }
        : message,
    );

    const systemPrompt = hasAttachments
      ? "你是 KnowFlow AI，一个严谨的中文知识库助手。用户消息末尾会附带其上传文件的内容，请直接依据这些内容完成请求，不要声称无法访问文件；只有在内容确实不包含所需信息时，才说明没有依据。回答简洁且可执行。"
      : `你是 KnowFlow AI，一个严谨的中文知识库助手。优先依据资料回答；资料不足时明确说“我在当前知识库中没有找到依据”，不要编造。回答简洁且可执行。\n\n资料片段：\n${knowledge}`;

    // 流式生成  调用大模型
    const result = streamText({
      model: AI("glm-4-flash"),
      system: systemPrompt,
      messages: await convertToModelMessages(modelMessages.slice(-12)),
      abortSignal: request.signal,
    });
    // 持久化        → 流结束后写入数据库
    const stream = toUIMessageStream({
      stream: result.stream,
      originalMessages: parsed.data.messages,
      onFinish: async ({ responseMessage, isAborted, outcome }) => {
        const partial = messageText(responseMessage).trim();
        const assistantContent =
          partial ||
          (isAborted || outcome.status === "aborted"
            ? "（已停止生成）"
            : "（生成失败，可重试）");

        try {
          await prisma.$transaction(async (tx) => {
            const existingUser = userClientId
              ? await tx.message.findUnique({
                  where: {
                    chatId_clientId: {
                      chatId: ownedChat.id,
                      clientId: userClientId,
                    },
                  },
                  select: { id: true, position: true },
                })
              : null;

            let userPosition: number;
            let userMessageId: string;
            if (existingUser) {
              userPosition = existingUser.position;
              userMessageId = existingUser.id;
            } else {
              const last = await tx.message.findFirst({
                where: { chatId: ownedChat.id },
                orderBy: { position: "desc" },
                select: { position: true },
              });
              userPosition = (last?.position ?? -1) + 1;
              const created = await tx.message.create({
                data: {
                  chatId: ownedChat.id,
                  role: "USER",
                  content: userContent,
                  position: userPosition,
                  clientId: userClientId,
                },
                select: { id: true },
              });
              userMessageId = created.id;
            }

            // 把本轮附件挂到用户消息上（同一事务，保证归属与消息一致）
            if (attachments.length) {
              await tx.document.updateMany({
                where: {
                  id: { in: attachments.map((doc) => doc.id) },
                  userId,
                },
                data: { messageId: userMessageId, chatId: ownedChat.id },
              });
            }

            const existingAssistant = assistantClientId
              ? await tx.message.findUnique({
                  where: {
                    chatId_clientId: {
                      chatId: ownedChat.id,
                      clientId: assistantClientId,
                    },
                  },
                  select: { id: true },
                })
              : null;

            if (existingAssistant) {
              await tx.message.update({
                where: { id: existingAssistant.id },
                data: { content: assistantContent },
              });
            } else {
              await tx.message.create({
                data: {
                  chatId: ownedChat.id,
                  role: "ASSISTANT",
                  content: assistantContent,
                  position: userPosition + 1,
                  clientId: assistantClientId,
                },
              });
            }

            await tx.chat.update({
              where: { id: ownedChat.id },
              data: { title: titleSeed.slice(0, 30), updatedAt: new Date() },
            });
          });
        } catch (persistError) {
          console.error("chat persistence failed", persistError);
        }
      },
      onError: (error) => {
        console.error("model stream failed", error);
        return "模型暂时不可用，请稍后重试。";
      },
    });
    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    console.error("chat failed", error);
    return Response.json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "服务暂时不可用，请稍后重试。",
        },
      },
      { status: 500 },
    );
  }
}
