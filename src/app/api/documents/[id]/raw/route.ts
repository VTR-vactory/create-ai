import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * 返回图片附件的原始内容（缩略图/预览用）。
 * 仅允许访问自己上传的图片文档。
 */
export async function GET(_: Request, context: RouteContext) {
  const session = await auth();
  if (!session?.user?.id) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { id } = await context.params;
  const document = await prisma.document.findFirst({
    where: { id, userId: session.user.id },
    select: { content: true, mimeType: true },
  });

  if (!document || !document.mimeType?.startsWith("image/")) {
    return new Response("Not found", { status: 404 });
  }

  const bytes = Buffer.from(document.content, "base64");
  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": document.mimeType,
      "Cache-Control": "private, max-age=300",
    },
  });
}
