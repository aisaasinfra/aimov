# Google One Tap 与 Accept-Language 建议

上游模板已经有 Google 登录和 One Tap（`/api/auth/google/one-tap`，nonce cookie，`auto_select` 关闭）。本仓库在此之上补两件事，都不改登录账号的存储方式。

## One Tap

- 未登录、且配置了 `GOOGLE_CLIENT_ID` 时，在公开页加载 `https://accounts.google.com/gsi/client`。
- 后台和登录页不弹。登录页上的 Google 跳转按钮保留。
- `auto_select` 关闭：访客要在提示里确认账号。
- id_token 仍发到已有的 `POST /api/auth/google/one-tap`。服务端用 cookie 里的 nonce 核对，验签后走原来的 `upsertUser` 和会话 cookie。
- 访客关掉提示（`user_cancel`、`tap_outside`、`cancel_called`）后，记在 `sessionStorage`（`aimov.google-one-tap.dismissed`）。同一个标签页里不再弹。组件卸载时自己调用的 `cancel()` 不记成关闭。
- Google 因没有会话、冷却或浏览器不支持而没展示时，不记关闭，下次整页加载还可以再试。

## 语言建议

- 只读请求头 `Accept-Language`。不读 `cf-ipcountry`，不查 IP，不做地理定位。
- 权重最高、且本站已启用的语言（`en`、`de`、`es`、`fr`、`pt-BR`、`zh-TW`，繁体排在最后）如果和网址语言不同，页顶显示“建议切换到 {语言名}？”。`zh-TW`、`zh-HK`、`zh-Hant` 建议繁体。`zh-CN`、`zh-Hans` 和单独的 `zh` 不建议已删除的简体，也不改推繁体；后面的标签仍可匹配英文或其他语言。
- 点“切换”才用现有的语言路径跳转，并保留 query 和 hash。点“关闭”记在 `sessionStorage`（`aimov.locale-suggest.dismissed`），这个标签页里不再显示。
- 没有静默跳转。`Accept-Language` 不会改写网址。
- 横幅在浏览器里才出现，不进服务端 HTML，避免和爬虫看到的页面不一致。

## 明确不做

- 不按国家或 IP 切换语言。
- 不把 One Tap 做成第二套账号系统。
- 不在这个改动里换圣诞皮肤或品牌名。
