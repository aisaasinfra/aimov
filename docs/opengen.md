# OpenGen 视频渠道

aimov 把 OpenGen 当作又一个 `VideoProvider`（`opengen`）。厂商 Key 留在 OpenGen 主机。aimov 只保存连接信息：`OPENGEN_BASE_URL` 和 `OPENGEN_API_KEY`。用户积分仍只记在 aimov（`generation:<id>` / `generation_refund:<id>`）。OpenGen 不维护第二套用户积分账本。

本文件是 aimov **推送**过去的契约。OpenGen 主机不在本仓库里实现。

## 渠道锁定

有效渠道：后台运行时设置 `videoProvider` 优先，否则 `env.VIDEO_PROVIDER`。`POST /api/generations` 把解析结果写入已有列 `generations.provider`。提交、重试、轮询、回调都只读这一列，不再读当时的运行时设置。

切换大约 60 秒（KV `cacheTtl`）后只影响新工单。已排队或处理中的工单继续原渠道。没有第二审计列，也没有迁移。

`mock` 只在 `APP_ENV` 不是 `production` / `staging` 时合法（development、`preview`）。staging 和 production 保存与执行都拒绝 mock。

## 推送契约

aimov 主动 `submit` 和 `status`，和 fal、yir 一样。`/api/webhooks/opengen` 只校验工单 token，然后立刻排一次轮询。它不是结果来源。

| 动作 | 方法 | 路径 |
| --- | --- | --- |
| 提交 | `POST` | `{OPENGEN_BASE_URL}/v1/aimov/jobs` |
| 查询 | `GET` | `{OPENGEN_BASE_URL}/v1/aimov/jobs/{id}` |
| 探测 | `GET` | `{OPENGEN_BASE_URL}/v1/aimov/health` |

`OPENGEN_BASE_URL` 可以带路径前缀。尾部斜杠会去掉。地址里不能有用户名、密码或查询串。production / staging 只要 `https`（公网或隧道）。development / preview 另接受 `http`，方便本机 OpenGen。

鉴权：`Authorization: Bearer <OPENGEN_API_KEY>`。这是连接密钥，不是厂商 Key。

提交请求头 `Idempotency-Key` 等于 aimov 的 generation id。正文只有：

- `generation_id`
- `duration_seconds`
- `image_url`
- `source_video_url`
- `webhook_url`（仅当站点地址是 `https`；本地不带，改靠轮询）

响应：

- `200` 或 `201`，且 JSON 有 `id`：新任务。
- `409` 且 JSON 有 `id`：同一 generation id 已有任务，aimov 复用这个 id（`meta.reused`），不另建厂商任务，也不另扣用户积分。
- `409` 没有 `id`：失败，不重试。

查询把 `status` 映射为：

- `queued` / `processing` / `running` / `pending` / 空：继续等。
- `succeeded` / `completed` / `success`：要有 `output_url`。可选数字 `cost_cents` 记入 `generations.provider_cost_cents`（服务商成本，不是再向用户扣一次）。
- `failed`：终态失败并退点。`error.retryable === true` 时改成可重试，交回队列。

HTTP `408` / `429` / `5xx` 可重试。`401` / `403` 记 `opengen_unauthorized`，不重试，并计入「视频服务商账户」告警。没配 URL 或 Key 记 `provider_not_configured`，不重试，探测文案含「未配置」（不是 skipped）。错误文本里出现的 API Key 会换成 `***`。

单价表未约定。`site.video.opengen.costCentsPerSecond` 默认 `0`，只在 OpenGen 没回 `cost_cents` 时作估算。用户扣点仍是时长档位上的积分。

## 联调 stub

`OPENGEN_STUB=1` 且 `isProduction` 为假时，适配器不发网络请求。提交得到稳定的 `opengen_stub_<generation id>`，`meta.integration` 为「联调」。到点后把模板源视频当作成片（和 mock 一样由 jobs 复制进 R2）。`meta.stubOutcome === 'fail'` 时失败，文案含「联调」。

这是联调，不是真实厂商验收。staging / production 忽略 stub，上线检查在 `VIDEO_PROVIDER=opengen` 且 `OPENGEN_STUB=1` 时报错。

## 可达性

Worker 必须能访问 `OPENGEN_BASE_URL`。公网 HTTPS 或隧道都可以。本仓库不负责在 Bot 上长期暴露公网。本地可以用 stub，或把 development 的 base URL 指到本机 OpenGen。

真实成功验收（Worker 打到可达的 OpenGen，并拿到可播放成片）留给运维。单元测试用假的 `fetch` 和 stub，不证明厂商侧出片。

## 相关代码

- `src/server/video/opengen.ts`：适配器
- `src/server/video/index.ts`：`resolveEffectiveVideoProvider`
- `src/server/settings.ts`：后台渠道字段
- `src/server/probes.ts`：探测与创建用同一次解析
- `docs/env.md`：变量说明
