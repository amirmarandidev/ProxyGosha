# ⚡ 基于 Cloudflare Workers 的免费 Telegram WEB 代理

> **专属于您的 Telegram（电脑端、安卓及 iOS）100% 免费私有代理 —— 无需购买 VPS 服务器、零运维成本、2分钟极速部署。**

<p align="center">
  <a href="https://github.com/amirmarandidev/ProxyGosha/stargazers"><img src="https://img.shields.io/github/stars/amirmarandidev/ProxyGosha?style=for-the-badge&color=gold" alt="GitHub Stars"></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://desktop.telegram.org/"><img src="https://img.shields.io/badge/Telegram-WEB%20Proxy-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram WEB Proxy"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT"></a>
  <img src="https://img.shields.io/badge/Cost-%240%20%2F%20Free-brightgreen?style=for-the-badge" alt="Cost Free">
</p>

<p align="center">
  <a href="README.md"><b>English</b></a> •
  <a href="README.fa.md"><b>فارسی</b></a> •
  <a href="README.ru.md"><b>Русский</b></a> •
  <a href="README.zh.md"><b>简体中文</b></a> •
  <a href="llms.txt"><b>llms.txt</b></a>
</p>

---

### 🌟 这是什么？（通俗易懂版 / ELI5）

Telegram 推出了一种新型且高抗封锁的 **WEB Proxy** 代理协议（适用于所有 Telegram 客户端：电脑端、安卓与 iOS，只要其更新版本支持/启用了 WEB 代理功能）。与传统需要每月租用昂贵 VPS 服务器并配置复杂 Linux 环境的方式不同，本项目利用免费的 **Cloudflare Workers** 边缘无服务器环境，将其打造成您的专属私有 Telegram 代理。

* 🌐 **伪装成普通网站：** 如果审查系统或普通访客在浏览器中打开您的域名，只会看到一个无害的普通网页（显示 "Welcome - This site is online"），隐蔽性极高。
* 🚀 **极速连接 Telegram：** 当 Telegram 客户端连接此域名时，流量会通过 Cloudflare 的全球边缘网络安全隧道直达 Telegram 官方数据中心。
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

#### 第 6 步：在 Telegram 客户端（电脑端、安卓或 iOS）连接！
在任何支持 WEB Proxy 选项的 Telegram 客户端中（例如 Telegram Desktop）：
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

### 🛡️ 强封锁环境抗干扰配置指南（中国、伊朗、俄罗斯）

若在封锁加剧期间遇到连接重置、断连或速度受限：

1. **启用 Cloudflare 备用安全端口（当 443 端口受阻时）：**  
   Cloudflare 支持多个标准的 HTTPS / WSS 端口：  
   `8443` • `2053` • `2083` • `2087` • `2096`  
   在 Telegram Desktop 中可直接将端口改为 `8443` 或 `2053`，或使用链接格式：  
   `tg://webproxy?server=tg.yourdomain.com&port=8443&secret=YOUR_SECRET`

2. **优选 Clean IP 绑定（通过 hosts 文件避免 Anycast 阻断）：**  
   当电信/联通或当地运营商劣化 Cloudflare 默认 Anycast IP 时，可在系统 `hosts` 文件中将域名指向 Clean IP：  
   * **Windows：** `C:\Windows\System32\drivers\etc\hosts`  
   * **macOS / Linux：** `/etc/hosts`  
   * 添加一行例如：`162.159.36.1   tg.yourdomain.com`  
   *(此操作仅重定向 IP，依然保留正确的 SNI 与证书校验，不会破坏代理连接)*

3. **在 Cloudflare 控制台中关闭 ECH（对俄罗斯及部分网络至关重要）：**  
   俄罗斯 RKN 及部分审查系统会阻断带有 ECH (Encrypted Client Hello) 的 TLS 握手。  
   在 Cloudflare 仪表盘进入您的域名设置：  
   **SSL/TLS** > **Edge Certificates** > **Encrypted Client Hello (ECH)** = **Disabled (关闭)**

---

### ❓ 常见问题 (FAQ)

<details>
<summary><b>此代理支持所有 Telegram 客户端（电脑端、安卓和 iOS）吗？</b></summary>
<b>是的，完全支持！</b> 该代理适用于<b>所有 Telegram 官方客户端（电脑端、Android 和 iOS）</b>，前提是您的 Telegram 客户端更新中已启用或支持 <b>WEB</b> 代理类型。Telegram Desktop 桌面端原生已全面支持；移动端（安卓及 iOS）只要在客户端更新中启用了 WEB 代理功能，均可使用同一链接与配置秒速连接。
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
