import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

type RouteContext = { params: Promise<{ id: string }> };

function serverError(scope: string, error: unknown) {
  console.error(`${scope} failed`, error);
  return Response.json(
    { error: { code: "INTERNAL_ERROR", message: "服务暂时不可用，请稍后重试。" } },
    { status: 500 },
  );
}

export async function GET(_: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user?.id)
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "请先登录" } },
        { status: 401 },
      );

    const { id } = await context.params;
    const chat = await prisma.chat.findFirst({
      where: { id, userId: session.user.id },
      include: {
        messages: {
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          include: {
            attachments: { select: { id: true, name: true, mimeType: true } },
          },
        },
      },
    });
    if (!chat) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "聊天不存在" } },
        { status: 404 },
      );
    }
    return Response.json(chat);
  } catch (error) {
    return serverError("chat get", error);
  }
}

const updateChatSchema = z.object({
  title: z.string().trim().min(1, "标题不能为空").max(80, "标题过长"),
});

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "请先登录" } },
        { status: 401 },
      );
    }
    const { id } = await context.params;
    const parsed = updateChatSchema.safeParse(await request.json());
    if (!parsed.success) {
      return Response.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: parsed.error.issues[0].message,
          },
        },
        { status: 400 },
      );
    }
    const existing = await prisma.chat.findFirst({
      where: { id, userId: session.user.id },
      select: { id: true },
    });
    if (!existing) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "对话不存在。" } },
        { status: 404 },
      );
    }

    const chat = await prisma.chat.update({
      where: { id },
      data: { title: parsed.data.title },
      select: { id: true, title: true, updatedAt: true },
    });

    return Response.json(chat);
  } catch (error) {
    return serverError("chat update", error);
  }
}

export async function DELETE(_: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "请先登录" } },
        { status: 401 },
      );
    }

    const { id } = await context.params;
    const chat = await prisma.chat.deleteMany({
      where: { id, userId: session.user.id },
    });
    if (chat.count === 0) {
      return Response.json(
        { error: { code: "NOT_FOUND", message: "对话不存在。" } },
        { status: 404 },
      );
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    return serverError("chat delete", error);
  }
}
