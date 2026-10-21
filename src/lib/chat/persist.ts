import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { SourceLink } from "./types";

export type PersistTurnInput = {
  chatId: string;
  userId: string;
  /** 客户端用户消息 id（用于幂等） */
  userClientId: string | null;
  /** 助手消息幂等键（`${userClientId}::assistant`） */
  assistantClientId: string | null;
  /** 用户真正输入的文字（纯附件时为空） */
  userContent: string;
  /** 助手回答（已生成部分 / 占位文案） */
  assistantContent: string;
  attachmentIds: string[];
  titleSeed: string;
  /** 联网来源（没有则为空数组），随助手消息持久化以便历史可追溯 */
  sources?: SourceLink[];
};

/**
 * 一次问答的落库（在流结束时调用）。
 *
 * 事务内保证：
 * 1. 幂等：同一 clientId 重试不会重复插入，内容变化时同步
 * 2. 顺序：Chat 行锁 + messageSeq 原子分配，避免 position 竞态
 * 3. 归属：本轮附件挂到同一条用户消息上
 * 4. 标题：仅在 titleAuto 时自动命名，不冲掉用户手动重命名
 *
 * 失败只记录日志，不影响已经返回给客户端的流。
 */
export async function persistTurn(input: PersistTurnInput): Promise<void> {
  const {
    chatId,
    userId,
    userClientId,
    assistantClientId,
    userContent,
    assistantContent,
    attachmentIds,
    titleSeed,
    sources = [],
  } = input;

  const sourcesJson: Prisma.InputJsonValue | typeof Prisma.DbNull =
    sources.length
      ? (sources as unknown as Prisma.InputJsonValue)
      : Prisma.DbNull;

  try {
    await prisma.$transaction(async (tx) => {
      const existingUser = userClientId
        ? await tx.message.findUnique({
            where: {
              chatId_clientId: { chatId, clientId: userClientId },
            },
            select: { id: true, position: true, content: true },
          })
        : null;

      let userPosition: number;
      let userMessageId: string;

      if (existingUser) {
        // 重试/重新生成：复用位置，不消耗计数器
        userPosition = existingUser.position;
        userMessageId = existingUser.id;

        // 用户可能在重试前编辑过问题，内容变化时同步
        if (existingUser.content !== userContent) {
          await tx.message.update({
            where: { id: userMessageId },
            data: { content: userContent },
          });
        }
      } else {
        // 原子分配：Chat 行锁保证并发下不会拿到重复 position。
        // 每轮固定占 2 个号：用户 = n-2，助手 = n-1。
        const seq = await tx.chat.update({
          where: { id: chatId },
          data: { messageSeq: { increment: 2 } },
          select: { messageSeq: true },
        });
        userPosition = seq.messageSeq - 2;
        const created = await tx.message.create({
          data: {
            chatId,
            role: "USER",
            content: userContent,
            position: userPosition,
            clientId: userClientId,
          },
          select: { id: true },
        });
        userMessageId = created.id;
      }

      // 本轮附件挂到用户消息上（同一事务，保证归属与消息一致）
      if (attachmentIds.length) {
        await tx.document.updateMany({
          where: { id: { in: attachmentIds }, userId },
          data: { messageId: userMessageId, chatId },
        });
      }

      const existingAssistant = assistantClientId
        ? await tx.message.findUnique({
            where: {
              chatId_clientId: { chatId, clientId: assistantClientId },
            },
            select: { id: true },
          })
        : null;

      if (existingAssistant) {
        await tx.message.update({
          where: { id: existingAssistant.id },
          data: { content: assistantContent, sources: sourcesJson },
        });
      } else {
        await tx.message.create({
          data: {
            chatId,
            role: "ASSISTANT",
            content: assistantContent,
            position: userPosition + 1,
            clientId: assistantClientId,
            sources: sourcesJson,
          },
        });
      }

      const currentChat = await tx.chat.findUnique({
        where: { id: chatId },
        select: { titleAuto: true },
      });

      // 只在仍处于「自动命名」时覆盖标题，避免冲掉用户手动重命名
      await tx.chat.update({
        where: { id: chatId },
        data: currentChat?.titleAuto
          ? { title: titleSeed.slice(0, 30), updatedAt: new Date() }
          : { updatedAt: new Date() },
      });
    });
  } catch (persistError) {
    console.error("chat persistence failed", persistError);
  }
}
