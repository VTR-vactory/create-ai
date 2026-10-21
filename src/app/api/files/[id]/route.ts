import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/http";

type RouteContext = { params: Promise<{ id: string }> };

/** DELETE /api/files/[id] —— 删除自己的一个文件（DocumentChunk 级联删除） */
export async function DELETE(_: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return apiError("UNAUTHORIZED", "请先登录", 401);
    }

    const { id } = await context.params;

    // 必须同时约束 id + userId，避免删除他人文件
    const result = await prisma.document.deleteMany({
      where: { id, userId: session.user.id },
    });

    if (result.count === 0) {
      return apiError("NOT_FOUND", "文件不存在。", 404);
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("file delete failed", error);
    return apiError("INTERNAL_ERROR", "删除失败，请稍后重试。", 500);
  }
}
