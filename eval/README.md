# RAG 评测集

`dataset.jsonl` 每行一条评测样本，用于计算检索与拒答质量。

## 语料

固定语料位于 `eval/corpus/`，与演示账号共用同一套文件：

| 文件 | 类型 | 用途 |
|---|---|---|
| `01-product-zh.md` | 中文产品说明 | 主场景、检索顺序、拒答 |
| `02-api-en.md` | 英文 API 手册 | 跨语言检索、认证与错误码 |
| `03-limits.csv` | 套餐限制表 | 数字/表格检索、附件隔离 |
| `04-ocr-demo.png` | 图片 OCR 样例 | 图片 OCR、图片来源引用 |

`manifest.json` 记录每个文件的 sha256 与字符数/字节数；脚本会校验，语料变更后必须更新 manifest。

附件隔离设计：`03-limits.csv` 独有 `support_sla_hours` 与 `api_rate_per_min` 的 Enterprise 值，`02-api-en.md` 只写默认限额，因此只有正确限定附件范围才能答对。

## 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `id` | 是 | 唯一编号 |
| `question` | 是 | 用户问题 |
| `scope` | 是 | `user`（查当前用户全部文档）或 `attachment`（只查指定附件） |
| `shouldAnswer` | 是 | 是否应该基于资料回答；`false` 表示应拒答 |
| `expectedDocNames` | 是 | 期望命中的文档名（按名称解析，避免硬编码数据库 ID） |
| `expectedKeywords` | 否 | 检索片段/回答里应出现的关键信息 |
| `attachmentNames` | `scope=attachment` 时必填 | 限定检索范围的文档名 |

## 当前覆盖（11 条）

- 6 条可回答：文件格式、检索顺序、无依据行为、默认退款周期、API 认证、图片 OCR 退款周期
- 3 条应拒答：SOC 2、创始人、2025 年营收（语料中均未提及）
- 2 条附件限定：Enterprise 的 SLA 与 API 限额（只在 `03-limits.csv` 中）

## 验证

1. `npm run seed:eval`：重建 3 份文本语料 + 1 张 OCR 图片，并校验 manifest。
   - demo 账号：`eval@lumendesk.local`
   - 默认密码：`12345678`（可用 `EVAL_PASSWORD` 覆盖）
   - 需要 Node >= 22.6（使用 `--experimental-strip-types` 导入 OCR）
2. `npm run check:eval`：快速检索层验证（只调用 embedding，不调用 judge）：
   - 可回答命中、关键词命中、附件隔离
   - 拒答列表示“检索为空”，不等于最终一定拒答
3. `npm run eval`：完整评测（检索 + judge），生成 `eval/report.md` 与 `eval/last-run.json`。
   - 需要 Node >= 22.6（使用 `--experimental-strip-types` 直接导入 `judge.ts`）
   - 有失败项时退出码为 1，可用于提交前检查
4. 产品层：登录 `eval@lumendesk.local`（默认密码 `12345678`），按清单提问：
   - 可回答：文件格式、检索顺序、默认退款周期
   - 应拒答：SOC 2、创始人、2025 年营收
   - 附件隔离：只挂 `03-limits.csv`，问 Enterprise 的 SLA / API 限额
   - 图片 OCR：只挂 `04-ocr-demo.png`，问退款周期

### 当前基线（2026-10-22，11 条）

| 指标 | 结果 | 目标 |
|---|---|---|
| Recall@5 | 100.0% | >= 80% |
| MRR | 0.854 | >= 0.6 |
| 拒答准确率 | 100.0% | >= 90% |
| 误拒率 | 0.0% | <= 10% |
| 附件隔离 | 100.0% | 100% |
| 关键词命中率 | 100.0% | - |
| judge 准确率 | 100.0% | - |
| 检索 P50 / P95 | 3 / 7 ms | - |
| judge P50 / P95 | 3172 / 5264 ms | - |

结论：阈值 0.55 下，无关问题仍会召回 1–5 个片段，单靠阈值无法拒答；接入 judge 后拒答准确率从 0/3 提升到 3/3，且没有误拒可回答问题。11 条样本中包含 1 条图片 OCR 附件题，也通过。

代价：judge 给首字延迟增加了约 3.3s（P50）。下一步可优化：只对“灰区”调用 judge、把片段压到 Top-3、或换更快的判定模型。

注意：`npm run check:eval` 仍是**检索层**验证，因此它的“检索为空”仍显示 0/3；完整结论看 `npm run eval` 或 `eval/report.md`。
