# RAG 评测报告

- 时间：2026-10-23T09:15:57.489Z
- 数据集：`eval/dataset.jsonl`（sha256: `182f0044a859`，11 条）
- 语料：`01-product-zh.md`、`02-api-en.md`、`03-limits.csv`、`04-ocr-demo.png`
- 参数：chunk 800/120，Top-5，距离阈值 0.55
- judge：`glm-4-flash`（失败时 fail-open）

## 结论

| 指标 | 结果 | 目标 | 状态 |
|---|---|---|---|
| Recall@5 | 100.0% | >= 80% | 通过 |
| MRR | 0.854 | >= 0.6 | 通过 |
| 拒答准确率 | 100.0% | >= 90% | 通过 |
| 误拒率 | 0.0% | <= 10% | 通过 |
| 附件隔离 | 100.0% | 100% | 通过 |
| judge 准确率 | 100.0% | - | - |
| 关键词命中率 | 100.0% | - | - |
| judge 调用率 | 100.0% | - | - |

## 延迟与 token

| 指标 | P50 | P95 |
|---|---|---|
| 检索（ms） | 3 | 7 |
| judge（ms） | 3172 | 5264 |

judge token 合计：prompt 9310 / completion 404

## 逐条结果

| ID | scope | 应回答 | 命中片段 | 期望排名 | 关键词 | judge | 有效可答 | 隔离 | 结果 |
|---|---|---|---|---|---|---|---|---|---|
| q001 | user | 是 | 5 | 1 | ✓ | true | 是 | ✓ | ✓ |
| q002 | user | 是 | 5 | 1 | ✓ | true | 是 | ✓ | ✓ |
| q003 | user | 是 | 3 | 1 | ✓ | true | 是 | ✓ | ✓ |
| q004 | user | 是 | 4 | 2 | ✓ | true | 是 | ✓ | ✓ |
| q005 | user | 是 | 5 | 3 | ✓ | true | 是 | ✓ | ✓ |
| q006 | user | 否 | 5 | - | - | false | 否 | ✓ | ✓ |
| q007 | user | 否 | 1 | - | - | false | 否 | ✓ | ✓ |
| q008 | user | 否 | 3 | - | - | false | 否 | ✓ | ✓ |
| q009 | attachment | 是 | 1 | 1 | ✓ | true | 是 | ✓ | ✓ |
| q010 | attachment | 是 | 1 | 1 | ✓ | true | 是 | ✓ | ✓ |
| q011 | attachment | 是 | 1 | 1 | ✓ | true | 是 | ✓ | ✓ |

## 说明

- 拒答以 judge 判定为准；judge 失败按 fail-open 视为可回答。
- 本评测不调用生成模型，因此不衡量最终答案的忠实度；下一步可加 groundedness / 引用准确率。
- 语料或数据集变更后，先更新 manifest 并重新 `npm run seed:eval`。

