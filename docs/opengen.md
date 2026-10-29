# OpenGen 视频渠道

aimov 把 OpenGen 当作又一个 `VideoProvider`（`opengen`）。厂商 Key 留在 OpenGen 主机。aimov 只保存连接信息：`OPENGEN_BASE_URL` 和 `OPENGEN_API_KEY`。用户积分仍只记在 aimov（`generation:<id>` / `generation_refund:<id>`）。OpenGen 不维护第二套用户积分账本。

本文件是 aimov **推送**过去的契约。OpenGen 主机不在本仓库里实现。

## 渠道锁定

全站一个 `fulfillmentMode`：`manual` 或 `auto`。没有按模板分轨。`manual` 保留：扣积分、写 Google 表格镜像、人回填，不调用 Yir / FAL / OpenGen。

`auto` 的新工单在 **Yir / FAL / OpenGen** 中三选一（选哪个走哪个）。后台「当前视频生成渠道」或环境变量 `VIDEO_PROVIDER`（`yir` | `fal` | `opengen`，非生产还可 `mock`）决定新单。settings 覆盖优先于 env。OpenGen 与 Yir、FAL 同级，不是主通道加备用。

选 OpenGen 时用 `OPENGEN_BASE_URL` + 本站 `OPENGEN_API_KEY`（`ogsk_`）。厂商 Key 留在 OpenGen 主机。选 OpenGen 不要求站上有 `FAL_KEY` 或 `YIR_API_KEY`。选 Yir 要 `YIR_API_KEY`，选 FAL 要 `FAL_KEY`。缺所选渠道时，新单在扣积分前拒绝，文案含「未配置」。

`EMERGENCY_VIDEO_PROVIDER` 不再参与日常选路，也不再与 OpenGen 互斥。旧部署可以留着这个空变量。要改渠道，直接保存 Yir、FAL 或 OpenGen。

`nanoapi` 适配器仍在，供在途工单使用。是否进入日常下拉（四选一）待确认。本需求不把它加进日常必选，也不删除适配器。

OpenGen 网关内的多上游或 failover 不是本站三选一的前置，本仓库不定那条线的排期。登录和支付也不迁入 OpenGen。

`POST /api/generations` 把当时的通道写入 `generations.provider`（`manual` | `yir` | `fal` | `opengen`，非生产还可 `mock`）。提交、重试、轮询、webhook 只读这一列。切换大约 60 秒后只影响新工单。在途工单保持创建时的 provider，不改道、不二次扣积分。同一 generation 不得同时走两家自动渠道，也不得人工与自动双领。

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

对账按 `(站点密钥里的 site，generation id)` 查 `GET /v1/aimov/jobs/{generationId}`。一次 404 或一次查询失败不是「确认没有任务」。任务 id 已经写下就保持 OpenGen，不再改人工。这条「提交前不可达则同一 `generation_id` 改人工」只适用于所选渠道是 OpenGen 的时候：不改走 fal / yir / nanoapi，不二次扣积分。直接选 Yir 或 FAL 时，不套用这条改人工的契约。结果不明则冻结在当时的 OpenGen 行上，不另开第二条自动轨道。`succeeded` / 已退款之后，迟到的成片或回调不改终态，也不再退一次。

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
- `src/server/auto-route.ts`：新工单在 Yir / FAL / OpenGen 中三选一
- `src/server/video/index.ts`：日常下拉，以及按 `generations.provider` 取适配器（含在途 nanoapi）
- `src/server/settings.ts`：后台渠道字段
- `src/server/probes.ts`：探测与创建用同一次解析
- `docs/env.md`：变量说明
