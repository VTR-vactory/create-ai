import { connection } from "next/server";
import { auth } from "@/auth";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export async function GET() {
  // 放在 try 之外：预渲染时 connection() 抛出的中止信号不能被 catch 吞掉
  await connection();

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "请先登录" } },
        { status: 401 },
      );
    }
    const chats = await prisma.chat.findMany({
      where: { userId: session.user.id },
      select: { id: true, title: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json(chats);
  } catch (error) {
    console.error("chats list failed", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。" } },
      { status: 500 },
    );
  }
}

const createChatSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
});

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "请先登录" } },
        { status: 401 },
      );
    }
    const parsed = createChatSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        { error: { code: "VALIDATION_ERROR", message: "对话标题不正确。" } },
        { status: 400 },
      );
    }
    const chat = await prisma.chat.create({
      data: {
        title: parsed.data.title || "新对话",
        userId: session.user.id,
      },
      select: {
        id: true,
        title: true,
        updatedAt: true,
      },
    });

    return Response.json(chat, { status: 201 });
  } catch (error) {
    console.error("chat create failed", error);
    return Response.json(
      { error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。" } },
      { status: 500 },
    );
  }
}
