import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const evalDir = path.join(root, "eval");
const corpusDir = path.join(evalDir, "corpus");
const manifest = JSON.parse(
  await readFile(path.join(corpusDir, "manifest.json"), "utf8"),
);
const datasetRaw = await readFile(path.join(evalDir, "dataset.jsonl"), "utf8");
const datasets = datasetRaw
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const MAX_DISTANCE = 0.55;
const TOP_K = 5;
const EVAL_EMAIL = "eval@lumendesk.local";
const JUDGE_MODEL = process.env.ZHIPU_JUDGE_MODEL ?? "glm-4-flash";
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

const { judgeAnswerable } = await import(
  pathToFileURL(path.join(root, "src", "lib", "chat", "judge.ts")).href
);

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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
  if (!Array.isArray(embedding)) {
    throw new Error("embedding response has no vector");
  }
  return embedding;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[index];
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function cell(value) {
  return String(value).replaceAll("|", "\\|");
}

const prisma = new PrismaClient();
let exitCode = 0;

try {
  const user = await prisma.user.findUnique({ where: { email: EVAL_EMAIL } });
  if (!user) throw new Error("评测用户不存在，先运行 npm run seed:eval");

  const docs = await prisma.document.findMany({
    where: { userId: user.id },
    select: { id: true, name: true, status: true, ocrText: true },
  });
  const byName = new Map(docs.map((doc) => [doc.name, doc]));

  for (const file of manifest.files) {
    const doc = byName.get(file.name);
    const actualChunks = await prisma.documentChunk.count({
      where: { documentId: doc?.id },
    });

    if (file.kind === "IMAGE") {
      if (!doc || doc.status !== "READY" || !doc.ocrText?.trim() || actualChunks < 1) {
        throw new Error(
          `${file.name} 状态异常：status=${doc?.status} chunks=${actualChunks} ocr=${Boolean(doc?.ocrText?.trim())}`,
        );
      }
      continue;
    }

    const expectedChunks = splitText(
      await readFile(path.join(corpusDir, file.name), "utf8"),
      manifest.chunkSize,
      manifest.chunkOverlap,
    ).length;

    if (!doc || doc.status !== "READY" || actualChunks !== expectedChunks) {
      throw new Error(
        `${file.name} 状态异常：status=${doc?.status} chunks=${actualChunks}/${expectedChunks}`,
      );
    }
  }

  const rows = [];
  for (const item of datasets) {
    const embedStartedAt = Date.now();
    const vector = await createEmbedding(item.question);
    const embedMs = Date.now() - embedStartedAt;
    const vectorStr = `[${vector.join(",")}]`;
    const attachmentIds = (item.attachmentNames ?? [])
      .map((name) => byName.get(name)?.id)
      .filter(Boolean);

    const retrievalStartedAt = Date.now();
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
    const retrievalMs = Date.now() - retrievalStartedAt;

    const chunks = result.map((row) => ({
      content: row.content,
      documentName: row.documentName,
    }));
    const hitDocs = [...new Set(result.map((row) => row.documentName))];
    const joined = result.map((row) => row.content).join("\n");

    let judge = null;
    let judgeError = null;
    if (chunks.length) {
      try {
        judge = await judgeAnswerable({
          question: item.question,
          chunks,
        });
      } catch (error) {
        judgeError =
          error instanceof Error ? error.message : String(error);
      }
    }

    const effectiveAnswerable =
      chunks.length > 0 && (judge ? judge.answerable : true);
    const rank = item.expectedDocNames.length
      ? result.findIndex((row) =>
          item.expectedDocNames.includes(row.documentName),
        )
      : -1;
    const retrievalHit = rank >= 0;
    const keywordHit =
      !item.expectedKeywords?.length ||
      item.expectedKeywords.every((keyword) => joined.includes(keyword));
    const isolationOk =
      item.scope !== "attachment" ||
      hitDocs.every((name) => item.attachmentNames.includes(name));
    const pass = item.shouldAnswer
      ? retrievalHit && keywordHit && effectiveAnswerable && isolationOk
      : !effectiveAnswerable;

    rows.push({
      ...item,
      hitDocs,
      hitCount: result.length,
      rank,
      retrievalHit,
      keywordHit,
      isolationOk,
      judgeAnswerable: judge?.answerable ?? null,
      judgeReason: judge?.reason ?? "",
      judgeError,
      judgeMs: judge?.latencyMs ?? null,
      promptTokens: judge?.promptTokens ?? 0,
      completionTokens: judge?.completionTokens ?? 0,
      effectiveAnswerable,
      embedMs,
      retrievalMs,
      pass,
    });
  }

  const answerableRows = rows.filter((row) => row.shouldAnswer);
  const refusalRows = rows.filter((row) => !row.shouldAnswer);
  const attachmentRows = rows.filter((row) => row.scope === "attachment");
  const judgeRows = rows.filter((row) => row.judgeMs !== null);

  const metrics = {
    total: rows.length,
    retrievalRecall:
      answerableRows.filter((row) => row.retrievalHit).length /
      answerableRows.length,
    mrr:
      answerableRows.reduce(
        (sum, row) => sum + (row.rank >= 0 ? 1 / (row.rank + 1) : 0),
        0,
      ) / answerableRows.length,
    keywordHitRate:
      answerableRows.filter((row) => row.keywordHit).length /
      answerableRows.length,
    refusalAccuracy:
      refusalRows.filter((row) => !row.effectiveAnswerable).length /
      refusalRows.length,
    falseRefusalRate:
      answerableRows.filter((row) => !row.effectiveAnswerable).length /
      answerableRows.length,
    judgeAccuracy:
      rows.filter((row) => row.effectiveAnswerable === row.shouldAnswer)
        .length / rows.length,
    isolationRate:
      attachmentRows.filter((row) => row.isolationOk).length /
      attachmentRows.length,
    judgeCallRate: judgeRows.length / rows.length,
    retrievalP50Ms: percentile(
      rows.map((row) => row.retrievalMs),
      0.5,
    ),
    retrievalP95Ms: percentile(
      rows.map((row) => row.retrievalMs),
      0.95,
    ),
    judgeP50Ms: percentile(
      judgeRows.map((row) => row.judgeMs),
      0.5,
    ),
    judgeP95Ms: percentile(
      judgeRows.map((row) => row.judgeMs),
      0.95,
    ),
    promptTokens: rows.reduce((sum, row) => sum + row.promptTokens, 0),
    completionTokens: rows.reduce(
      (sum, row) => sum + row.completionTokens,
      0,
    ),
  };

  const gates = [
    {
      name: "Recall@5",
      value: metrics.retrievalRecall,
      display: percent(metrics.retrievalRecall),
      target: ">= 80%",
      pass: metrics.retrievalRecall >= 0.8,
    },
    {
      name: "MRR",
      value: metrics.mrr,
      display: metrics.mrr.toFixed(3),
      target: ">= 0.6",
      pass: metrics.mrr >= 0.6,
    },
    {
      name: "拒答准确率",
      value: metrics.refusalAccuracy,
      display: percent(metrics.refusalAccuracy),
      target: ">= 90%",
      pass: metrics.refusalAccuracy >= 0.9,
    },
    {
      name: "误拒率",
      value: metrics.falseRefusalRate,
      display: percent(metrics.falseRefusalRate),
      target: "<= 10%",
      pass: metrics.falseRefusalRate <= 0.1,
    },
    {
      name: "附件隔离",
      value: metrics.isolationRate,
      display: percent(metrics.isolationRate),
      target: "100%",
      pass: metrics.isolationRate === 1,
    },
  ];
  const allGatesPassed = gates.every((gate) => gate.pass);

  const datasetId = sha256(datasetRaw).slice(0, 12);
  const generatedAt = new Date().toISOString();

  const failureRows = rows.filter((row) => !row.pass);
  const reportLines = [
    "# RAG 评测报告",
    "",
    `- 时间：${generatedAt}`,
    `- 数据集：\`eval/dataset.jsonl\`（sha256: \`${datasetId}\`，${rows.length} 条）`,
    `- 语料：${manifest.files.map((file) => `\`${file.name}\``).join("、")}`,
    `- 参数：chunk ${manifest.chunkSize}/${manifest.chunkOverlap}，Top-${TOP_K}，距离阈值 ${MAX_DISTANCE}`,
    `- judge：\`${JUDGE_MODEL}\`（失败时 fail-open）`,
    "",
    "## 结论",
    "",
    "| 指标 | 结果 | 目标 | 状态 |",
    "|---|---|---|---|",
    ...gates.map(
      (gate) =>
        `| ${gate.name} | ${gate.display} | ${gate.target} | ${gate.pass ? "通过" : "未通过"} |`,
    ),
    `| judge 准确率 | ${percent(metrics.judgeAccuracy)} | - | - |`,
    `| 关键词命中率 | ${percent(metrics.keywordHitRate)} | - | - |`,
    `| judge 调用率 | ${percent(metrics.judgeCallRate)} | - | - |`,
    "",
    "## 延迟与 token",
    "",
    "| 指标 | P50 | P95 |",
    "|---|---|---|",
    `| 检索（ms） | ${metrics.retrievalP50Ms} | ${metrics.retrievalP95Ms} |`,
    `| judge（ms） | ${metrics.judgeP50Ms} | ${metrics.judgeP95Ms} |`,
    "",
    `judge token 合计：prompt ${metrics.promptTokens} / completion ${metrics.completionTokens}`,
    "",
    "## 逐条结果",
    "",
    "| ID | scope | 应回答 | 命中片段 | 期望排名 | 关键词 | judge | 有效可答 | 隔离 | 结果 |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      [
        row.id,
        row.scope,
        row.shouldAnswer ? "是" : "否",
        row.hitCount,
        row.retrievalHit ? String(row.rank + 1) : "-",
        row.expectedKeywords?.length ? (row.keywordHit ? "✓" : "✗") : "-",
        row.judgeAnswerable === null
          ? row.judgeError
            ? "error"
            : "-"
          : String(row.judgeAnswerable),
        row.effectiveAnswerable ? "是" : "否",
        row.isolationOk ? "✓" : "✗",
        row.pass ? "✓" : "✗",
      ]
        .map(cell)
        .join(" | "),
    ).map((line) => `| ${line} |`),
    "",
  ];

  if (failureRows.length) {
    reportLines.push("## 失败用例", "");
    for (const row of failureRows) {
      reportLines.push(
        `### ${row.id}`,
        "",
        `- 问题：${row.question}`,
        `- 期望：${row.shouldAnswer ? "可回答" : "应拒答"}`,
        `- 命中：${row.hitDocs.join(", ") || "无"}`,
        `- 期望文档：${row.expectedDocNames.join(", ") || "无"}`,
        `- judge：${row.judgeAnswerable ?? "未调用"}${row.judgeReason ? `（${row.judgeReason}）` : ""}`,
        row.judgeError ? `- judge 错误：${row.judgeError}` : "",
        "",
      );
    }
  }

  reportLines.push(
    "## 说明",
    "",
    "- 拒答以 judge 判定为准；judge 失败按 fail-open 视为可回答。",
    "- 本评测不调用生成模型，因此不衡量最终答案的忠实度；下一步可加 groundedness / 引用准确率。",
    "- 语料或数据集变更后，先更新 manifest 并重新 `npm run seed:eval`。",
    "",
  );

  await mkdir(evalDir, { recursive: true });
  await writeFile(
    path.join(evalDir, "report.md"),
    reportLines.join("\n") + "\n",
    "utf8",
  );
  await writeFile(
    path.join(evalDir, "last-run.json"),
    JSON.stringify(
      {
        generatedAt,
        datasetId,
        config: {
          chunkSize: manifest.chunkSize,
          chunkOverlap: manifest.chunkOverlap,
          topK: TOP_K,
          maxDistance: MAX_DISTANCE,
          judgeModel: JUDGE_MODEL,
        },
        metrics,
        gates,
        rows: rows.map((row) => ({
          id: row.id,
          scope: row.scope,
          shouldAnswer: row.shouldAnswer,
          hitDocs: row.hitDocs,
          hitCount: row.hitCount,
          rank: row.rank,
          keywordHit: row.keywordHit,
          judgeAnswerable: row.judgeAnswerable,
          judgeReason: row.judgeReason,
          judgeError: row.judgeError,
          effectiveAnswerable: row.effectiveAnswerable,
          isolationOk: row.isolationOk,
          pass: row.pass,
        })),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`Recall@5: ${percent(metrics.retrievalRecall)}`);
  console.log(`MRR: ${metrics.mrr.toFixed(3)}`);
  console.log(`拒答准确率: ${percent(metrics.refusalAccuracy)}`);
  console.log(`误拒率: ${percent(metrics.falseRefusalRate)}`);
  console.log(`judge 准确率: ${percent(metrics.judgeAccuracy)}`);
  console.log(
    `检索 P50/P95: ${metrics.retrievalP50Ms}/${metrics.retrievalP95Ms}ms，judge P50/P95: ${metrics.judgeP50Ms}/${metrics.judgeP95Ms}ms`,
  );
  console.log(
    `报告已写入 eval/report.md，结果 JSON 在 eval/last-run.json`,
  );

  if (!allGatesPassed) {
    console.error("质量门禁未通过：", gates.filter((gate) => !gate.pass).map((gate) => gate.name).join(", "));
    exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  exitCode = 1;
} finally {
  await prisma.$disconnect();
  process.exitCode = exitCode;
}
