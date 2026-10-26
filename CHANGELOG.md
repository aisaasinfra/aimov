# Changelog

Notable changes to the template. Derived sites pick them up with `git merge` from upstream (see the `sync-upstream` skill). Earlier changes are in the git history.

中文说明在每条下方。

The in-app page is `/changelog` (six public locales: en, de, es, fr, pt-BR, zh-TW). This file stays the repo log.

站内页面是 `/changelog`（六种公开语言：en、de、es、fr、pt-BR、zh-TW）。本文件仍是仓库日志。

## 2026-10-26

### Added: runtime video channel and OpenGen

- Admins can set the video channel at `/admin/settings`. The value overrides `VIDEO_PROVIDER` for new jobs after the settings cache (about 60 seconds). The choice is stored on the existing `generations.provider` column. Submit, retry, poll and webhooks keep using that row. `mock` cannot be saved or executed when `APP_ENV` is `production` or `staging`.
- Optional `opengen` provider. aimov pushes submit and status to `OPENGEN_BASE_URL` with `OPENGEN_API_KEY` (a connection secret, not the vendor key). The webhook only triggers a poll. `OPENGEN_STUB=1` is a local integration stub and is refused in production. User credits stay on aimov's `generation:<id>` / `generation_refund:<id>` ledger. Contract: `docs/opengen.md`.
- Connection probes use the same resolution as job creation. An unconfigured channel fails with copy that includes「未配置」.

Upgrading a site: merge. New vars `OPENGEN_BASE_URL` (empty) and `OPENGEN_STUB` (`0`) in both wrangler files. Optional secret `OPENGEN_API_KEY` only if you select OpenGen. No migration. Real OpenGen playback is not part of this change.

新增：后台可切换视频渠道，新工单锁定在 `generations.provider`；可选 OpenGen 推送渠道（只存连接 URL 和鉴权 secret，厂商 Key 留在 OpenGen）。`OPENGEN_STUB=1` 仅供 development / preview 联调。站点升级：合并即可。两份 wrangler 增加 `OPENGEN_BASE_URL`（空）和 `OPENGEN_STUB`（`0`）。要用 OpenGen 再配 secret `OPENGEN_API_KEY`。没有迁移。真实 OpenGen 出片不在这次范围内。

## 2026-10-25

### Added: LLM docs, optional error reporting, waitlist, feedback, changelog page

- Public `llms.txt`, `llms-full.txt`, and `/docs-md/{overview,pricing,changelog,waitlist}` describe the video product, locales, and routes. Production `robots.txt` points at the first two with comments. Staging still disallows the whole site and does not advertise them.
- `SENTRY_DSN` forwards scrubbed worker, API, and browser errors to a Sentry-compatible envelope endpoint. Blank, invalid, localhost, or IP hosts send nothing. Workers Logs stay the default. No Sentry SDK.
- Public waitlist (`/waitlist`) with Turnstile when configured, admin list, and CSV export. Duplicate emails are idempotent. It does not create an account.
- Signed-in product feedback (`/dashboard/feedback`) and admin statuses open / planned / shipped / closed. Separate from contact and takedown. Account export includes it; account deletion removes it.
- In-app `/changelog` driven by `src/content/changelog.ts`.

Upgrading a site: merge, then `npm run db:migrate:remote` (migration `0016_waitlist_feedback.sql`). Optional secret `SENTRY_DSN`. No new vars.

新增：给问答引擎的 `llms.txt`、可选的 Sentry 兼容错误上报、公开等待列表、登录后的产品反馈、站内更新日志。站点升级：合并后跑 `npm run db:migrate:remote`（迁移 `0016_waitlist_feedback.sql`）。可选 secret `SENTRY_DSN`。没有新增 vars。

## 2026-10-25

### Fixed: sign-in and checkout returns counted as traffic sources

- Coming back from Google sign-in or a payment provider's checkout page left `accounts.google.com` (or the checkout domain) in `document.referrer`, so the visitor's last touch became `google / organic` (or a referral from the payment provider) and orders were attributed to it. These hosts (`accounts.google.*`, `*.dodopayments.com`, `*.waffo.ai`, `*.stripe.com`, `*.paypal.com`, and aimov's PayPal.cn host `*.paypal.cn`; list in `src/lib/referrer.ts`) no longer count as a referrer on the client, and the server classifies them as `direct`, so orders fall back to the first touch even for cookies written before the fix.

Upgrading a site: nothing to do. Existing `orders.source` values are not rewritten; their raw touches are still in the `attribution` column.

修复：Google 登录、支付商结账页回跳后，`document.referrer` 是 `accounts.google.com` 或结账域名，最近一次触达被记成 `google / organic`（或来自支付商的 referral），订单来源跟着错。现在这些域名（`accounts.google.*`、`*.dodopayments.com`、`*.waffo.ai`、`*.stripe.com`、`*.paypal.com`，以及 aimov 的 PayPal.cn 主机 `*.paypal.cn`，表在 `src/lib/referrer.ts`）客户端不记为 referrer，服务端按 `direct` 归类，修复前写下的 Cookie 下单时也会回落到首次触达。站点升级：无需操作；已写入 `orders.source` 的旧记录不会改写，原始触达仍在 `attribution` 列里。

### Added: NanoAPI video provider

- A third optional video provider: `VIDEO_PROVIDER=nanoapi` with the `NANOAPI_API_KEY` secret and `site.video.nanoapi` (`genjutsu-1.0`; `mode` is `motion_control` or `replace_object`, plus `prompt`, `resolution` and `costCentsPerSecond`). The default provider is unchanged. Local `VIDEO_PROVIDER=mock` does not require a NanoAPI key.
- NanoAPI has no idempotency key, so before creating a task the provider lists the last 3 hours of tasks and reuses the one with the same photo and source video URLs; a failed list request fails the submit instead of creating blindly. Polling every 30 seconds; the webhook (`/api/webhooks/nanoapi`) is only a "go check now" signal. Account errors (`nanoapi_invalid_api_key`, `nanoapi_insufficient_balance`, `nanoapi_account_suspended`) fire the "Video provider account" alert; the config check and "test connection" cover it.
- Ported from upstream `53a3c6e`. That commit was tested with a real key at 480p through a tunnel. This tree did not re-run a paid NanoAPI order. `motion_control` keeps the face and the source scene but the photo's clothes; `replace_object` keeps the source outfit but not the face. Dressing the photo first with an image model and then running `motion_control` gives "you, in costume"; the template doesn't do that step for NanoAPI. NanoAPI reads the source video with Range requests and a browser User-Agent, so keep bot challenges away from `/media/*`; cut source videos to whole seconds (`replace_object` rounds up). Details in the README under "Video providers".

Upgrading a site: nothing changes unless you set `VIDEO_PROVIDER=nanoapi`; then set the `NANOAPI_API_KEY` secret and review `site.video.nanoapi`. No new vars or migrations.

新增第三个可选视频服务商 NanoAPI（`VIDEO_PROVIDER=nanoapi`，密钥 `NANOAPI_API_KEY`，配置 `site.video.nanoapi`：`genjutsu-1.0`，`mode` 为 `motion_control` 或 `replace_object`）。默认服务商不变，本地 `mock` 不需要 NanoAPI 密钥。NanoAPI 创建任务没有幂等键，所以创建前先列出最近 3 小时的任务，照片和源视频地址都相同就沿用旧任务，列表查不了则提交失败而不是盲目创建。轮询间隔 30 秒，webhook（`/api/webhooks/nanoapi`）只当“该查了”的信号。账户类错误触发“视频服务商账户”告警，配置检查和测试连接已覆盖。来自 upstream `53a3c6e`；该提交在 480p 用真实 key 经隧道跑通过，本仓库没有再付费重跑。站点升级：不设 `VIDEO_PROVIDER=nanoapi` 行为不变，启用时配置 `NANOAPI_API_KEY` 并检查 `site.video.nanoapi`；没有新增 vars 和迁移。

### Added: PayPal.cn credit packs next to Waffo, and a Christmas video landing

- PayPal Orders v2 (PayPal.cn uses the same global hosts) is a checkout channel beside Waffo. Packs can be paid with either; plans stay on Waffo. Dodo and Stripe remain selectable as `PAYMENT_PROVIDER`. Local default is still `mock`. Webhook verify uses Web Crypto, not the Node PayPal SDK. Credits are granted only on `PAYMENT.CAPTURE.COMPLETED`.
- A Waffo yearly renewal that keeps the open period and has no new period bounds no longer resets `grants_done` or grants a second round. A period the state event just opened still grants the first month. Underpay is still a mismatch.
- The landing is a Christmas video product: cream, pine and berry, video templates with lengths, a template strip and wall, a play-first hero, and a sticky upload/create bar. Google One Tap dismiss memory and the Accept-Language suggestion stay.

Upgrading a site: merge upstream. New vars `PAYPAL_MODE`, `PAYPAL_API_BASE`, `PAYPAL_PRODUCTS` (may stay `{}`). New secrets `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`. No migration. Webhook URL is `https://<domain>/api/webhooks/paypal`.

新增：PayPal.cn 与 Waffo 并列卖积分包（订阅仍走 Waffo）；Waffo 年付在当期还开着且扣款不带新周期时不再重复发放。首页改为圣诞视频：模板条、模板墙、先播放的预览和吸底上传/创建。站点升级：合并 upstream；新增上述 vars 和三个 secret，没有迁移。

## 2026-10-24

### Fixed: dev server always uses payment test environments

- `LOCAL_DEV_VARS` in `vite.config.ts` now sets `DODO_ENVIRONMENT`, `STRIPE_ENVIRONMENT` and `WAFFO_ENVIRONMENT` to `test`. A live site has `DODO_ENVIRONMENT=live` in `wrangler.jsonc`, so the dev server and `npm run test:sandbox` sent the test key from `.dev.vars` to the live API and checkout failed with HTTP 401. Builds and `wrangler deploy` are unaffected.

Upgrading a site: merge upstream. No new vars, secrets or migrations.

修复：站点上线后 `wrangler.jsonc` 里是 `DODO_ENVIRONMENT=live`，dev server 和 sandbox e2e 会拿 `.dev.vars` 里的 test key 去请求正式环境，下单返回 401。现在 `LOCAL_DEV_VARS` 把三家支付商的环境固定为 `test`，构建和部署不受影响。站点升级：合并 upstream；没有新增 vars、密钥和迁移。

### Fixed: e2e on sites with GA4 configured

- `playwright.config.ts` presets the analytics consent to `denied` in localStorage, so the consent banner no longer covers buttons at the bottom of the page and e2e runs never send hits to the site's real GA4 property. The attribution test grants consent itself and blocks gtag.js. No effect when `analytics.ga4Id` is empty.

Upgrading a site: merge upstream. Test-only change.

修复：站点填了 `analytics.ga4Id` 后 e2e 失败（同意横幅挡住后台按钮、归因 Cookie 要等同意才写）。现在 e2e 默认在 localStorage 预置“拒绝统计”，测试访问也不会发到真实的 GA4；归因用例自己改成同意并拦掉 gtag.js。没配 GA4 时不受影响。站点升级：合并 upstream，只改测试。

### Added: Dodo brand for products

- `node scripts/dodo-setup.mjs --apply --brand <brand_id>` creates the products under a brand of the Dodo business (Settings → Business → Brands). Several sites can share one verified business: each gets its own brand name, logo and statement descriptor on checkout and invoices, while KYC and payouts stay shared. Webhooks are business-level, so every site's endpoint also receives the other sites' events; those are already answered `ignored` with 200 (see docs/payments.md).

Upgrading a site: merge upstream. Only matters when creating Dodo products for a site that is a secondary brand. No new vars, secrets or migrations.

新增 Dodo 品牌：`dodo-setup.mjs --brand <brand_id>` 把商品建在 Dodo business 下这个站的品牌里。多个站可以共用一个已认证的 business，结账页和发票显示各站自己的名字、Logo 和账单描述，KYC 和打款共用。webhook 是 business 级的，每个站都会收到别站的事件，模板已按 `ignored` 回 200。站点升级：合并 upstream；只有给次级品牌建商品时才用得到；没有新增 vars、密钥和迁移。

### Fixed: yir unit tests on sites with `scene` configured

- `tests/unit/yir.test.ts` reset `site.video.yir.scene` and `routingOnly` to `null` before each test and restore the site's values after, so single-step tests no longer fail on a site that enables the two-step mode.

Upgrading a site: merge upstream. Test-only change.

修复：站点配了 `site.video.yir.scene` 后 yir 单步用例会失败。现在每个用例前把 `scene`、`routingOnly` 置空，结束后还原站点配置。站点升级：合并 upstream，只改测试。

### Changed: dev server always uses development vars

- `vite.config.ts` overrides `APP_ENV`, `SITE_URL`, the payment / video / moderation providers, `ADMIN_EMAILS`, `EMAIL_FROM`, `GOOGLE_CLIENT_ID` and `TURNSTILE_SITE_KEY` with development values (`LOCAL_DEV_VARS`) when running `vite dev`. A site can keep production values in `wrangler.jsonc` `vars` and still run local dev, e2e and CI against mock providers and dev sign-in. `.dev.vars` still overrides them for trying a real provider locally. Builds and `wrangler deploy` are unaffected.

Upgrading a site: merge upstream. If your site already had production values in `wrangler.jsonc`, local dev and e2e now run in development mode again; if you had relied on `vars` to point dev at a real provider, move that to `.dev.vars`. No new vars, secrets or migrations.

dev server 一律使用开发值：`vite dev` 时用 `LOCAL_DEV_VARS` 覆盖 `APP_ENV`、`SITE_URL`、支付/视频/审核服务商、`ADMIN_EMAILS`、`EMAIL_FROM`、`GOOGLE_CLIENT_ID` 和 `TURNSTILE_SITE_KEY`，站点的 `wrangler.jsonc` 可以直接写生产值，本地开发、e2e、CI 仍走 mock 和开发登录；要在本地试真实服务商写进 `.dev.vars`。构建和部署不受影响。站点升级：合并 upstream；原来靠 `vars` 让本地连真实服务商的，改写到 `.dev.vars`；没有新增 vars、密钥和迁移。

### Added: two-step yir mode

- `site.video.yir.scene` (`null` by default): an image model first puts the person from the user's photo into the source video's first frame, then Kling Motion Control uses the composite as its reference, so the clip keeps the source video's scene instead of the photo's background.
- The composite is uploaded to the yir Files API and referenced by a fixed `file_id`, so resubmits send the same body and aren't billed twice. Estimated cost adds `scene.costCents` per order.
- Providers can return `{ state: 'pending', next }` from `status()`; `jobs.ts` writes the next provider job back with a compare-and-set on the previous request id, so a webhook and a scheduled poll advancing at the same time write once.
- `npm run seed:local` now uploads `.jpg` files in `seed/templates/` as well as `.mp4`.

Upgrading a site: merge upstream. Nothing changes unless you set `site.video.yir.scene`; then put the frame in `seed/templates/` and upload it to `templates/` in R2 (`--content-type image/jpeg`). No new vars, secrets or migrations.

新增 yir 两步走（`site.video.yir.scene`，默认关闭）：先用图片模型把照片里的人合成进源视频首帧，再用合成图做 Kling 动作参考，成片保留源视频场景。合成图传进 yir Files API，用固定 `file_id` 引用，重复提交不重复计费；每单估算成本加 `scene.costCents`。`status()` 可返回带 `next` 的 pending，jobs.ts 按旧任务 id 抢占写回，webhook 和轮询同时推进只写一次。`seed:local` 同时上传 jpg。站点升级：合并 upstream；不配 `scene` 行为不变，配了要把首帧图放进 `seed/templates/` 并上传到 R2 的 `templates/`；没有新增 vars、密钥和迁移。

### Added: Stripe payments

- `PAYMENT_PROVIDER=stripe`: credit packs and subscriptions through Stripe Checkout, partial refunds from the admin, order reconcile, cancel / resume renewal, and the customer portal. Webhook: `/api/webhooks/stripe`.
- Webhooks are verified with `STRIPE_WEBHOOK_SECRET` and the `livemode` flag must match `STRIPE_ENVIRONMENT`; checkout sessions and invoices are fetched again with a pinned API version before crediting. Subscriptions are credited on `invoice.paid`.
- `scripts/stripe-setup.mjs` creates Products, Prices and the webhook endpoint (re-runs reuse them by lookup key). The launch check compares the key prefix with `STRIPE_ENVIRONMENT`; "Test connections" checks each Price's amount, currency, type and interval.
- Tested in a Stripe sandbox: payment, declined card, partial refund and a monthly subscription (cancel, resume, portal) all pass with real webhooks.
- Stripe is not a Merchant of Record: you handle sales tax and invoices yourself.

Upgrading a site: merge upstream, add `STRIPE_ENVIRONMENT` and `STRIPE_PRODUCTS` to `vars` (already in the template's `wrangler*.jsonc`), and set the two secrets only if the site switches to Stripe. No migration. Setup: [docs/payments.md](docs/payments.md) → "Stripe".

新增 Stripe 支付：积分包、订阅、后台部分退款、主动查单、取消/撤销续费和客户门户。webhook 验签并核对 `livemode`，入账前按固定 API 版本重新取对象，订阅按 `invoice.paid` 入账。`scripts/stripe-setup.mjs` 建商品、价格和 webhook；上线检查核对 Key 前缀，“测试连接”核对每个 Price。已在 Stripe 沙盒用真实 webhook 测通付款、拒付、部分退款和月付订阅。Stripe 不是 MoR，销售税和发票自己处理。站点升级：合并 upstream，`vars` 里加 `STRIPE_ENVIRONMENT`、`STRIPE_PRODUCTS`；只有改用 Stripe 时才需要配两个密钥；没有新迁移。
