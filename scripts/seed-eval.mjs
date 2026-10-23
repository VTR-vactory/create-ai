import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

function mimeTypeOf(name) {
  if (name.endsWith(".md")) return "text/markdown";
  if (name.endsWith(".csv")) return "text/csv";
  return "text/plain";
}

const prisma = new PrismaClient();

try {
  const corpus = [];
  for (const file of manifest.files) {
    const content = await readFile(path.join(corpusDir, file.name), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    if (sha256 !== file.sha256) {
      throw new Error(
        `${file.name} 的 sha256 与 manifest 不一致，请先更新 manifest.json`,
      );
    }
    corpus.push({ ...file, content });
  }

  const passwordHash = await hash(
    process.env.EVAL_PASSWORD ?? randomUUID(),
    10,
  );
  const user = await prisma.user.upsert({
    where: { email: EVAL_EMAIL },
    update: process.env.EVAL_PASSWORD ? { passwordHash } : {},
    create: { email: EVAL_EMAIL, name: "Eval Demo", passwordHash },
  });

  const names = corpus.map((file) => file.name);
  const hashes = corpus.map((file) => file.sha256);
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
        size: Buffer.byteLength(file.content, "utf8"),
        mimeType: mimeTypeOf(file.name),
        contentHash: file.sha256,
        status: "PROCESSING",
      },
    });

    const chunks = splitText(file.content);
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
      status,
      chunks: chunks.length,
      failed,
      id: document.id,
    });
  }

  console.log(`eval user: ${EVAL_EMAIL}`);
  console.table(rows);
  if (failedTotal > 0) {
    console.error(`完成，但有 ${failedTotal} 个 chunk 失败`);
    process.exitCode = 1;
  } else {
    console.log("完成：语料已全部就绪");
  }
} finally {
  await prisma.$disconnect();
}
