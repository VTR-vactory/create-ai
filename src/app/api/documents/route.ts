// src/app/api/documents/route.ts
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { indexDocument } from "@/lib/documents";
import { uploadRateLimit } from "@/lib/ratelimit";
const MAX_SIZE = 1024 * 1024;
const MAX_TOTAL_SIZE = 4 * 1024 * 1024;
const ALLOWED_TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".log"];
const MIN_TEXT_LENGTH = 30;

const chatIdSchema = z.string().cuid();

function fail(code: string, message: string, status = 400) {
  return NextResponse.json({ error: { code, message } }, { status });
}

type DocumentResult = {
  id: string;
  name: string;
  status: string;
  chunkCount: number;
  deduped: boolean;
};

export async function POST(request: Request) {
  // 兜底：任何未预期错误都返回统一结构，而不是 500 HTML
  try {
    return await handlePost(request);
  } catch (error) {
    console.error("documents upload failed", error);
    return fail("INTERNAL_ERROR", "文件处理失败，请稍后重试。", 500);
  }
}

async function handlePost(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return fail("UNAUTHORIZED", "请先登录", 401);
  }

  // ⚠️ 关键：在调用 request.formData() 解析大文件前，先做限流检查
  const limit = await uploadRateLimit.limit(session.user.id);
  if (!limit.success) {
    return Response.json(
      {
        error: { code: "RATE_LIMITED", message: "上传过于频繁，请稍后再试。" },
      },
      { status: 429 },
    );
    // 如果你需要返回 Retry-After 头，可以改用 NextResponse.json 并附带 headers
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail("BAD_REQUEST", "请求格式错误");
  }

  const files = formData.getAll("files") as File[];
  const chatIdValue = formData.get("chatId");
  let chatId: string | undefined;
  if (typeof chatIdValue === "string" && chatIdValue) {
    if (!chatIdSchema.safeParse(chatIdValue).success) {
      return fail("VALIDATION_ERROR", "chatId 格式不正确");
    }
    chatId = chatIdValue;
  }

  if (!files.length) {
    return fail("NO_FILES", "没有文件");
  }

  // 归属校验：不能把文件上传到别人的会话
  if (chatId) {
    const ownedChat = await prisma.chat.findFirst({
      where: { id: chatId, userId: session.user.id },
      select: { id: true },
    });
    if (!ownedChat) {
      return fail("NOT_FOUND", "对话不存在", 404);
    }
  }

  const totalSize = files.reduce((sum, file) => sum + file.size, 0);
  if (totalSize > MAX_TOTAL_SIZE) {
    return fail("TOTAL_TOO_LARGE", "文件总大小超过 4MB", 413);
  }

  const documents: DocumentResult[] = [];

  for (const file of files) {
    const isImage = file.type.startsWith("image/");

    if (!isImage) {
      const okExt = ALLOWED_TEXT_EXT.some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      );
      if (!okExt) {
        return fail("UNSUPPORTED_TYPE", `不支持的文件类型：${file.name}`, 415);
      }
    }

    if (file.size > MAX_SIZE) {
      return fail("FILE_TOO_LARGE", `文件太大（最大 1MB）：${file.name}`, 413);
    }

    let content: string;
    if (isImage) {
      content = Buffer.from(await file.arrayBuffer()).toString("base64");
    } else {
      content = await file.text();
      if (content.trim().length < MIN_TEXT_LENGTH) {
        return fail("CONTENT_TOO_SHORT", `文件内容太短：${file.name}`);
      }
    }

    // 内容哈希：同一用户上传相同内容的文件时复用，避免重复切块/向量化
    const contentHash = isImage
      ? null
      : createHash("sha256").update(content).digest("hex");

    if (contentHash) {
      const existing = await prisma.document.findFirst({
        where: { userId: session.user.id, contentHash },
        select: {
          id: true,
          name: true,
          status: true,
          _count: { select: { chunks: true } },
        },
      });
      if (existing) {
        documents.push({
          id: existing.id,
          name: existing.name,
          status: existing.status,
          chunkCount: existing._count.chunks,
          deduped: true,
        });
        continue;
      }
    }

    let document: { id: string; name: string; status: string };
    try {
      document = await prisma.document.create({
        data: {
          name: file.name,
          content,
          mimeType: file.type || "application/octet-stream",
          size: file.size,
          contentHash,
          status: isImage ? "READY" : "PROCESSING",
          userId: session.user.id,
          chatId,
        },
        select: { id: true, name: true, status: true },
      });
    } catch (err) {
      // 并发下同一哈希可能同时创建，命中唯一约束时回退到已存在记录
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      if (code === "P2002" && contentHash) {
        const existing = await prisma.document.findFirst({
          where: { userId: session.user.id, contentHash },
          select: {
            id: true,
            name: true,
            status: true,
            _count: { select: { chunks: true } },
          },
        });
        if (existing) {
          documents.push({
            id: existing.id,
            name: existing.name,
            status: existing.status,
            chunkCount: existing._count.chunks,
            deduped: true,
          });
          continue;
        }
      }
      throw err;
    }

    // 图片不做 embedding：base64 没有语义
    if (isImage) {
      documents.push({
        id: document.id,
        name: document.name,
        status: document.status,
        chunkCount: 0,
        deduped: false,
      });
      continue;
    }

    const indexed = await indexDocument({
      documentId: document.id,
      name: document.name,
      content,
    });

    documents.push({
      id: document.id,
      name: document.name,
      status: indexed.status,
      chunkCount: indexed.chunkCount,
      deduped: false,
    });
  }

  return NextResponse.json({ documents });
}
