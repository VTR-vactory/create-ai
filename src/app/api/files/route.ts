import { connection } from "next/server";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/http";

export async function GET() {
  // 必须放在 try 之外：预渲染阶段 connection() 会抛出“中止预渲染”的特殊信号，
  // 被 try/catch 捕获会导致 Next 无法切换到请求时渲染，并报
  // "connection() rejects when the prerender is complete"。
  await connection();

  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiError("UNAUTHORIZED", "请先登录", 401);
    }

    const files = await prisma.document.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        name: true,
        createdAt: true,
        size: true,
        mimeType: true,
        status: true,
        _count: { select: { chunks: true } },
      },
      // orderBy 是 findMany 的顶层参数，不能写在 select 里
      orderBy: { createdAt: "desc" },
    });

    return Response.json(
      files.map((file) => ({
        id: file.id,
        name: file.name,
        createdAt: file.createdAt,
        size: file.size ?? 0,
        mimeType: file.mimeType ?? "",
        status: file.status,
        chunkCount: file._count.chunks,
      })),
    );
  } catch (error) {
    console.error("files list failed", error);
    return apiError("INTERNAL_ERROR", "服务暂时不可用，请稍后重试。", 500);
  }
}

const batchDeleteSchema = z.object({
  ids: z.array(z.string().cuid()).min(1).max(100),
});

/** DELETE /api/files —— 批量删除自己的文件（body: { ids: string[] }） */
export async function DELETE(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiError("UNAUTHORIZED", "请先登录", 401);
    }

    const parsed = batchDeleteSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      return apiError("VALIDATION_ERROR", "请选择要删除的文件。");
    }

    // 必须同时约束 id + userId，避免删除他人文件
    const result = await prisma.document.deleteMany({
      where: {
        id: { in: parsed.data.ids },
        userId: session.user.id,
      },
    });

    return Response.json({ deleted: result.count });
  } catch (error) {
    console.error("files batch delete failed", error);
    return apiError("INTERNAL_ERROR", "批量删除失败，请稍后重试。", 500);
  }
}
