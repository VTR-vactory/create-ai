import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 返回文档原始内容：
 * - 图片：原始二进制，供预览/引用打开
 * - 文本：text/plain，供引用打开原文
 * 仅允许访问自己上传的文档。
 */
export async function GET(_: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await context.params;
  const document = await prisma.document.findFirst({
    where: { id, userId: session.user.id },
    select: { content: true, mimeType: true, kind: true },
  });

  if (!document) {
    return new Response("Not found", { status: 404 });
  }

  const isImage =
    document.kind === "IMAGE" || document.mimeType?.startsWith("image/");

  if (isImage) {
    const bytes = Buffer.from(document.content, "base64");
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": document.mimeType ?? "application/octet-stream",
        "Cache-Control": "private, max-age=300",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  return new Response(document.content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, max-age=300",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
