# ProxyGosha — 基于 Cloudflare Workers 的 Telegram WEB 代理

> 运行在 Cloudflare 免费配额上的 Telegram 私有代理。单文件、单一配置项，无需租用或维护任何服务器。

<p align="center">
  <a href="https://github.com/amirmarandidev/ProxyGosha/stargazers"><img src="https://img.shields.io/github/stars/amirmarandidev/ProxyGosha?style=for-the-badge&color=gold" alt="GitHub Stars"></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://desktop.telegram.org/"><img src="https://img.shields.io/badge/Telegram-WEB%20Proxy-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram WEB Proxy"></a>
  <a href="../LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT"></a>
</p>

<p align="center">
  <a href="../README.md"><b>English</b></a> •
  <a href="README.ar.md"><b>العربية</b></a> •
  <a href="README.fa.md"><b>فارسی</b></a> •
  <a href="README.ru.md"><b>Русский</b></a> •
  <a href="README.zh.md"><b>简体中文</b></a> •
  <a href="llms.txt"><b>llms.txt</b></a>
</p>

---

## 📺 视频安装配置教程

> [!TIP]
> 如果您更喜欢直观的视频演示，可以在 YouTube 上观看完整的分步配置指南：  
> ▶️ **[在 YouTube 上观看视频教程](https://youtu.be/7StSCQdpqvk)** *(附带清晰明了的屏幕操作演示)*

<p align="center">
  <a href="https://youtu.be/7StSCQdpqvk">
    <img src="https://img.youtube.com/vi/7StSCQdpqvk/maxresdefault.jpg" alt="ProxyGosha 视频教程" width="700">
  </a>
</p>

<p align="center">
  <a href="https://t.me/amirdotlog"><img src="https://img.shields.io/badge/Telegram-amirdotlog-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Channel"></a>
  <a href="https://www.youtube.com/@amirmarandidev"><img src="https://img.shields.io/badge/YouTube-amirmarandidev-red?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube Channel"></a>
</p>

> [!NOTE]
> 📢 **Telegram 官方频道：** 获取纯净可用域名、最新更新公告与搭建技巧：**[t.me/amirdotlog](https://t.me/amirdotlog)**  
> 🔴 **YouTube 视频频道：** 订阅获取更多视频教程与抗审查技术解析：**[youtube.com/@amirmarandidev](https://www.youtube.com/@amirmarandidev)**

---

## ✨ v1.5.1 版本更新内容

本次更新重点提升**不同网络运营商环境下的真实连接稳定性**——尤其是对上传限速或容易断开多条并发连接的移动网络——同时在家庭宽带等畅通网络下保持高速体验。

- 📶 **按网络环境准备好的专属链接（零额外配置，即开即用）：** 不同运营商限制不同。现在管理面板会自动生成多组专属链接：**高速 / 家庭宽带**、**移动网络单通道**（适合上传限速或限制并发 WebSocket 的运营商）、**移动网络多通道**，以及可选的**纯 HTTPS 模式**（适合封锁 WebSocket 的网络）。您可以把需要的都添加到 Telegram 中，一键切换。
- 🎛️ **在面板中实时切换主链接模式（可选免费 KV）：** 如果想直接修改**原有主链接**的工作模式，而不想重新发链接或重新部署代码，只需绑定一个免费的 Cloudflare KV（`SETTINGS_KV`，30 秒搞定，无需信用卡），即可在面板里一键保存生效。
- 🔁 **上传更顺畅 + 自动安全回退：** 在上传较慢的移动网络下，图片、语音和文件会自动拆成更小的数据块发送，避免发图时整个聊天卡死或超时断线；如果多通道模式连接受阻，会在不丢消息的前提下自动切换为单通道模式。
- 🧭 **更聪明的 Telegram 服务器连接策略：** 当通往 Telegram 数据中心的 `443` 端口超时或受阻时，Worker 会自动尝试其他 IP 以及备用端口（`80`、`5222`），不再原地死等。
- 🕵️ **更强的防主动探测伪装：** 扫描器直接探测隐藏路径（如 `/?bridge=...`、`/api/v1/session`、`/api/v1/ws`、`/health`）时，现在统一返回正常伪装网站，不再暴露可疑报错页。
- 🩺 **清晰的 5 阶段诊断页（`/status`）：** 一步步展示连接卡在了哪里（连上 Cloudflare → 加载桥接页 → 创建会话 → WebSocket/HTTPS 传输 → 连接 Telegram），且绝不记录任何密码、密钥或用户 IP。
- 🔒 **可选的真实 HTTPS 长轮询模式（`PROXY_DO`）：** 针对彻底封锁 WebSocket 但放行普通 HTTPS 的网络，可通过绑定免费的 SQLite Durable Object 启用。未绑定时，面板会如实提示未启用，绝不虚假显示。
- ✅ **旧链接完全不受影响：** 所有历史密钥和链接 100% 保持兼容，只需粘贴新版 `worker.js` 并点击 **部署 (Deploy)**。

<details>
<summary><b>历史版本记录（v1.2.3 与 v1.2.2）</b></summary>

- **v1.2.3：** 修复 **Cloudflare 错误 1101**，全面兜底异常并返回正常伪装商城页面；改进错误日志与 `DECOY_URL` 兼容性。
- **v1.2.2：** 修复超时套接字泄漏、更新 Telegram 官方 DC IP、新增上行数据合并优化降低 CPU 占用，并加入 `/<ADMIN_KEY>/status` 状态页（鸣谢 EmadReza）。

</details>

---

## 这是什么

Telegram 内置了一种名为 **WEB** 的代理协议。与传统 MTProto 代理不同，它以普通 HTTPS 网页流量的形态传输，因此可以运行在 Cloudflare 背后。

ProxyGosha 可以把一个免费的 Cloudflare Worker 变成这样的私人代理。

**用最简单的话说：** Cloudflare 是承载全球大量网站的巨型网络，彻底封锁它的代价很高。您的 Worker 就像跑在这个大网络里的一个小中转站：Telegram 像访问普通网站一样连到它，它再把加密数据转发给 Telegram 官方服务器。

- **看起来就像正常网站。** 任何人用浏览器打开您的网址，看到的都是一家普通网店（或您通过 `DECOY_URL` 设置的合法网站）。
- **无法偷看您的聊天记录。** Telegram 在客户端与服务器之间全程加密，代理只负责转发密文字节。
- **运行零成本。** 完全使用 Cloudflare 免费额度。唯一可能产生费用的是域名（也有免费方案）。

---

## 准备工作

您需要：

1. **一个 Cloudflare 账号。** 免费注册：[dash.cloudflare.com](https://dash.cloudflare.com/)。
2. **一个自定义域名（强烈推荐）。** 默认的 `workers.dev` 在部分地区已被封锁，绑定任意免费或平价域名会稳定得多。
3. **支持 WEB 代理的 Telegram 客户端。** Telegram Desktop 电脑端已支持；手机端取决于您安装的版本是否包含 WEB 代理选项。

---

## 部署教程 — 简单五步

### 第 1 步 — 创建 Worker

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)。
2. 进入 **Workers 和 Pages** → **创建应用程序** → **创建 Worker**。
3. 随便起个名字（例如 `my-tg-proxy`），点击 **部署 (Deploy)**。

### 第 2 步 — 粘贴代码

1. 进入刚才创建的 Worker，点击 **编辑代码 (Edit code)**。
2. 清空编辑器里的默认内容，粘贴本仓库 [`worker.js`](../worker.js) 的完整代码。
3. 点击 **部署 (Deploy)**。

### 第 3 步 — 设置管理密码（唯一必填项）

1. 用浏览器打开您的 Worker 网址，页面会自动给出一个随机密码，复制它。
2. 回到 Cloudflare 控制台打开该 Worker → **设置 (Settings)** → **变量和机密 (Variables and Secrets)** → **添加 (Add)**：
   - **名称 (Name)：** `ADMIN_KEY`
   - **值 (Value)：** 刚才复制的密码（或任意至少 16 位英文字母与数字组合）
3. 点击 **部署 (Deploy)**。

> [!IMPORTANT]
> 请像保管密码一样保管 `ADMIN_KEY`。知道它的人都能打开您的管理面板并复制代理链接。

### 第 4 步 — 绑定自定义域名

1. 把您的域名添加到 Cloudflare，并把域名注册商处的名称服务器（NS）改成 Cloudflare 给出的两个地址。
2. 在 Worker 中进入 **设置 (Settings)** → **域和路由 (Domains & Routes)** → **添加** → **自定义域 (Custom Domain)**。
3. 输入一个子域名，例如 `tg.yourdomain.com`。Cloudflare 会自动配置 DNS 和 HTTPS 证书。

> [!TIP]
> **如果您经网站所有者授权，使用现有真实网站的子域名：**  
> 迁移 DNS 到 Cloudflare 前，请务必完整保留原网站、邮箱（`MX`、`TXT`）等所有记录，并保持为 **仅 DNS（灰色云朵）** 以免影响原网站与邮件服务，只把单独的代理子域名绑定给 Worker。

#### 🌐 为什么强烈建议绑定自定义域名

> [!WARNING]
> Cloudflare 默认的 **`workers.dev`** 域名在**伊朗**、**中国大陆**、**俄罗斯**等地区普遍被阻断。  
> 为确保顺畅连接，**请为 Worker 绑定自定义域名。**

获取域名的常见方式：

- ☑️ **免费域名：**  
  可通过 **[digitalplat](https://domain.digitalplat.org/)** 等平台免费申请域名并接入 Cloudflare。
- ❇️ **国家顶级域名（如 `.ir`、`.ru` 等）：**  
  - 价格通常较低，但审核（例如 [nic.ir](https://nic.ir/)）一般需要 **1–2 个工作日**。
  - ⚠️ **注意：** 国家域名通常关联真实身份，请谨慎合规使用，切勿未经许可使用他人域名。
- ‼️ **平价国际域名（支持加密货币或外币卡）：**  
  在 **[Namecheap](https://namecheap.com/)** 等平台，`.xyz`、`.top` 等后缀常低于 1 美元。

### 第 5 步 — 打开面板并连接

浏览器访问：

```text
https://tg.yourdomain.com/YOUR_ADMIN_KEY
```

面板里有两种添加方式：

- **一键添加：** 直接点击 **Connect in Telegram** 按钮。
- **手动输入（官方 Telegram WEB 代理默认固定使用 `443` 端口，无需填写端口）：**

| 字段 | 填写内容 |
|---|---|
| 服务器 (Server) | `tg.yourdomain.com` |
| 密钥 (Secret) | 默认主链接的密钥（或您选择的对应网络模式密钥） |

Telegram 中的添加位置：

- **电脑端 (Desktop)：** 设置 → 高级 → 连接类型 → 使用自定义代理 → 添加代理 → **WEB**
- **手机端 (Mobile)：** 设置 → 数据和存储 → 代理 → 添加代理 → **WEB** *(取决于客户端版本)*

**搞定！** 分享给亲友时，**只发 `tg://webproxy` 链接（或服务器 + 密钥）**，千万不要分享管理面板网址。

---

## 为不同网络选择合适的模式（专属链接与面板实时设置）

不同宽带和手机运营商的限制差异很大：家用宽带通常畅通高速，而某些手机运营商可能限速上传或干扰多条并发连接。ProxyGosha 提供**两种简单办法**：

### 方法 1 — 按网络区分的现成链接（无需 KV，立刻生效）

在面板的域名下方，您可以直接看到几组现成模式。每种模式有各自独立的密钥，因此**同一个 Worker 可以同时让家里宽带跑高速模式、手机卡跑单通道抗限速模式，互不干扰**：

| 模式 | 适用场景 | 实际区别 |
|---|---|---|
| **默认主链接 (Default)** | 日常通用 | 均衡参数（如绑定了 `SETTINGS_KV`，则由面板设置控制）。100% 兼容旧链接。 |
| **高速模式 (`fast`)** | 家庭光纤 / ADSL / 无限制运营商 | 多通道 WebSocket + `1 MiB` 大数据块，追求最高下载与上传速度。 |
| **移动单通道 (`mobile-mux`)** | 限制多连接或上传较慢的手机网络（如 Irancell） | **仅开 1 条 WebSocket**，上传拆成 `32 KiB` 小块（发图发语音不卡聊天），4 次连接重试，耐心超时 `75s`。 |
| **移动多通道 (`mobile-lanes`)** | 允许并发连接但上传偏慢的手机网络 | 多通道 + `64 KiB` 小块，受阻时更快自动回退到单通道。 |
| **纯 HTTPS (`https-do`)** | 彻底封锁 WebSocket 但放行 HTTPS 的网络 | 真实 HTTPS 长轮询。**仅在绑定可选 `PROXY_DO` 后启用**（见下文）。 |

### 方法 2 — 直接在面板实时修改原有主链接（可选免费 `SETTINGS_KV`）

如果您已经把主链接发给了亲友，希望直接在面板里点按钮（如**快捷：高速**或**快捷：移动单通道**）即时切换它的模式：

1. 在 Cloudflare 控制台进入 **存储和数据库 (Storage & Databases)** → **KV** *(或 **Workers 和 Pages** → **KV**)*。
2. 点击 **创建实例 (Create instance)**，随便起个名字（如 `proxygosha-settings`）并创建。
3. 打开您的 Worker → **设置 (Settings)** → **绑定 (Bindings)** → **添加 (Add)** → **KV 命名空间 (KV Namespace)**。
4. **变量名称 (Variable name)** 必须严格大写填写：**`SETTINGS_KV`**，选择刚创建的 KV，然后点击 **部署 (Deploy)**。
5. 打开面板（`https://tg.yourdomain.com/YOUR_ADMIN_KEY`），顶部会出现绿色标签 **`SETTINGS_KV active`**。选择模式保存后，在 Telegram 中关闭再重新开启一次代理即可生效。

> [!NOTE]
> Workers KV **完全免费**且无需信用卡（每天 100,000 次读取、1,000 次写入）。当前节点立即生效，全球节点约 60 秒内同步；KV 中不会存储任何密码、密钥或用户 IP。

---

## 实时状态与 5 阶段诊断（`/status`）

打开：

```text
https://tg.yourdomain.com/YOUR_ADMIN_KEY/status
```

页面将连接拆为 **5 个清晰阶段**，一眼定位问题所在：

1. **访问 Cloudflare（DNS / TLS）** — 您的网络是否到达了域名？同时显示当前 Cloudflare 节点代码（PoP）、HTTP 版本与 TLS 版本。
2. **桥接握手（Bridge）** — Telegram 内置 WebView 是否加载了代理页？
3. **会话建立（Session）** — 是否成功初始化会话？
4. **数据传输（WebSocket / HTTPS）** — 如果第 3 步成功但第 4 步一直为 `0`，通常是运营商封锁或干扰了 WebSocket → 请尝试 `mobile-mux` 或可选 `PROXY_DO`。
5. **连接 Telegram 数据中心（DC）** — 支持一键测试 Cloudflare 到 Telegram 各机房的连通性（**`?probe=1`**）。

> [!NOTE]
> - **统计数据仅保存在单个节点的临时内存中：** 看到数字为 `0` 很正常，可能是 Telegram 连到了与您浏览器不同的 Cloudflare 节点。
> - **DC 探测只测试 Cloudflare → Telegram（第 5 步）：** 探测通过并不代表您本地网络一定能连上 Cloudflare。
> - **隐私优先：** 绝不在 `/status` 或日志中保存或显示任何用户 IP、`ADMIN_KEY`、密钥或令牌。

---

## 关于端口的诚实说明

Cloudflare 自定义域支持六个 HTTPS 端口：`443` · `2053` · `2083` · `2087` · `2096` · `8443`。

但目前**官方 Telegram WEB 代理客户端仅固定使用标准 `443` 端口**，会忽略 `&port=` 参数。  
面板仍在折叠区保留了全部 6 个端口的链接和独立密钥以兼容旧链接或第三方客户端；**而在官方 Telegram 中，切换网络模式或准备备用自定义域名才是真正有效的办法。**

---

## 配置项参考

只有 `ADMIN_KEY` 是必填项，其余均为可选项。

### 环境变量（**Settings → Variables and Secrets**）

| 变量名 | 说明 |
|---|---|
| `ADMIN_KEY` | **必填。** 面板密码（至少 16 位字母数字）。未设 `SECRET` 时用于派生代理密钥。 |
| `SECRET` | 固定 32 位十六进制密钥（或 `dd` + 32 位）。设置后，日后修改 `ADMIN_KEY` 也不会导致旧链接失效。 |
| `EXTRA_HOSTS` | **已绑定到此 Worker** 的其他自定义域名，用英文逗号分隔。*(仅填写此项不会自动配置 DNS 或 SSL。)* |
| `DECOY_URL` | **您拥有或获授权使用的**真实 `https://` 网站地址，用于替代内置伪装商城。 |
| `CARRIER` | 默认 `websocket-lanes`。可设为 `websocket`（单通道），或 `https` *(仅绑定 `PROXY_DO` 时生效，否则如实回退并警告)*。 |
| `WS_AUTO_FALLBACK` | 默认 `true`，设为 `false` 可关闭 `websocket-lanes → websocket` 自动回退。 |
| `SESSION_PATH`, `WS_PATH`, `UP_PATH`, `DOWN_PATH` | 可选自定义路径，替代默认的 `/api/v1/*`。 |

### 可选免费绑定（**Settings → Bindings**）

| 绑定变量名 | 类型 | 作用 |
|---|---|---|
| `SETTINGS_KV` | Workers KV Namespace | 开启面板实时保存主链接全局设置（免费，每日 10 万次读取）。 |
| `PROXY_DO` | SQLite Durable Object (`ProxySessionDO`) | 开启真正的 **`CARRIER=https`** 长轮询，应对彻底封锁 WebSocket 的网络。 |

<details>
<summary><b>如何在 Cloudflare 免费版启用可选的真实 HTTPS 模式（<code>PROXY_DO</code>）</b></summary>

普通无状态 Worker 无法在多次 HTTP 请求之间维持 TCP 连接，因此真实 HTTPS 长轮询需要 Cloudflare 免费的 **SQLite Durable Object**（`ProxySessionDO` 已内置在 `worker.js` 中）：

1. 在 `worker.js` 同目录放置 `wrangler.toml`：
```toml
name = "proxygosha"
main = "worker.js"
compatibility_date = "2026-01-01"

[[durable_objects.bindings]]
name = "PROXY_DO"
class_name = "ProxySessionDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["ProxySessionDO"]
```
2. 运行 `wrangler deploy` 部署。
3. 之后可以直接使用面板里的**纯 HTTPS (`https-do`)** 专属链接（其他用户仍走零消耗的 WebSocket），或设置 `CARRIER=https`。

**免费 Durable Objects 额度提示：** 每日 **100,000 次请求**与 **13,000 GB-s**（约合单人每天 28 小时活跃会话），适合个人与小圈子使用，不适合公开分发。

</details>

> [!WARNING]
> 若未设置 `SECRET`，修改 `ADMIN_KEY` 会同步改变所有派生密钥，**之前分享的全部链接都将失效。**

---

## 强封锁环境排查建议

请按顺序逐项尝试（每次只改一项，方便判断哪个有效）：

1. **切换网络模式。** 手机网络卡顿或发图断线时，优先尝试面板中的**移动单通道 (`mobile-mux`)**；若 WebSocket 被彻底封锁，可尝试可选的 **`PROXY_DO` + 纯 HTTPS**。
2. **换用备用自定义域名。** 将第二个自有域名绑定到 **Custom Domain** 并加入 `EXTRA_HOSTS`。
3. **使用 Cloudflare 优选 IP（仅电脑端）**，修改 `hosts` 文件：
   - Windows：`C:\Windows\System32\drivers\etc\hosts`
   - macOS / Linux：`/etc/hosts`

   ```text
   CLEAN_IP   tg.yourdomain.com
   ```

   优选 IP 因运营商而异且会随时间失效，请在自己的网络下实测。
4. **在阻断地区关闭 ECH（如俄罗斯）。** 在 Cloudflare 控制台打开域名 → **SSL/TLS** → **Edge Certificates** → **Encrypted Client Hello (ECH)** → **Off**。

> [!NOTE]
> 在**完全切断国际互联网出口**时，任何基于 Cloudflare 的代理都无法工作。以上方法适用于限速、干扰与部分封锁环境。

---

## 常见故障排查

| 现象 | 处理办法 |
|---|---|
| 打开域名显示一家服装网店 | 完全正常！代理就在背后运行，网址末尾加上 `/YOUR_ADMIN_KEY` 即可打开面板。 |
| 面板网址依然显示网店 | 网址里的密码与 `ADMIN_KEY` 不符，或修改变量后忘了点 **Deploy**。 |
| 再次出现设置引导页 | 未配置 `ADMIN_KEY` 或长度不足 16 位。 |
| 能连上但发图片/文件时卡死断线 | 改用面板里的**移动单通道 (`mobile-mux`)** 链接（小块发送，防上传阻塞）。 |
| 一直显示“连接中…” | 打开 `/<ADMIN_KEY>/status` 查看卡在 5 个阶段中的哪一步；先试 `mobile-mux`，再换备用域名（不要用 `workers.dev`）。 |
| 面板提示“No KV binding” | 完全没关系！下方各网络专属链接无需 KV 即可直接使用；若想在线改主链接，30 秒绑定免费 `SETTINGS_KV` 即可。 |
| 面板警告 `CARRIER=https` 未启用 | 真实 HTTPS 模式需要绑定可选 `PROXY_DO`；未绑定时 Worker 会如实使用 WebSocket。 |
| 已连上但 `/status` 计数为 `0` | 正常现象，Cloudflare 有多个边缘节点，各自独立保存临时内存计数。 |
| 分享出去的旧链接突然连不上 | 在未设 `SECRET` 时修改了 `ADMIN_KEY`，请从面板重新发送新链接。 |

---

## 常见问题 (FAQ)

<details>
<summary><b>哪些 Telegram 客户端可以使用？</b></summary>
任何提供 <b>WEB</b> 代理类型的客户端均可。Telegram Desktop 已原生支持；Android 与 iOS 取决于您安装的版本是否包含该选项。
</details>

<details>
<summary><b>切换高速 / 移动模式真的能改变手机发包方式吗？</b></summary>
是的。在 WEB 代理模式下，Worker 会把运行在 Telegram 内置 WebView 里的桥接脚本发给您的设备。切换模式会真实改变并发 WebSocket 数量、每次上传分块大小（32 KiB 对比 1 MiB）以及超时重试策略。它无法突破彻底的 IP/域名封锁，但在限速或波动的移动网络下效果很明显。
</details>

<details>
<summary><b>一个代理可供多少人使用？</b></summary>
适合个人和亲友小圈子（Cloudflare 免费版每天 100,000 次请求）。人数较多时建议分组各自部署 Worker。
</details>

<details>
<summary><b>Cloudflare 或代理能看到我的聊天内容吗？</b></summary>
不能。Telegram 在您的客户端与官方服务器之间全程端到端加密，代理只转发密文。
</details>

<details>
<summary><b>支持添加赞助频道（Ad Tag）吗？</b></summary>
不支持。赞助频道要求固定的出站 TCP 端口，而 Cloudflare Workers 的共享出口会动态转换端口，因此代理直连 Telegram 且无广告。
</details>

---

## 免责声明

本项目仅供教育学习与个人测试使用。在 Cloudflare Workers 上运行代理服务可能与 Cloudflare 服务条款（第 2.2.1(j) 条）存在冲突，请自行承担使用责任。

---

## 项目支持

ProxyGosha 免费且开源。欢迎在 GitHub 点亮 ⭐ 或通过加密货币支持开发：

- **USDT (BEP20):** `0xd593ae9D32bEA690EC62460C54BF3951aFFF7803`
- **USDT (TRC20):** `THaaHzoTwXfUfcrtYTDXRsMmk9qhnXa56M`
