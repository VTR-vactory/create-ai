import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnvFile } from "node:process";
import { hash } from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) {
  try {
    loadEnvFile(path.join(root, file));
  } catch {
    // 本地没有该文件时跳过
  }
}

const corpusDir = path.join(root, "eval", "corpus");
const manifest = JSON.parse(
  await readFile(path.join(corpusDir, "manifest.json"), "utf8"),
);
const CHUNK_SIZE = manifest.chunkSize ?? 800;
const CHUNK_OVERLAP = manifest.chunkOverlap ?? 120;
const EMBEDDING_TIMEOUT_MS = 15_000;
const EVAL_EMAIL = "eval@lumendesk.local";
const DEFAULT_DEMO_PASSWORD = "12345678";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL 未配置");
  process.exit(1);
}
if (!process.env.ZHIPU_API_KEY) {
  console.error("ZHIPU_API_KEY 未配置，无法生成 embedding");
  process.exit(1);
}

const baseUrl =
  process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";

const { extractImageText, OcrError } = await import(
  pathToFileURL(path.join(root, "src", "lib", "ocr.ts")).href
);

function splitText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    const end = Math.min(start + size, normalized.length);
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === normalized.length) break;
    start = end - overlap;
  }
  return chunks;
}

async function createEmbedding(input) {
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ZHIPU_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "embedding-3", input, dimensions: 1024 }),
    signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`embedding HTTP ${response.status}`);
  }
  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error("embedding response has no vector");
  }
  return embedding;
}

function mimeTypeOf(file) {
  if (file.mimeType) return file.mimeType;
  if (file.name.endsWith(".md")) return "text/markdown";
  if (file.name.endsWith(".csv")) return "text/csv";
  if (file.name.endsWith(".png")) return "image/png";
  return "text/plain";
}

const prisma = new PrismaClient();

try {
  const corpus = [];
  for (const file of manifest.files) {
    const raw = await readFile(path.join(corpusDir, file.name));
    const kind = file.kind === "IMAGE" ? "IMAGE" : "TEXT";
    const content = kind === "IMAGE" ? raw.toString("base64") : raw.toString("utf8");
    const rawHash = createHash("sha256").update(raw).digest("hex");

    if (rawHash !== file.sha256) {
      throw new Error(
        `${file.name} 的 sha256 与 manifest 不一致，请先更新 manifest.json`,
      );
    }

    corpus.push({
      ...file,
      kind,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      size: raw.byteLength,
    });
  }

  const password = process.env.EVAL_PASSWORD ?? DEFAULT_DEMO_PASSWORD;
  const passwordHash = await hash(password, 10);
  const user = await prisma.user.upsert({
    where: { email: EVAL_EMAIL },
    update: { passwordHash },
    create: { email: EVAL_EMAIL, name: "Eval Demo", passwordHash },
  });

  const names = corpus.map((file) => file.name);
  const hashes = corpus.map((file) => file.contentHash);
  await prisma.document.deleteMany({
    where: {
      userId: user.id,
      OR: [{ name: { in: names } }, { contentHash: { in: hashes } }],
    },
  });

  let failedTotal = 0;
  const rows = [];

  for (const file of corpus) {
    const document = await prisma.document.create({
      data: {
        userId: user.id,
        name: file.name,
        content: file.content,
        size: file.size,
        kind: file.kind,
        mimeType: mimeTypeOf(file),
        contentHash: file.contentHash,
        status: "PROCESSING",
      },
    });

    let textContent = file.content;

    if (file.kind === "IMAGE") {
      try {
        const models = [
          process.env.ZHIPU_OCR_MODEL ?? "glm-4.6v-flash",
          "glm-4v-flash",
        ];
        let ocr = null;
        let lastError = null;

        for (const model of models) {
          try {
            ocr = await extractImageText(file.content, {
              model,
              maxAttempts: 2,
              timeoutMs: 12_000,
              retryDelayMs: 1_500,
            });
            break;
          } catch (error) {
            lastError = error;
            if (
              error instanceof OcrError &&
              error.code === "OCR_RATE_LIMITED"
            ) {
              console.warn(`[seed-eval] ${model} 限流，尝试下一个免费模型`);
              continue;
            }
            throw error;
          }
        }

        if (!ocr) throw lastError;

        textContent = ocr.text;
        await prisma.document.update({
          where: { id: document.id },
          data: { ocrText: ocr.text, ocrProvider: ocr.provider },
        });
      } catch (error) {
        const message =
          error instanceof OcrError ? error.message : "图片 OCR 失败";
        await prisma.document.update({
          where: { id: document.id },
          data: { status: "FAILED", error: message, failedChunks: 0 },
        });
        console.error(`[seed-eval] ${file.name} OCR failed:`, message);
        failedTotal += 1;
        rows.push({
          name: file.name,
          kind: file.kind,
          status: "FAILED",
          chunks: 0,
          failed: 0,
          id: document.id,
        });
        continue;
      }
    }

    const chunks = splitText(textContent);
    let failed = 0;
    let firstError = null;

    for (const [index, chunk] of chunks.entries()) {
      try {
        const embedding = await createEmbedding(chunk);
        const vector = `[${embedding.join(",")}]`;
        await prisma.$executeRaw`
          INSERT INTO "DocumentChunk" ("id", "documentId", "content", "embedding", "createdAt")
          VALUES (gen_random_uuid(), ${document.id}, ${chunk}, ${vector}::vector, NOW())
        `;
      } catch (error) {
        failed += 1;
        firstError ??= error instanceof Error ? error.message : String(error);
        console.error(`[seed-eval] ${file.name} chunk ${index} failed:`, firstError);
      }
    }

    const status =
      chunks.length === 0 || failed === 0
        ? "READY"
        : failed === chunks.length
          ? "FAILED"
          : "PARTIAL";

    await prisma.document.update({
      where: { id: document.id },
      data: { status, failedChunks: failed, error: firstError },
    });

    failedTotal += failed;
    rows.push({
      name: file.name,
      kind: file.kind,
      status,
      chunks: chunks.length,
      failed,
      id: document.id,
    });
  }

  console.log(`eval user: ${EVAL_EMAIL}`);
  console.log(
    `demo password: ${process.env.EVAL_PASSWORD ? "EVAL_PASSWORD" : DEFAULT_DEMO_PASSWORD}`,
  );
  console.table(rows);
  if (failedTotal > 0) {
    console.error(`完成，但有 ${failedTotal} 个失败项`);
    process.exitCode = 1;
  } else {
    console.log("完成：语料已全部就绪");
  }
} finally {
  await prisma.$disconnect();
}
