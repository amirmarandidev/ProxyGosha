# ⚡ 基于 Cloudflare Workers 的免费 Telegram WEB 代理

> **专属于您的 Telegram 电脑端 100% 免费私有代理 —— 无需购买 VPS 服务器、零运维成本、2分钟极速部署。**

[English](README.md) • [فارسی](README.fa.md) • [Русский](README.ru.md) • [简体中文](README.zh.md)

---

### 🌟 这是什么？（通俗易懂版 / ELI5）

Telegram 桌面客户端（Telegram Desktop）支持一种新型的 **WEB Proxy** 代理协议。与传统需要每月租用昂贵 VPS 服务器并配置复杂 Linux 环境的方式不同，本项目利用免费的 **Cloudflare Workers** 边缘无服务器环境，将其打造成您的专属私有 Telegram 代理。

* 🌐 **伪装成普通网站：** 如果审查系统或普通访客在浏览器中打开您的域名，只会看到一个无害的普通网页（显示 "Welcome - This site is online"），隐蔽性极高。
* 🚀 **极速连接 Telegram：** 当 Telegram 电脑版连接此域名时，流量会通过 Cloudflare 的全球边缘网络安全隧道直达 Telegram 官方数据中心。
* 💰 **完全免费（0 元成本）：** 100% 运行在 Cloudflare 免费套餐配额内，无需绑定信用卡，无需购买任何服务器。

---

### ✨ 核心亮点

* 🆓 **永久免费：** 告别 VPS 月租费用与繁琐续费。
* 📁 **单文件极简部署 (`worker.js`)：** 无需安装依赖，无需编译，直接在 Cloudflare 控制台复制粘贴。
* 🛡️ **内置伪装页面：** 浏览器访问时展示正常静态欢迎页，抗探测、防封锁。
* ⚡ **全球低延迟：** 依托 Cloudflare Anycast 全球边缘网络加速。
* 🔒 **端到端加密与隐私保护：** 传输内容采用 Telegram 原生 MTProto 协议加密，任何第三方（包括 Cloudflare）均无法解密或窥探您的聊天内容。

---

### 🚀 3 分钟极速部署指南

只需按照以下简单步骤操作即可完成搭建：

#### 第 1 步：创建免费 Cloudflare Worker
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)（如果没有账号可免费注册）。
2. 在左侧导航栏中点击 **计算 (Workers 和 Pages)** > **创建应用程序** > **创建 Worker**。
3. 输入任意名称（例如 `tg-proxy`），点击 **部署**。

#### 第 2 步：粘贴代码
1. 进入新建的 Worker 页面，点击右上角的 **编辑代码** (Edit code)。
2. 清空代码编辑器中的所有默认代码，将本项目 [worker.js](worker.js) 的全部内容完整粘贴进去。
3. 点击右上角的 **部署** (Deploy)。

#### 第 3 步：生成专用密钥 (Secret)
在浏览器中打开您的 Worker 域名，并在末尾加上 `?create-secret`，例如：
```text
https://tg-proxy.<您的子域名>.workers.dev/?create-secret
```
页面将直接输出一个 32 位的随机十六进制密钥（例如 `e89a409cf5fc08ae7b3b2ad4fd2adf6f`），将其复制保存！

#### 第 4 步：在后台配置环境变量
1. 返回该 Worker 的管理页面，点击 **设置** (Settings) > **变量和机密** (Variables and Secrets)。
2. 在 **环境变量** (Environment Variables) 区域点击 **添加** (Add)：
   * **变量名称：** `SECRET`
   * **值：** `<粘贴第 3 步获取的 32 位密钥>`
3. 点击 **部署** 保存生效。

#### 第 5 步：绑定自定义域名 (Custom Domain)
1. 在 Worker 设置页面，点击 **设置** > **域和路由** (Domains & Routes) > **添加** > **自定义域**。
2. 输入已托管在 Cloudflare 上的域名或二级域名（例如 `tg.yourdomain.com`）。
3. Cloudflare 将自动为其签发免费 SSL 证书并开启标准的 443 端口代理。

#### 第 6 步：在 Telegram 电脑端连接！
打开 Telegram 电脑客户端：
1. 前往 **设置** (Settings) > **高级** (Advanced) > **连接类型** (Connection type) > **使用自定义代理** > **添加代理**。
2. 代理类型选择 **WEB**。
3. 填入连接信息：
   * **服务器 (Host)：** 您的自定义域名（如 `tg.yourdomain.com`）
   * **端口 (Port)：** `443`
   * **密钥 (Secret)：** `<您的 32 位密钥>`
4. 点击 **保存** 并启用即可秒速连通！🎉

> [!TIP]
> **一键分享与导入链接：**  
> 您也可以将连接信息拼接为快捷链接，点击即可在 Telegram 中一键导入：  
> `tg://webproxy?server=tg.yourdomain.com&secret=YOUR_SECRET`

---

### ❓ 常见问题 (FAQ)

<details>
<summary><b>手机版 Telegram（安卓 / iPhone）可以使用吗？</b></summary>
暂时不支持。Telegram 的 "WEB Proxy" 是专门基于网页桥接的新协议，目前仅在 <b>Telegram Desktop 电脑端</b>（Windows、macOS、Linux）受支持。手机移动端目前仅支持 SOCKS5 和标准 MTProto 协议。
</details>

<details>
<summary><b>我可以分享给家人朋友使用吗？</b></summary>
可以！直接将您的 <code>tg://webproxy?...</code> 链接发送给他们即可。在个人及小范围亲友圈日常使用下表现非常稳定。
</details>

<details>
<summary><b>可以添加赞助频道（Ad Tag 频道推广）吗？</b></summary>
不支持。Telegram 的赞助频道系统（Middle-End 协议）在握手时强制要求固定的外部出口端口。由于 Cloudflare Workers 运行在大规模无服务器共享 NAT 网络上，出口端口是动态随机分配的，会导致赞助握手失败。本项目直接采用直连官方数据中心模式，无广告且更加稳定流畅。
</details>

<details>
<summary><b>安全性如何？Cloudflare 能看到我的聊天记录吗？</b></summary>
无法看到。Telegram 的通信数据全程受 MTProto 端到端加密保护。该代理仅扮演中继转发加密网络包的角色，任何中间人（包括 Cloudflare 本身）都无法解密或窥探您的任何私人信息。
</details>

---

### ⚠️ 免责声明

本项目仅供网络协议研究、计算机教学与个人测试使用。请注意，利用 Cloudflare Workers 搭建公开代理服务可能涉及违反 Cloudflare 服务条款（第 2.2.1(j) 条）。请仅限于个人合规学习研究，切勿用于非法用途。

---

### 💖 Support the Project
This utility is free and open source. If it saves you time and simplifies your routing infrastructure, support ongoing development by giving a ⭐ on GitHub or contributing via crypto:

* 🔹 **USDT (BEP20):** `0xd593ae9D32bEA690EC62460C54BF3951aFFF7803`
* 🔸 **USDT (TRC20):** `THaaHzoTwXfUfcrtYTDXRsMmk9qhnXa56M`

---
