# aimov 本地部署指南

只覆盖**本机开发运行**（Vite + 本地 Miniflare 模拟的 Workers / D1 / R2 / KV / Queues）。  
**不含** Cloudflare Paid、自定义域名、生产部署。那些要另开，且需单独确认。

仓库：[`aisaasinfra/aimov`](https://github.com/aisaasinfra/aimov)  
建议分支：`dev`（圣诞视频金样与 Merry Us 视觉在这条线上）

---

## 你能得到什么

本地跑起来后：

| 能力 | 本地默认 |
| --- | --- |
| 打开站点、选模板、上传、点生成 | ✅ mock 视频（复制模板成片，不调 fal） |
| 买积分 / 结账 | ✅ mock 收银台（不花钱） |
| Google 真登录 | ❌ 可选；默认用「开发登录」 |
| 真 fal 出视频 / 真 Waffo·PayPal | ❌ 需自己在 `.dev.vars` 填密钥并改 provider（可选，非本指南必做） |
| Cloudflare 账单 | ❌ 本地不产生 CF 账单 |

---

## 环境要求

- **Node.js**：建议当前 LTS
- **npm**：`>= 11.19`（更低版本可能改坏 `package-lock.json`，CI 的 `npm ci` 会挂）
- **Git**
- 系统：macOS / Linux / Windows（Windows 见文末注意）

检查：

```bash
node -v
npm -v
```

---

## 1. 拿到代码

```bash
git clone https://github.com/aisaasinfra/aimov.git
cd aimov
git checkout dev
git pull
```

若你已有 clone，只要保证在 `dev` 且是最新即可。

---

## 2. 安装依赖

先停掉本仓库里正在跑的 `npm run dev`（否则 Windows / 部分环境会因 `.wrangler` 被占用报 `EBUSY`）。

```bash
npm install
```

---

## 3. 本地密钥文件

```bash
cp .dev.vars.example .dev.vars
```

用编辑器打开 `.dev.vars`，**至少**改这一项：

```bash
SESSION_SECRET=请换成一长串随机字符
```

可用：

```bash
openssl rand -hex 32
```

其余项（`FAL_KEY`、支付密钥等）**本地 mock 模式可以留空**。  
`.dev.vars` 已在 `.gitignore`，不要提交。

---

## 4. 初始化本地数据库与模板素材

```bash
npm run seed:local
```

作用：

- 对本机 D1 应用 migrations
- 把 `seed/templates/` 下的 mp4 / jpg 上传到本地 R2 的 `templates/`

缺模板文件时生成页可能异常；仓库里应已带示例素材。

---

## 5. 启动

```bash
npm run dev -- --host 127.0.0.1
```

浏览器打开：

**http://127.0.0.1:3000**

（`package.json` 里默认端口是 `3000`。不要用 `--host 0.0.0.0`，也不要把开发服务暴露到公网——开发登录 / mock 接口只认本机直连。）

---

## 6. 怎么登录、进后台

1. 打开登录页，使用页面上的 **「开发登录」**（仅非 production）。
2. 本地默认管理员邮箱：`admin@example.com`（见 Vite 本地覆盖的 `ADMIN_EMAILS`）。用该邮箱开发登录后可进 **`/admin`**。
3. 运营参数（维护模式、全站公告、**全站每日生成上限 `generationDailyCap`**）在：

   **http://127.0.0.1:3000/admin/settings**

   - `generationDailyCap = 0` → 不限（默认）
   - 设成正数 → 每个 UTC 自然日全站最多创建那么多生成任务，超出返回 429，不扣积分

本地发信是模拟的，不会真发邮件；可用本机接口查「发件箱」（见 README「本地开发」）。

---

## 7. 建议自测路径（金样）

1. 首页选 Merry Us / 世界封面 → 上传一张照片 → Create  
2. mock 生成应很快出片（复制模板视频）  
3. 点购买走 mock 收银台，确认积分到账  
4. 管理员进 `/admin/settings`，确认能改 `generationDailyCap`、维护模式  

可选自检：

```bash
npm run typecheck
npm test
```

端到端（需已装 Playwright 浏览器）：

```bash
npx playwright install
npm run test:e2e
```

---

## 8. 日常重启

```bash
cd aimov
git checkout dev && git pull
npm run dev -- --host 127.0.0.1
```

若改了 migration 或 seed 素材，再跑一次：

```bash
npm run seed:local
```

---

## 常见问题

| 现象 | 处理 |
| --- | --- |
| `localhost` 连不上（尤其 Windows） | 用 `127.0.0.1`，启动加 `--host 127.0.0.1` |
| `npm install` 报 `EBUSY` | 先停掉所有本仓库的 dev / wrangler |
| 端口被占用 | 换端口：`npm run dev -- --host 127.0.0.1 --port 3211`（注意：改端口后书签和部分本地配置里的 `SITE_URL` 仍可能写着 3000，优先保持 3000） |
| 生成/支付「像真的在扣费」 | 确认没改成真实 `VIDEO_PROVIDER` / `PAYMENT_PROVIDER`；默认 mock 不花钱 |
| 想试真 fal | 在 `.dev.vars` 填 `FAL_KEY`，并按 `docs/env.md` 覆盖本地 provider（会真实产生 fal 费用，与 CF 无关） |

更细的环境变量说明：[`docs/env.md`](./env.md)  
总说明（含上云）：[`README.zh-CN.md`](../README.zh-CN.md)

---

## 明确不做（本指南范围外）

- 不创建 Cloudflare 远程 D1/R2/KV/Queues  
- 不执行 `npm run deploy`、不开 Workers Paid  
- 不买域名、不绑生产域名  
- 不把 `generationDailyCap` 默认值改成非 0（上云前再在后台设小数即可）

上云前防账单：先设账单告警 + 后台 `generationDailyCap` + fal 消费上限，再考虑 Paid——需你另行下令。
