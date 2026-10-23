// src/app/api/documents/route.ts
import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { indexDocument } from "@/lib/documents";
import { extractImageText, OcrError } from "@/lib/ocr";
import { uploadRateLimit } from "@/lib/ratelimit";

// 上传后要逐块做 embedding，可能较久（Hobby 上限 60s）
export const maxDuration = 60;

const MAX_TEXT_SIZE = 1024 * 1024;
const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const MAX_TOTAL_SIZE = 8 * 1024 * 1024;
const MAX_IMAGE_FILES = 3;
const ALLOWED_TEXT_EXT = [".txt", ".md", ".markdown", ".csv", ".json", ".log"];
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
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
    return fail("TOTAL_TOO_LARGE", "文件总大小超过 8MB", 413);
  }

  const imageCount = files.filter((file) =>
    file.type.startsWith("image/"),
  ).length;
  if (imageCount > MAX_IMAGE_FILES) {
    return fail(
      "TOO_MANY_IMAGES",
      `一次最多上传 ${MAX_IMAGE_FILES} 张图片`,
    );
  }

  const documents: DocumentResult[] = [];

  for (const file of files) {
    const isImage = file.type.startsWith("image/");

    if (isImage) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        return fail(
          "UNSUPPORTED_TYPE",
          `图片仅支持 PNG/JPEG/WebP：${file.name}`,
          415,
        );
      }
    } else {
      const okExt = ALLOWED_TEXT_EXT.some((ext) =>
        file.name.toLowerCase().endsWith(ext),
      );
      if (!okExt) {
        return fail("UNSUPPORTED_TYPE", `不支持的文件类型：${file.name}`, 415);
      }
    }

    const maxSize = isImage ? MAX_IMAGE_SIZE : MAX_TEXT_SIZE;
    if (file.size > maxSize) {
      return fail(
        "FILE_TOO_LARGE",
        `文件太大（最大 ${Math.round(maxSize / 1024 / 1024)}MB）：${file.name}`,
        413,
      );
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

    // 内容哈希：同一用户上传相同内容时复用，避免重复 OCR/切块/向量化
    const contentHash = createHash("sha256").update(content).digest("hex");

    let document: { id: string; name: string; status: string } | null = null;

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
        // 只重建「0 chunk 且 READY/FAILED」的图片：
        // - READY + 0 chunk：Step 3 之前的旧图片，没有 OCR
        // - FAILED + 0 chunk：上次 OCR/索引失败
        const needsImageReprocess =
          isImage &&
          existing._count.chunks === 0 &&
          (existing.status === "FAILED" || existing.status === "READY");

        if (!needsImageReprocess) {
          documents.push({
            id: existing.id,
            name: existing.name,
            status: existing.status,
            chunkCount: existing._count.chunks,
            deduped: true,
          });
          continue;
        }

        // 原子抢占：两个并发上传只有一个能把 FAILED/READY 改成 PROCESSING
        const claimed = await prisma.document.updateMany({
          where: {
            id: existing.id,
            status: { in: ["FAILED", "READY"] },
            chunks: { none: {} },
          },
          data: {
            kind: "IMAGE",
            status: "PROCESSING",
            error: null,
            failedChunks: 0,
            ocrText: null,
            ocrProvider: null,
          },
        });

        if (claimed.count === 0) {
          const current = await prisma.document.findUnique({
            where: { id: existing.id },
            select: {
              id: true,
              name: true,
              status: true,
              _count: { select: { chunks: true } },
            },
          });

          if (current) {
            documents.push({
              id: current.id,
              name: current.name,
              status: current.status,
              chunkCount: current._count.chunks,
              deduped: true,
            });
            continue;
          }
        } else {
          document = {
            id: existing.id,
            name: existing.name,
            status: "PROCESSING",
          };
        }
      }
    }

    if (!document) {
      try {
        document = await prisma.document.create({
          data: {
            name: file.name,
            content,
            mimeType: file.type || "application/octet-stream",
            size: file.size,
            kind: isImage ? "IMAGE" : "TEXT",
            contentHash,
            status: "PROCESSING",
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
    }

    // 图片：先把图片文字识别成文本，再用文本走切块 / embedding
    if (isImage) {
      try {
        const ocr = await extractImageText(content, {
          // 上传接口是同步的，给 OCR + embedding 留出时间（maxDuration=60s）
          timeoutMs: 12_000,
          retryDelayMs: 1_500,
        });

        await prisma.document.update({
          where: { id: document.id },
          data: {
            ocrText: ocr.text,
            ocrProvider: ocr.provider,
          },
        });

        const indexed = await indexDocument({
          documentId: document.id,
          name: document.name,
          content: ocr.text,
        });

        documents.push({
          id: document.id,
          name: document.name,
          status: indexed.status,
          chunkCount: indexed.chunkCount,
          deduped: false,
        });
      } catch (error) {
        const message =
          error instanceof OcrError ? error.message : "图片文字识别或索引失败";

        console.error("[documents] image OCR failed", {
          documentId: document.id,
          code: error instanceof OcrError ? error.code : "UNKNOWN",
        });

        await prisma.document.update({
          where: { id: document.id },
          data: {
            status: "FAILED",
            error: message,
            failedChunks: 0,
          },
        });

        documents.push({
          id: document.id,
          name: document.name,
          status: "FAILED",
          chunkCount: 0,
          deduped: false,
        });
      }

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
