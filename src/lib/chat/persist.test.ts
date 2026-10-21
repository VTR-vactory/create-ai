import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: { $transaction: vi.fn() },
}));

import { prisma } from "@/lib/prisma";
import { persistTurn } from "./persist";

const tx = {
  message: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  document: { updateMany: vi.fn() },
  chat: { update: vi.fn(), findUnique: vi.fn() },
};

const transactionMock = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

const base = {
  chatId: "chat-1",
  userId: "user-1",
  userClientId: "u-client",
  assistantClientId: "u-client::assistant",
  userContent: "问题",
  assistantContent: "回答",
  attachmentIds: ["doc-1"],
  titleSeed: "问题",
};

beforeEach(() => {
  vi.resetAllMocks();
  transactionMock.mockImplementation(
    async (fn: (t: typeof tx) => unknown) => fn(tx),
  );
  tx.chat.findUnique.mockResolvedValue({ titleAuto: true });
  // 分配计数器时返回 messageSeq=2；更新标题时返回空对象
  tx.chat.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) =>
      "messageSeq" in data ? { messageSeq: 2 } : {},
  );
});

describe("persistTurn", () => {
  it("新一轮：原子分配 position，写用户/助手并挂接附件", async () => {
    tx.message.findUnique.mockResolvedValue(null);
    tx.message.create.mockResolvedValue({ id: "user-msg" });

    await persistTurn(base);

    const creates = tx.message.create.mock.calls.map(
      (call) => call[0].data as Record<string, unknown>,
    );
    expect(creates[0]).toMatchObject({ role: "USER", position: 0 });
    expect(creates[1]).toMatchObject({ role: "ASSISTANT", position: 1 });

    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["doc-1"] }, userId: "user-1" },
      data: { messageId: "user-msg", chatId: "chat-1" },
    });

    const titleCall = tx.chat.update.mock.calls.find(
      (call) => "title" in (call[0].data as Record<string, unknown>),
    );
    expect(titleCall?.[0].data).toMatchObject({ title: "问题" });
  });

  it("重试：复用 position，不消耗计数器，只更新内容", async () => {
    tx.message.findUnique
      .mockResolvedValueOnce({ id: "u1", position: 4, content: "旧问题" })
      .mockResolvedValueOnce({ id: "a1" });

    await persistTurn({
      ...base,
      userContent: "新问题",
      assistantContent: "新回答",
    });

    expect(tx.message.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { content: "新问题" },
    });
    expect(tx.message.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({ content: "新回答" }),
      }),
    );
    expect(tx.message.create).not.toHaveBeenCalled();

    const seqCalls = tx.chat.update.mock.calls.filter(
      (call) => "messageSeq" in (call[0].data as Record<string, unknown>),
    );
    expect(seqCalls).toHaveLength(0);
  });

  it("titleAuto=false 时不覆盖标题", async () => {
    tx.message.findUnique.mockResolvedValue(null);
    tx.message.create.mockResolvedValue({ id: "u" });
    tx.chat.findUnique.mockResolvedValue({ titleAuto: false });

    await persistTurn(base);

    const titleCalls = tx.chat.update.mock.calls.filter(
      (call) => "title" in (call[0].data as Record<string, unknown>),
    );
    expect(titleCalls).toHaveLength(0);
  });

  it("事务失败只记录日志，不向调用方抛错", async () => {
    transactionMock.mockImplementation(async () => {
      throw new Error("db down");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(persistTurn(base)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();

    spy.mockRestore();
  });
});
