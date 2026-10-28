# OpenGen 视频渠道

aimov 把 OpenGen 当作又一个 `VideoProvider`（`opengen`）。厂商 Key 留在 OpenGen 主机。aimov 只保存连接信息：`OPENGEN_BASE_URL` 和 `OPENGEN_API_KEY`。用户积分仍只记在 aimov（`generation:<id>` / `generation_refund:<id>`）。OpenGen 不维护第二套用户积分账本。

本文件是 aimov **推送**过去的契约。OpenGen 主机不在本仓库里实现。

## 渠道锁定

全站一个 `fulfillmentMode`：`manual` 或 `auto`。没有按模板分轨。`auto` 的新工单只走 OpenGen（`OPENGEN_BASE_URL` + 本站 `OPENGEN_API_KEY`，密钥名仍是这个，值是站点自己的 `ogsk_`）。`VIDEO_PROVIDER=fal|yir|nanoapi` 不是目标态 auto。

`EMERGENCY_VIDEO_PROVIDER` 默认空。只有 `fal`、`yir` 或 `nanoapi` 才打开应急通道，并且不能和 OpenGen 同时配置（包括 stub、base URL 或 key）。同时配了就失败关闭，不提交。应急开关只作用于新工单，同一 `generation_id` 不能两条轨道。收口后应删掉开关，并从生产 Worker 去掉厂商密钥。本仓库的检查只报告缺口，不表示收口已经完成。

`POST /api/generations` 把当时的通道写入 `generations.provider`（日常是 `manual` 或 `opengen`）。提交、重试、轮询只读这一列。切换大约 60 秒后只影响新工单。飞行中的工单保持创建时的所有权，不二次扣积分。

不能自动的组件在 `auto` 下于扣积分前拒绝（`component_not_auto_eligible`）。不会静默改成人工。

`mock` 只在 `APP_ENV` 不是 `production` / `staging` 时作为日常 auto 的本地通道。staging 和 production 保存与执行都拒绝 mock。

## 组件

D1 在创建时写入 `component_id` 和 `component_version`。冻结期能自动的只有 `image-source-video` v1（一张图 + 源视频）。jobs 正文不带 `component_id`、`capability`、`play` 或 `site_id`。网关不保存组件 id，站点不能把它说成已经校验通过。

## 推送契约

aimov 主动 `submit` 和 `status`。站点轮询是成功与否的依据。`/api/webhooks/opengen` 丢掉正文，只校验工单 token，然后排一次轮询。终态或已退款的行不再排。回调正文不能单独标成功，也不能当成成片。

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

对账按 `(站点密钥里的 site，generation id)` 查 `GET /v1/aimov/jobs/{generationId}`。一次 404 或一次查询失败不是「确认没有任务」。任务 id 已经写下就保持 OpenGen，不再改人工。提交前连不上（请求还没发出）时，同一 `generation_id` 改为人工，不走 fal / yir / nanoapi，不二次扣积分。结果不明则冻结在 OpenGen 上，不并行第二条轨道。`succeeded` / 已退款之后，迟到的成片或回调不改终态，也不再退一次。

HTTP `408` / `429` / `5xx` 在适配器上可重试。Worker 里提交结果不明时先按上面的规则对账，不立刻再 POST。`401` / `403` 是已配置但不健康，文案含「不健康」，不是「未配置」，也不改人工。没配 URL 或 Key 在扣积分前拒绝，探测文案含「未配置」。错误文本里出现的 API Key 会换成 `***`，响应里不回显密钥。

单价表未约定。`site.video.opengen.costCentsPerSecond` 默认 `0`，只在 OpenGen 没回 `cost_cents` 时作估算。用户扣点仍是时长档位上的积分。

## 联调 stub

`OPENGEN_STUB=1` 且 `isProduction` 为假时，适配器不发网络请求。提交得到稳定的 `opengen_stub_<generation id>`，`meta.integration` 为「联调」。到点后把模板源视频当作成片（和 mock 一样由 jobs 复制进 R2）。`meta.stubOutcome === 'fail'` 时失败，文案含「联调」。

这是联调，不是真实厂商验收，也不是④。staging / production 忽略 stub，上线检查在 `VIDEO_PROVIDER=opengen` 且 `OPENGEN_STUB=1` 时报错。

## 可达性

Worker 必须能访问 `OPENGEN_BASE_URL`。探测把「未配置」和「已配置但不可达 / 不健康」分开。本机、隧道、stub 和健康检查通过都不是生产就绪，后台文案不会写成④已就绪。

真实成功验收（Worker 打到可达的 OpenGen，并拿到可播放成片）留给运维。单元测试用假的 `fetch` 和 stub，不证明厂商侧出片，也不证明④已经切换。

## 相关代码

- `src/server/video/opengen.ts`：适配器
- `src/server/auto-route.ts`：新工单的日常 auto / 应急开关
- `src/server/video/index.ts`：`resolveEffectiveVideoProvider`（飞行中的行和显式探测，不是日常 auto）
- `src/server/settings.ts`：后台渠道字段
- `src/server/probes.ts`：探测与创建用同一次解析
- `docs/env.md`：变量说明
