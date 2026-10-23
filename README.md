# KnowFlow AI

> 团队知识库问答工作台 —— 上传资料，构建私有知识库，用流式 AI 对话检索并回答。

[![CI](https://github.com/VTR-vactory/create-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/VTR-vactory/create-ai/actions/workflows/ci.yml)

KnowFlow 让你把 Markdown / TXT / CSV 等资料变成可检索的知识库：提问时先检索你的资料，再由 GLM 流式回答；**本地没有依据时明确拒绝**，只有用户显式开启「联网搜索」才回退到 Tavily，并展示可点击来源。

## 功能

- **账号**：注册 / 登录 / 退出（Auth.js v5，JWT + HttpOnly Cookie）
- **知识库**：上传文本与图片、图片 OCR（GLM-4.6V-Flash）、自动切块 + embedding、处理状态（`PROCESSING / READY / PARTIAL / FAILED`）、文件搜索 / 筛选 / 单删 / 批量删除
- **对话**：流式输出、停止生成、失败重试、刷新恢复历史、自动命名与手动改名、删除会话
- **RAG**：pgvector 余弦检索；范围优先级 **附件 → 个人文档 → 联网（开关）**
- **引用**：本地文档 / 图片 OCR / 联网结果都支持 `[1]` 可点击来源；图片来源标注「OCR」
- **安全**：服务端会话鉴权、资源所有权（所有查询带 `userId`）、Zod 校验、Upstash 限流、提示注入防护
- **体验**：附件缩略图、空状态、错误/404/加载骨架屏、离线提示、移动端适配

## 架构

```text
浏览器（React Client Components）
   │  useChat / fetch
   ▼
Next.js 16 App Router
   ├── /chat          流式对话工作台
   ├── /files         个人文件管理
   └── /api/*         Route Handlers
        ├── auth            登录态
        ├── chat            校验 → 限流 → 检索 → streamText → 落库
        ├── documents       上传 → 切块 → embedding → 状态机
        └── files           列表 / 删除
   │
   ├── Prisma ──► PostgreSQL + pgvector（User/Chat/Message/Document/DocumentChunk）
   ├── Upstash Redis（对话 / 上传限流）
   ├── 智谱 GLM（glm-4-flash）+ embedding-3（1024 维）
   └── Tavily（可选联网搜索）
```

## 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router、Route Handlers、Cache Components） |
| 语言 | TypeScript（strict） |
| UI | React 19 + SCSS Modules |
| AI | Vercel AI SDK v7 + 智谱 GLM / embedding-3 |
| 数据 | PostgreSQL + pgvector，Prisma 6 |
| 认证 | Auth.js v5（Credentials） |
| 限流 | Upstash Redis + Ratelimit |
| 测试 | Vitest（34 个单测） |
| CI | GitHub Actions |
| 部署 | Vercel + Neon（Docker standalone 备用） |

## 快速开始

前置：Node.js ≥ 20.9、带 `pgvector` 的 PostgreSQL、智谱 API Key（联网可选 Tavily、限流需要 Upstash）。

```powershell
npm ci
Copy-Item .env.example .env    # 填入真实值
npx prisma migrate dev         # 建表 + 启用 pgvector
npm run dev                    # http://localhost:3000
```

`.env`：

```dotenv
DATABASE_URL="postgresql://postgres:password@localhost:5432/create_ai"
DIRECT_URL="postgresql://postgres:password@localhost:5432/create_ai"
AUTH_SECRET="随机字符串"
AUTH_TRUST_HOST="true"
ZHIPU_API_KEY="..."
ZHIPU_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
UPSTASH_REDIS_REST_URL="..."
UPSTASH_REDIS_REST_TOKEN="..."
TAVILY_API_KEY="..."            # 可选
```

> `.env*` 已被忽略；只提交 `.env.example`。任何服务端密钥都不要加 `NEXT_PUBLIC_`。

## 脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 本地开发 |
| `npm run build` | `prisma generate && next build` |
| `npm run start` | 生产启动 |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest（watch） |
| `npm run test:run` | Vitest（一次性） |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/register` | 注册 |
| `*` | `/api/auth/[...nextauth]` | 登录 / 登出 / session |
| `GET` | `/api/chats` | 对话列表 |
| `POST` | `/api/chats` | 新建对话 |
| `GET/PATCH/DELETE` | `/api/chats/[id]` | 对话详情 / 改名 / 删除 |
| `POST` | `/api/chat` | 流式问答（校验、限流、检索、落库） |
| `GET` | `/api/documents/[id]/raw` | 图片原始内容 |
| `POST` | `/api/documents` | 上传资料（切块 + embedding） |
| `GET/DELETE` | `/api/files` | 文件列表 / 批量删除 |
| `DELETE` | `/api/files/[id]` | 删除单个文件 |

统一错误格式：`{ "error": { "code": "CODE", "message": "..." } }`。

## 数据模型

`User 1—N Chat 1—N Message`；`User 1—N Document 1—N DocumentChunk`。

- 消息用 `(chatId, position)` 唯一约束 + `Chat.messageSeq` 原子分配，避免并发顺序错乱
- `(chatId, clientId)` 唯一约束实现重试幂等
- 删除会话时 `Document` 只解除关联（`ON DELETE SET NULL`），文件仍保留在「我的文件」
- `Message.sources` 保存本地与联网来源，历史里也能点击

## 检索规则

优先级：**附件 → 当前用户文档 → 联网（显式开关）**；全部未命中时服务端直接返回「没有依据」，不调用模型。详见：

- [检索契约](docs/retrieval-contract.md)

## 工程与交付

- [完整研发与交付流程](docs/workflow.md)：开发 → CI → 自动部署 → 迁移 → 验收 → 回滚
- [部署手册](docs/deployment.md)：Vercel + Neon 的环境变量与上线步骤

部署后可在 README 补充线上地址。

## 设计取舍与限制

- 图片以 base64 存数据库（图片 ≤3MB、文本 ≤1MB），生产建议对象存储
- 检索为 pgvector 相似度 + 固定阈值，后续可加 rerank
- 联网搜索只在本地零命中且开关开启时触发，且只发送问题文本
- 单用户私有隔离，不含团队/共享知识库
- 可观测性目前为结构化 `console.log`，后续可接 Sentry / Langfuse

## License

仅用于学习与作品集展示。
