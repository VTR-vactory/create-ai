import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";
import { Prisma, PrismaClient } from "@prisma/client";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const file of [".env.local", ".env"]) {
  try {
    loadEnvFile(path.join(root, file));
  } catch {
    // 本地没有该文件时跳过
  }
}

const corpusDir = path.join(root, "eval", "corpus");
const evalDir = path.join(root, "eval");
const manifest = JSON.parse(
  await readFile(path.join(corpusDir, "manifest.json"), "utf8"),
);
const MAX_DISTANCE = 0.55;
const TOP_K = 5;
const EVAL_EMAIL = "eval@lumendesk.local";
const baseUrl =
  process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/paas/v4";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL 未配置");
  process.exit(1);
}
if (!process.env.ZHIPU_API_KEY) {
  console.error("ZHIPU_API_KEY 未配置");
  process.exit(1);
}

async function createEmbedding(input) {
  const response = await fetch(`${baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ZHIPU_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "embedding-3", input, dimensions: 1024 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
  const data = await response.json();
  const embedding = data?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) throw new Error("embedding response has no vector");
  return embedding;
}

function splitText(text, size, overlap) {
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

const prisma = new PrismaClient();

try {
  const datasets = (
    await readFile(path.join(evalDir, "dataset.jsonl"), "utf8")
  )
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const user = await prisma.user.findUnique({ where: { email: EVAL_EMAIL } });
  if (!user) throw new Error(`评测用户不存在，先运行 npm run seed:eval`);

  const docs = await prisma.document.findMany({
    where: { userId: user.id },
    select: { id: true, name: true, status: true },
  });
  const byName = new Map(docs.map((doc) => [doc.name, doc]));

  for (const file of manifest.files) {
    const doc = byName.get(file.name);
    const expectedChunks = splitText(
      await readFile(path.join(corpusDir, file.name), "utf8"),
      manifest.chunkSize,
      manifest.chunkOverlap,
    ).length;
    const actualChunks = await prisma.documentChunk.count({
      where: { documentId: doc?.id },
    });
    if (!doc || doc.status !== "READY" || actualChunks !== expectedChunks) {
      throw new Error(
        `${file.name} 状态异常：status=${doc?.status} chunks=${actualChunks}/${expectedChunks}`,
      );
    }
  }

  const rows = [];
  for (const item of datasets) {
    const vector = await createEmbedding(item.question);
    const vectorStr = `[${vector.join(",")}]`;
    const attachmentIds = (item.attachmentNames ?? [])
      .map((name) => byName.get(name)?.id)
      .filter(Boolean);

    const result = attachmentIds.length
      ? await prisma.$queryRaw`
          SELECT dc.content, d.name AS "documentName"
          FROM "DocumentChunk" dc
          JOIN "Document" d ON dc."documentId" = d.id
          WHERE d."userId" = ${user.id}
            AND dc."documentId" IN (${Prisma.join(attachmentIds)})
            AND dc.embedding <=> ${vectorStr}::vector <= ${MAX_DISTANCE}
          ORDER BY dc.embedding <=> ${vectorStr}::vector
          LIMIT ${TOP_K}
        `
      : await prisma.$queryRaw`
          SELECT dc.content, d.name AS "documentName"
          FROM "DocumentChunk" dc
          JOIN "Document" d ON dc."documentId" = d.id
          WHERE d."userId" = ${user.id}
            AND dc.embedding <=> ${vectorStr}::vector <= ${MAX_DISTANCE}
          ORDER BY dc.embedding <=> ${vectorStr}::vector
          LIMIT ${TOP_K}
        `;

    const hitDocs = result.map((row) => row.documentName);
    const joined = result.map((row) => row.content).join("\n");
    const expectedHit =
      item.expectedDocNames.length > 0 &&
      item.expectedDocNames.some((name) => hitDocs.includes(name));
    const keywordHit =
      !item.expectedKeywords?.length ||
      item.expectedKeywords.every((keyword) => joined.includes(keyword));
    const isolationOk =
      item.scope !== "attachment" ||
      hitDocs.every((name) => item.attachmentNames.includes(name));
    const refused = result.length === 0;
    const pass = item.shouldAnswer
      ? expectedHit && keywordHit && isolationOk
      : refused;

    rows.push({
      id: item.id,
      scope: item.scope,
      shouldAnswer: item.shouldAnswer,
      hits: result.length,
      hitDocs: [...new Set(hitDocs)].join(",") || "-",
      expectedHit,
      keywordHit,
      isolationOk,
      pass,
    });
  }

  console.table(rows);
  const answerable = rows.filter((row) => row.shouldAnswer);
  const refusal = rows.filter((row) => !row.shouldAnswer);
  const passed = rows.filter((row) => row.pass).length;
  console.log(`\n通过: ${passed}/${rows.length}`);
  console.log(
    `可回答命中: ${answerable.filter((row) => row.expectedHit).length}/${answerable.length}`,
  );
  console.log(
    `关键词命中: ${answerable.filter((row) => row.keywordHit).length}/${answerable.length}`,
  );
  console.log(
    `拒答正确: ${refusal.filter((row) => row.pass).length}/${refusal.length}`,
  );
  console.log(
    `附件隔离: ${rows.filter((row) => row.scope === "attachment" && row.isolationOk).length}/${
      rows.filter((row) => row.scope === "attachment").length
    }`,
  );
  if (passed !== rows.length) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
