# 部署手册：Vercel / Render + Neon

> 目标：把 `create-ai` 部署到公网，并完成线上验收。
> 本文不包含任何真实密钥；变量值请从本地 `.env` / Neon 控制台复制。

## 0. 当前状态

- 代码仓库：`https://github.com/VTR-vactory/create-ai`（public，分支 `main`）
- CI：`.github/workflows/ci.yml`（install → prisma generate → lint → typecheck → test → build）
- 数据库：Neon（10 个迁移已应用，`vector` 扩展已启用，含图片 OCR 字段）
- 当前演示：Render（Docker，免费实例）`https://create-ai-6ut3.onrender.com`
- Vercel：账号审核中，通过后可切回
- 本地：`npm run dev`

## 1. Vercel 环境变量

在 Vercel → Project → Settings → Environment Variables，**Production + Preview 都勾选**：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | Neon **Pooled** 连接串（主机名带 `-pooler`） |
| `DIRECT_URL` | Neon **Direct** 连接串（迁移用） |
| `AUTH_SECRET` | 新的随机值（`openssl rand -base64 32`） |
| `AUTH_TRUST_HOST` | `true` |
| `AUTH_URL` | 部署域名，例如 `https://<app>.vercel.app` 或 Render 域名 |
| `ZHIPU_API_KEY` | 智谱 API Key |
| `ZHIPU_BASE_URL` | `https://open.bigmodel.cn/api/paas/v4` |
| `ZHIPU_OCR_MODEL` | `glm-4v-flash`（免费；4.6V 限流时更稳定） |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis REST Token |
| `TAVILY_API_KEY` | Tavily 搜索 Key |

> 任何服务端密钥都**不要**加 `NEXT_PUBLIC_` 前缀。

## 2. 首次部署步骤

1. 登录 https://vercel.com（用邮箱登录；若提示 Google 邮箱冲突，先邮箱登录再关联 Google）。
2. **Add New → Project → Import Git Repository**，选择 `VTR-vactory/create-ai`。
3. Framework Preset：**Next.js**（自动识别），Root Directory：`./`。
4. Build Command / Output：保持默认（`npm run build` 已包含 `prisma generate`）。
5. 添加上面 11 个环境变量（`AUTH_URL` 可等域名生成后再补）。
6. **Deploy**。
7. 记录线上地址，回到环境变量补 `AUTH_URL=https://<域名>`，再 Redeploy。

> Vercel Function 请求体上限为 **4.5MB**。当前上传限制为：图片 3MB、文本 1MB、单次总大小 4MB。
> 超过限制会在进入代码前直接 413；不要为了大文件把限制改回 5MB/8MB。

> `next.config.ts` 已按环境条件化：Vercel 不生成 standalone，Docker / Render / Railway 仍保留。
> Prisma 已包含 `rhel-openssl-3.0.x`，用于 Vercel 的 Amazon Linux 运行时。

## 2.5 临时部署：Render（当前使用）

Vercel 审核期间使用 Render；代码、Neon、环境变量基本不变。

### 2.5.1 创建 Web Service

1. 打开 https://render.com，用 GitHub 登录
2. **New → Web Service**
3. 连接仓库 `VTR-vactory/create-ai`
   - GitHub App 权限建议选 **Only select repositories**
4. 配置：
   - Runtime：**Docker**
   - Branch：`main`
   - Root Directory：留空
   - Region：**Ohio (US East)**（离 Neon `us-east-2` 更近）
   - Instance Type：**Free**（会休眠；简历链接可接受首次刷新）
5. 环境变量：
   - 保留 Render 自带的 `PORT`，不要删
   - 其余与 Vercel 相同的 11 个变量
   - `AUTH_URL` 先留空，等域名生成后补
6. 点击 **Deploy web service**
7. 等 Deploys 状态变为 **Live**

### 2.5.2 域名与 AUTH_URL

1. Live 后复制服务域名，例如：

```text
https://create-ai-6ut3.onrender.com
```

2. Environment → 添加：

```text
AUTH_URL=https://create-ai-6ut3.onrender.com
```

3. **Save, rebuild, and deploy**
4. 等新的部署再次 Live

### 2.5.3 数据与迁移

- Neon 已应用 10 个迁移，不需要在 Render 容器里跑迁移
- **不要在 Render Shell 里跑 `seed:eval`**：容器是运行时镜像，依赖和 Node 版本不适合
- 在本地对 Neon 执行：

```bash
export DATABASE_URL="<Neon Pooled>"
export DIRECT_URL="<Neon Direct>"
npm run seed:eval
```

演示账号：

```text
eval@lumendesk.local / 12345678
```

### 2.5.4 Render 验收

```bash
curl -I  https://<domain>/login          # 200
curl -i  https://<domain>/api/chats      # 401
curl -i  https://<domain>/files          # 307 -> /login
```

浏览器：

1. 登录 demo 账号
2. `/files` 看到 4 份资料，图片 OCR 可检索
3. 新建对话只出现一个
4. 文本问题返回 `[1]` 且可点击
5. 无依据问题返回固定文案
6. 图片附件返回「图片：xxx（OCR）」来源
7. 刷新后历史引用仍可点

### 2.5.5 Render 常见故障

| 现象 | 排查 |
|---|---|
| `404` + `x-render-routing: no-server` | 新部署还在切换或实例崩溃；等 Live，必要时 Manual Deploy → Clear build cache |
| Prisma 报 URL 必须以 `postgresql://` 开头 | 环境变量值带了引号/占位符/空格；重新粘贴 Neon Pooled 字符串 |
| 登录回调失败 | `AUTH_URL` 与当前域名不一致；改成实际域名并 Redeploy |
| Build 报 heap out of memory | 免费 512MB 不足；清缓存重试，仍失败则升级实例或换平台 |
| 首次访问很慢 | 免费实例休眠，30–60 秒唤醒；刷新即可 |
| 上传图片 OCR 429 | `ZHIPU_OCR_MODEL=glm-4v-flash` |

## 3. 数据库迁移（首次已做过，后续变更时用）

首次部署前已在本地对 Neon 执行过：

```powershell
$env:DATABASE_URL="<Neon Direct>"
$env:DIRECT_URL="<Neon Direct>"
npx prisma migrate deploy
```

以后修改 schema 时：

```powershell
# 1) 本地生成迁移（连本地库）
npx prisma migrate dev --name <变更说明>

# 2) 应用到 Neon（用 Direct 连接）
$env:DATABASE_URL="<Neon Direct>"
$env:DIRECT_URL="<Neon Direct>"
npx prisma migrate deploy

# 3) 提交迁移文件并 push（Vercel 自动重新部署）
git add prisma/migrations
git commit -m "db: <变更说明>"
git push
```

> 迁移只走 Direct 连接，不要在 pooled（`-pooler`）连接上跑迁移。
>
> `.env` 默认指向本地库；跑 Neon 迁移时用终端临时 `export`/`$env:` 覆盖即可，
> Prisma 不会覆盖已经存在的环境变量。Vercel 的环境变量在控制台单独配置。

演示账号初始化（会写入 3 份文本 + 1 张 OCR 图片）：

```bash
npm run seed:eval
```

默认账号 `eval@lumendesk.local`，默认密码 `12345678`（可用 `EVAL_PASSWORD` 覆盖）。

## 4. 线上验收

把 `<app>` 换成当前域名（Render 或 Vercel）：

```powershell
curl.exe -I  https://<app>/login          # 期望 200
curl.exe -i  https://<app>/api/chats      # 期望 401
curl.exe -i  https://<app>/files          # 期望 307 -> /login
```

浏览器手动走一遍：

1. 注册 → 登录
2. 上传一个 `.md`，列表显示「处理中 → 已就绪」
3. 上传一张包含文字的图片（≤3MB），状态变为「已就绪」，文件卡片显示「OCR 文本可检索」
4. 只传附件提问 → 能总结资料；图片回答的来源标题显示「图片：xxx（OCR）」
5. 点击回答里的 `[1]` → 文本文档打开原文，图片打开原图；刷新历史后仍可点击
6. 库里没有的问题：联网关 → 明确「没有依据」；联网开 → 返回来源
7. 刷新页面 → 历史消息与文件仍在
8. 删除会话 → 「我的文件」里的文件仍在
9. 连续发送 11 次 → 至少一次 429
10. 上传超过 3MB 的图片 → 明确返回 413，而不是 500
11. 对 FAILED / PARTIAL 文件点「重试」→ 状态回到 READY；卡住超过 10 分钟的 PROCESSING 也可重试

## 5. 日常更新

```powershell
git push            # GitHub Actions 跑 CI；Vercel 自动部署
```

Vercel 每次 push 到 `main` 都会生成新部署；CI 失败不会阻止 Vercel 部署，所以**先看 CI 再合并**。

## 6. 常见故障

| 现象 | 排查 |
|---|---|
| 线上登录后循环跳转 | 检查 `AUTH_SECRET`、`AUTH_TRUST_HOST=true`，清 Cookie 重试 |
| Prisma `P1001` / 连接失败 | 检查 `DATABASE_URL` 是否用了 pooled；Neon 是否休眠（首次慢几秒） |
| 构建报 `DIRECT_URL` 缺失 | Vercel 环境变量补齐 `DIRECT_URL` |
| 流式回答被截断 | 已设置 `maxDuration = 60`；仍超时需缩短上下文 |
| 上传/回答 429 | Upstash 额度或限流窗口；确认 URL/Token 属于同一个 Redis |
| 联网无结果 | `TAVILY_API_KEY` 是否配置；额度是否用完；日志 `degraded=true` |
| 上传返回 413 | 请求体超过 Vercel 4.5MB 限制；检查图片是否 ≤3MB、总大小 ≤4MB |
| 报 `kind` / `ocrText` 列不存在 | Neon 未执行最新迁移；用 Direct 连接跑 `npx prisma migrate deploy` |
| Prisma 引擎加载失败 | 检查 `binaryTargets` 是否包含 `rhel-openssl-3.0.x`（Vercel） |
| 图片 OCR 一直失败 | 看 `[ocr]` 日志；免费模型 429 会自动重试，仍失败则文件标记 FAILED；稍后重新上传 |
| 冷启动慢 | Neon 免费实例会休眠，属正常 |

## 7. 回滚

- **Vercel**：Deployments → 选择上一个可用部署 → **Promote to Production** / Instant Rollback。
- **代码**：`git revert <commit>` 后 push，触发重新部署。
- **数据库**：迁移只前进不回滚；涉及破坏性变更前先备份（Neon Branch / 导出）。

## 8. 安全与成本

- 部署完成后轮换在聊天中出现过的 Neon 密码与智谱 Key。
- 免费额度：Neon 1GB（会休眠）、Upstash 限额、Tavily 免费额度、Vercel Hobby（个人非商业）。
- 日志中不要输出密钥、Cookie、Authorization。

## 9. 简历素材（部署后）

> 当前部署在 Render（Docker + Neon PostgreSQL + pgvector、Upstash Redis、GLM-4V-Flash OCR），
> 线上 Demo：`https://create-ai-6ut3.onrender.com`；Vercel 审核通过后切换。
> 通过 GitHub Actions 执行 lint / typecheck / 69 个单测 / build 的持续集成。
> 支持图片 OCR 入库、无依据拒答，以及文本/图片/联网来源的可点击引用。

（该地址为当前演示地址；切换 Vercel 后同步更新 README 与本文。）
