# 完整研发与交付流程

> 适用项目：KnowFlow AI（`VTR-vactory/create-ai`）
> 覆盖：本地开发 → 质量门禁 → GitHub CI → Vercel 自动部署 → 数据库迁移 → 线上验收 → 监控 → 回滚
> 部署细节见 [`deployment.md`](./deployment.md)，检索规则见 [`retrieval-contract.md`](./retrieval-contract.md)。

## 1. 技术栈

| 层 | 选型 |
|---|---|
| 框架 | Next.js 16 App Router + TypeScript（strict） |
| AI | AI SDK v7 + 智谱 GLM / embedding-3 |
| 数据 | PostgreSQL（Neon）+ pgvector，Prisma 6 |
| 认证 | Auth.js v5（Credentials，JWT session） |
| 限流 | Upstash Redis + Ratelimit |
| 联网 | Tavily |
| 测试 | Vitest（34 用例） |
| CI | GitHub Actions |
| CD | Vercel（Git 集成） |
| 容器 | Docker standalone（自托管备用） |

## 2. 全流程总览

```text
本地开发
  │  npm run dev
  │  改代码 / 写测试
  ▼
本地质量门禁（提交前）
  │  lint → typecheck → test → build
  ▼
git commit / push
  ▼
GitHub Actions（CI）
  │  install → prisma generate → lint → typecheck → test → build
  ▼
Vercel 自动部署（CD）
  │  push main → Production 部署
  │  PR      → Preview 部署
  ▼
线上验收（手工 + curl）
  ▼
监控 / 日志 / 回滚
```

数据库迁移是**独立的旁路**：schema 变更时生成迁移 → 对线上库执行 `migrate deploy` → 再发布应用。

## 3. 账号与前置

| 服务 | 用途 | 需要保存的变量 |
|---|---|---|
| GitHub | 代码托管 + Actions | — |
| Vercel | 部署 | `VERCEL_TOKEN`（可选，Actions 部署时） |
| Neon | PostgreSQL + pgvector | `DATABASE_URL`（pooled）、`DIRECT_URL`（direct） |
| Upstash | 限流 | `UPSTASH_REDIS_REST_URL/TOKEN` |
| 智谱 | 对话 + embedding | `ZHIPU_API_KEY` |
| Tavily | 联网搜索 | `TAVILY_API_KEY` |

## 4. 本地开发

```powershell
npm ci
Copy-Item .env.example .env    # 填入真实值（.env 已被 gitignore）
npx prisma migrate dev         # 应用本地迁移
npm run dev                    # http://localhost:3000
```

本地 `.env` 至少包含：

```dotenv
DATABASE_URL="postgresql://postgres:password@localhost:5432/create_ai"
DIRECT_URL="postgresql://postgres:password@localhost:5432/create_ai"
AUTH_SECRET="local-random-secret"
AUTH_TRUST_HOST="true"
ZHIPU_API_KEY="..."
ZHIPU_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
UPSTASH_REDIS_REST_URL="..."
UPSTASH_REDIS_REST_TOKEN="..."
TAVILY_API_KEY="..."
```

> `.env*` 已被忽略，只有 `.env.example` 会提交；任何密钥都不要加 `NEXT_PUBLIC_`。

## 5. 本地质量门禁

提交前必须全绿：

```powershell
npm run lint        # ESLint
npm run typecheck   # tsc --noEmit
npm run test:run    # Vitest（34）
npm run build       # prisma generate && next build
```

## 6. Git 流程

- 分支：`main` 为发布分支；功能用 `feat/xxx`、修复用 `fix/xxx`。
- 提交信息（Conventional Commits）：
  - `feat: ...` 新功能
  - `fix: ...` 修复
  - `docs: ...` 文档
  - `db: ...` 迁移
  - `chore: ...` 杂项
- 推送：

```powershell
git add -A
git commit -m "feat: ..."
git push
```

> 当前网络下 GitHub HTTPS 推送会被重置，remote 已配置为 **SSH over 443**：
> `ssh://git@ssh.github.com:443/VTR-vactory/create-ai.git`。

## 7. CI（GitHub Actions）

文件：`.github/workflows/ci.yml`

- 触发：`push main`、`pull_request`
- 步骤：`npm ci → prisma generate → lint → typecheck → test:run → build`
- 使用占位环境变量（不连真实库）
- 同一分支并发时取消旧任务

查看：`https://github.com/VTR-vactory/create-ai/actions`

## 8. CD（Vercel 自动部署）——推荐

**方式：Vercel Git 集成，push 即部署，无需写部署脚本。**

1. Vercel → Add New → Project → 导入 `VTR-vactory/create-ai`。
2. Framework：Next.js（自动）。Build Command 用默认（`npm run build` 已含 `prisma generate`）。
3. 配置环境变量（Production + Preview）：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Neon **Pooled**（主机带 `-pooler`） |
| `DIRECT_URL` | Neon **Direct**（迁移用） |
| `AUTH_SECRET` | 新的随机值 |
| `AUTH_TRUST_HOST` | `true` |
| `ZHIPU_API_KEY` / `ZHIPU_BASE_URL` | 智谱 |
| `UPSTASH_REDIS_REST_URL/TOKEN` | 限流 |
| `TAVILY_API_KEY` | 联网 |

4. Deploy。
5. 之后：

| 事件 | 结果 |
|---|---|
| push 到 `main` | 自动部署 Production |
| 开 PR | 自动生成 Preview URL |
| 合并 PR | 再次部署 Production |

> CD 与 CI 是**并行**的：CI 失败不会阻止 Vercel 部署。所以约定：**CI 绿了再合并**。

## 9. 可选：用 GitHub Actions 部署（二选一）

如果希望“CI 通过后才部署”，可以不用 Vercel Git 集成，改用 Actions + Vercel CLI。

需要 Secrets：`VERCEL_TOKEN`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`。

```yaml
name: Deploy

on:
  workflow_run:
    workflows: ["CI"]
    types: [completed]
    branches: [main]

jobs:
  deploy:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    env:
      VERCEL_ORG_ID: ${{ secrets.VERCEL_ORG_ID }}
      VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: npm
      - run: npm ci
      - run: npm i -g vercel@latest
      - run: vercel pull --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
      - run: vercel build --prod --token=${{ secrets.VERCEL_TOKEN }}
      - run: vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
```

> **不要同时开启** Vercel Git 集成和这个 workflow，会重复部署。

## 10. 数据库迁移流程

### 本地新增迁移

```powershell
npx prisma migrate dev --name add_xxx
```

### 应用到线上（Neon）

```powershell
$env:DATABASE_URL="<Neon Direct>"
$env:DIRECT_URL="<Neon Direct>"
npx prisma migrate deploy
npx prisma migrate status     # 确认 up to date
```

### 提交迁移并发布

```powershell
git add prisma/migrations prisma/schema.prisma
git commit -m "db: add_xxx"
git push
```

规则：

- **迁移只走 Direct 连接**，不要在 pooled 上执行。
- 迁移文件一旦推到 `main` 就视为不可变；修正用新迁移。
- 破坏性变更前备份（Neon Branch / 导出）。
- 可选：在 CD 中加一个 `prisma migrate deploy` job（需要 `DIRECT_DATABASE_URL` secret），放在部署之前或之后，取决于变更是否向后兼容。

## 11. 环境变量管理

| 环境 | 位置 | 是否提交 |
|---|---|---|
| 本地 | `.env` | ❌ 已忽略 |
| 线上 | Vercel Environment Variables | ❌ 仅控制台 |
| 模板 | `.env.example` | ✅ 只含占位符 |

- 新增变量时**同时**更新 `.env.example` 和 Vercel。
- 泄露过的 Key 必须轮换（智谱、Neon 密码、Tavily）。
- Vercel 修改变量后需要 **Redeploy** 才生效。

## 12. 发布前 Checklist

- [ ] `npm run lint` / `typecheck` / `test:run` / `build` 全绿
- [ ] CI 在 GitHub 上为绿
- [ ] schema 变更已生成迁移并应用到 Neon
- [ ] Vercel 环境变量齐全（尤其 `DIRECT_URL`、`AUTH_TRUST_HOST`）
- [ ] `.env` 未被提交；`.env.example` 已更新
- [ ] 本次改动涉及的接口在本地手测过

## 13. 线上验收

```powershell
curl.exe -I  https://<app>/login          # 200
curl.exe -i  https://<app>/api/chats      # 401
curl.exe -i  https://<app>/files          # 307 -> /login
```

浏览器 7 步：

1. 注册 / 登录 / 退出
2. 上传 `.md` → 处理中 → 已就绪
3. 纯附件提问 → 总结
4. 附件 + 提问 → 仅依据附件
5. 本地无依据：开关关 → 明确拒绝；开关开 → 联网 + 来源
6. 刷新 → 历史与文件仍在
7. 删会话 → 文件仍在「我的文件」
8. 连续 11 次 → 429

## 14. 监控与排障

| 位置 | 看什么 |
|---|---|
| Vercel → Logs | 函数报错、耗时、冷启动 |
| Vercel → Deployments | 构建日志、回滚入口 |
| Neon → Monitoring | 连接数、慢查询、休眠 |
| Upstash → Dashboard | 限流命中、额度 |
| 应用日志 | `[chat] retrieval`（`sourceTier` / `usedWebSearch` / `latencyMs`） |

常见问题：

| 现象 | 排查 |
|---|---|
| 登录循环跳转 | `AUTH_SECRET`、`AUTH_TRUST_HOST=true`、清 Cookie |
| `P1001` 连接失败 | 用 pooled URL；Neon 是否休眠 |
| `DIRECT_URL` 缺失 | Vercel 环境变量补齐，Redeploy |
| 回答被截断 | `maxDuration = 60` 已设置；仍超时则缩短上下文 |
| 429 | Upstash 额度 / 窗口；URL 与 Token 是否同一库 |
| 联网无结果 | `TAVILY_API_KEY`、额度；日志 `degraded=true` |

## 15. 回滚

1. **Vercel**：Deployments → 选择上一个正常部署 → Promote to Production。
2. **代码**：`git revert <commit>` → push（自动重新部署）。
3. **数据库**：Prisma 迁移不自动回滚；破坏性变更前先备份/建 Branch。

## 16. 安全与成本

- 密钥只在服务端；客户端 bundle 不得出现 Key。
- 日志不输出密码、Cookie、Authorization、完整 Key。
- 免费额度：Neon 1GB（会休眠）、Upstash 限额、Tavily 免费额度、Vercel Hobby（个人非商业）。
- 限流保护模型额度：chat 10 次/分钟，upload 20 次/分钟。

## 17. 简历素材

> 独立完成 KnowFlow AI：Next.js 16 + TypeScript strict + AI SDK v7 流式对话；Prisma + Neon PostgreSQL/pgvector 实现 RAG（切块 → embedding → 余弦检索）；Auth.js v5 服务端鉴权与资源所有权校验；Upstash 限流；Tavily 联网降级；GitHub Actions 持续集成（lint/typecheck/34 单测/build）；Vercel 自动部署。

拿到线上地址后补：`线上 Demo：https://<app>.vercel.app`。
