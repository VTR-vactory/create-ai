# 检索契约（Retrieval Contract）

> 版本：v2（2026-10-22）
> 状态：**已固化**。任何改动检索逻辑的提交，必须先更新本文档。
> 代码入口：`src/app/api/chat/route.ts`、`src/lib/chat/*`、`src/lib/rag.ts`

## 1. 目标

定义 KnowFlow 回答问题时**允许使用的数据来源**、**检索顺序**与**失败降级规则**，避免：

- 跨用户数据泄露
- 无依据编造
- 检索行为随重构漂移

## 2. 唯一数据源原则（隐私红线）

- 所有检索**必须**带 `userId`，SQL `WHERE` 必须包含它。
- **不存在「全数据库」或「共享库」层级。** 不同用户的数据永远互相隔离。
- 附件在进入检索前，必须校验归属（`id + userId`，数量完全匹配）。
- 联网搜索只能拿到**用户的问题文本**，不得附加任何本地文档/附件内容。

违反以上任一条，视为**缺陷**，不是"优化空间"。

## 3. 判定链

| # | 场景 | 数据范围 | 前置条件 | 当前状态 |
|---|---|---|---|---|
| 1 | 附件 + 提问 | 仅该轮 `attachmentIds` | `userText` 非空 | ✅ 已实现 |
| 2 | 仅附件（无文字） | 该轮附件的内容块 | `userText` 为空 | ✅ 已实现 |
| 3 | 纯文字 | 当前用户的文档 | 无附件 | ✅ 已实现 |
| 3.5 | 本地有命中但不足以回答 | 不调用生成模型 | judge 判否、联网无结果 | ✅ 已实现 |
| 4 | 以上均未命中 | 外部搜索服务 | `useWebSearch = true` | ✅ 已实现（默认关闭） |
| 4' | 以上均未命中，或 judge 判否且开关关闭 | — | — | ✅ 返回"没有找到依据" |

### 可用性判断（answerability judge）

检索之后、生成之前，如果「本地有片段」且「用户有文字问题」，调用 `judgeAnswerable`
（`src/lib/chat/judge.ts`，默认 `glm-4-flash`）判断片段是否包含回答所需的事实。

- judge 判否：视为本地无依据；若联网也没有结果，直接返回固定文案。
- judge 失败 / 超时 / 输出无法解析：**fail-open**，继续用本地片段回答，并记录日志。
- 纯附件总结（无文字）跳过 judge：附件内容本身就是回答对象。
- judge **不会**触发联网；联网仍然只在本地零命中时发生（见场景 4）。

### 伪代码

```ts
if (attachments.length > 0) {
  if (!userText) {
    chunks = firstChunksOfDocuments(attachments, N); // 场景 2
  } else {
    chunks = searchInDocuments(userId, userText, attachmentIds); // 场景 1
  }
} else {
  chunks = searchUserDocuments(userId, userText);      // 场景 3
}

if (chunks.length === 0 && useWebSearch) {
  webResults = searchWeb(userText);                    // 场景 4
}

let judge = null;
if (chunks.length > 0 && userText) {
  judge = await judgeAnswerable(userText, chunks);      // 可能失败 → fail-open
}

const hasUsableBasis = chunks.length > 0 && judge?.answerable !== false;
if (!hasUsableBasis && webResults.length === 0) {
  return noBasis();                                    // 场景 3.5 / 4'
}

knowledge = render(chunks, webResults);
```

> 注意：场景 1 **不做**「附件没命中就回退到用户文档」。附件是本轮的明确范围。
> 若产品后续要求回退，必须先改本契约并加测试。

## 4. 各场景细则

### 场景 1：附件 + 提问
- 检索范围：`DocumentChunk.documentId IN attachmentIds AND Document.userId = userId`
- 相似度：余弦距离 `<=> <= MAX_COSINE_DISTANCE`
- Top K：`limit = 5`
- 无命中 → 进入场景 4 判断

### 场景 2：仅附件
- 不做语义检索（没有问题文本）
- 取附件前 `N = 5` 块，按 `documentId, createdAt` 升序
- 用途：让模型"读到文件"，指令为「请阅读并总结…」

### 场景 3：纯文字
- 检索范围：`Document.userId = userId`
- 相似度与 Top K 同场景 1
- 无命中 → 进入场景 4 判断

### 场景 4：联网
- 触发条件：`useWebSearch = true` 且本地（附件/用户文档）**零命中**
- 服务：Tavily（`src/lib/web-search.ts`）
- 只发送用户问题文本（截断 500 字符），**不附加任何本地资料**
- 结果数量上限 4，标题截断 200 字符、摘要截断 800 字符
- 回答必须标注来源 URL；网络结果单独放入 `【网络搜索结果】` 分区
- 服务失败 / 超时（5s）/ 非 200 / 未配置 Key → 返回空，降级为"无依据"，不得 500

## 5. 参数

| 参数 | 当前值 | 位置 | 说明 |
|---|---|---|---|
| `MAX_COSINE_DISTANCE` | `0.55` | `src/lib/rag.ts` | 距离阈值，约等于相似度 0.45 |
| 检索 `limit` | `5` | `rag.ts` 默认参数 | 每次最多注入的片段数 |
| 纯附件块数 | `5` | `rag.ts` | 场景 2 的 N |
| 联网超时 | `5000ms` | `src/lib/web-search.ts` | 超时视为失败并降级 |
| 联网结果数 | `4` | `web-search.ts` | 场景 4 的 limit |
| 联网问题截断 | `500` 字符 | `web-search.ts` | 隐私/成本控制 |
| 上下文窗口 | 最近 `12` 条消息 | `route.ts` | 控制 token |
| judge 模型 | `glm-4-flash` | `judge.ts` | 可用 `ZHIPU_JUDGE_MODEL` 覆盖 |
| judge 超时 | `8000ms` | `judge.ts` | 超时/失败 fail-open |

> 调整阈值/条数属于契约变更，需同步更新本文档与测试。

## 6. 降级与失败

| 情况 | 行为 |
|---|---|
| 本地无命中、开关关 | **服务端直接返回固定文案「没有找到依据」**，不调用模型（模型可能用自身知识作答） |
| 本地无命中、开关开、搜索失败 | 同样直接返回固定文案，并记录 `degraded=true` |
| 本地无命中、开关开、搜索成功 | 依据网络结果回答 + 来源 |
| judge 判否、无网络结果 | 固定文案，不调用生成模型 |
| judge 失败 / 超时 / 无法解析 | fail-open：继续用本地片段回答，记录日志 |
| 搜索超时/失败/未配置 | 降级为"无依据"，记录日志，不中断请求 |
| embedding 失败 | 该次检索视为无命中 |
| 附件解析失败（status=FAILED） | 视为无内容，提示资料不可用 |

## 7. 观测（建议字段）

每次回答建议记录：

- `sourceTier`：`attachment` / `user` / `web` / `none`
- `hitCount`：命中片段数
- `webSearchEnabled`：用户开关状态
- `usedWebSearch`：是否真正调用联网（不是开关状态）
- `webResultCount`：联网结果条数
- `latencyMs`：检索耗时
- `degraded`：是否发生降级（联网开启但无结果）
- `judgeAnswerable`：judge 结论（`true` / `false` / `null` 未调用或失败）
- `judgeMs`：judge 耗时

用途：判断阈值是否合理、联网是否必要、哪一级最常命中。

## 8. 非目标（明确不做）

- ❌ 跨用户检索
- ❌ 全库 / 共享知识库
- ❌ 让模型自行决定是否联网
- ❌ 在服务端静默联网（必须是用户显式开关）
- ❌ 把本地文档内容发送给搜索服务

## 9. 验收标准

- [ ] 附件 + 提问：只返回附件内容
- [ ] 仅附件：能基于附件总结
- [ ] 纯文字：只返回当前用户文档（负向测试：不得出现他人文档）
- [ ] 无命中 + 开关关：明确"无依据"
- [ ] 本地有命中但片段不含答案：judge 判否 → 固定文案
- [ ] judge 超时/失败：不阻断回答（fail-open）
- [ ] 无命中 + 开关开：联网并带来源
- [ ] 本地有命中时，即使开关开也不联网
- [ ] 联网只发送问题文本（测试断言请求体不含本地资料）
- [ ] 搜索失败：降级且不 500
- [ ] `lint / tsc / vitest / build` 全绿
