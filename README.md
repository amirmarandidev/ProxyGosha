# ⚡ Free Telegram WEB Proxy on Cloudflare Workers

> **Your personal, 100% free Telegram proxy (Desktop, Android & iOS) — zero servers, zero maintenance, 2-minute setup.**

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

### 🌟 What is this? (ELI5)

Telegram has introduced a modern, resilient proxy protocol called **WEB Proxy** that works across all Telegram clients (Desktop, Android, and iOS whenever the WEB proxy option is enabled in their app update). Instead of renting an expensive server or configuring complex software, this project turns a **free Cloudflare Worker** into your private Telegram proxy.

* 🌐 **Looks like a normal website:** If someone or a censorship bot opens your domain in a web browser, they just see a harmless "Welcome" page.
* 🚀 **Unblocks Telegram:** When Telegram connects to it, it securely tunnels your chats through Cloudflare’s fast global network.
* 💰 **Cost: \$0 / Month:** Runs completely on Cloudflare's generous free tier. No credit card, no VPS, no Linux terminal needed.

---

### ✨ Features

* 🆓 **100% Free Forever:** No VPS bills, no recurring subscriptions.
* 📁 **Single File (`worker.js`):** Just copy and paste into Cloudflare's dashboard editor.
* 🛡️ **Built-in Decoy Page:** Normal browser traffic sees a clean, decoy landing page.
* ⚡ **High Speed:** Powered by Cloudflare’s Anycast network worldwide.
* 🔒 **Encrypted & Private:** Encrypted end-to-end; your messages remain completely private.

---

### 🚀 3-Minute Quick Setup

Follow these simple steps to get your proxy running:

#### Step 1: Create a Free Cloudflare Worker
1. Log in to your [Cloudflare Dashboard](https://dash.cloudflare.com/) (create a free account if you don't have one).
2. Go to **Compute (Workers & Pages)** > **Create application** > **Create Worker**.
3. Choose any name (e.g., `my-tg-proxy`) and click **Deploy**.

#### Step 2: Paste the Code
1. Click **Edit code** on your new Worker page.
2. Select everything in the editor, delete it, and paste the code from [worker.js](worker.js).
3. Click **Deploy** in the top right.

#### Step 3: Generate Your Secret Key
Open your browser or terminal and visit your worker URL with `?create-secret` at the end:
```text
https://my-tg-proxy.<your-subdomain>.workers.dev/?create-secret
```
It will display your unique 32-character secret (e.g., `e89a409cf5fc08ae7b3b2ad4fd2adf6f`). Copy it!

#### Step 4: Add the Secret to Settings
1. Go back to your Worker dashboard, click **Settings** > **Variables and Secrets**.
2. Under **Environment Variables**, click **Add**:
   * **Variable name:** `SECRET`
   * **Value:** `<paste the 32-character secret from Step 3>`
3. Click **Deploy**.

#### Step 5: Connect Your Domain
1. In the Worker settings, click **Settings** > **Domains & Routes** > **Add** > **Custom Domain**.
2. Enter your domain or subdomain (e.g., `tg.yourdomain.com`).
3. Cloudflare will automatically set up free SSL and route port 443 to your proxy.

#### Step 6: Connect Telegram (Desktop, Android & iOS)
In any Telegram client that supports the WEB proxy option (e.g., Telegram Desktop):
1. Go to **Settings** > **Advanced** > **Connection type** > **Use custom proxy** > **Add proxy**.
2. Select **WEB** proxy.
3. Fill in:
   * **Host:** `tg.yourdomain.com`
   * **Port:** `443`
   * **Secret:** `<your 32-character secret>`
4. Click **Save** and turn it on. Done! 🎉

> [!TIP]
> **One-Click Share Link:**  
> You can also connect or share with one click using this link format:  
> `tg://webproxy?server=tg.yourdomain.com&secret=YOUR_SECRET`

---

### 🛡️ Censorship Resilience Guide (Iran, Russia & China)

If you experience connection drops, packet loss, or ISP throttling during heavy censorship periods:

1. **Alternate Cloudflare HTTPS Ports (if port 443 is throttled):**  
   Cloudflare supports these additional secure HTTPS/WSS ports:  
   `8443` • `2053` • `2083` • `2087` • `2096`  
   In Telegram Desktop, you can change the port to `8443` or `2053`, or use this link format:  
   `tg://webproxy?server=tg.yourdomain.com&port=8443&secret=YOUR_SECRET`

2. **Clean IP (Bypassing Cloudflare IP blocks in Iran):**  
   If your ISP blocks Cloudflare's default Anycast IP ranges, map your proxy domain to a Clean Cloudflare IP in your local `hosts` file:
   * **Windows:** `C:\Windows\System32\drivers\etc\hosts`
   * **macOS / Linux:** `/etc/hosts`
   * Append a single line:  
     `162.159.36.1   tg.yourdomain.com`  
     *(Your system will connect directly to the Clean IP while preserving the SNI and domain certificate without any configuration mismatch).*

3. **Disable ECH in Cloudflare Dashboard (Mandatory for Russia & Recommended for Iran):**  
   Russia's RKN actively blocks TLS connections utilizing Cloudflare's Encrypted Client Hello (ECH).  
   In your Cloudflare dashboard, go to your domain:  
   **SSL/TLS** > **Edge Certificates** > **Encrypted Client Hello (ECH)** = **Disabled**

---

### ❓ Frequently Asked Questions (FAQ)

<details>
<summary><b>Does it work across all Telegram clients (Desktop, Android, and iOS)?</b></summary>
<b>Yes!</b> This proxy works on <b>all Telegram clients (Desktop, Android, and iOS)</b> provided that the <b>WEB</b> proxy type is enabled in their Telegram app update. Telegram Desktop already natively supports WEB proxy out of the box, and mobile clients (Android & iOS) connect seamlessly as soon as the WEB proxy feature is enabled in their installed update.
</details>

<details>
<summary><b>Can I share this with family and friends?</b></summary>
Yes! Just give them your <code>tg://webproxy?...</code> link. It works great for personal use and a small group of friends.
</details>

<details>
<summary><b>Can I add a Sponsored Channel (Ad Tag)?</b></summary>
No. Telegram's sponsored channel system requires a server with a dedicated, fixed outgoing port. Because Cloudflare runs on a massive shared network that dynamically scrambles outgoing ports, sponsored channels cannot work on pure Cloudflare Workers. Your proxy will connect directly to Telegram smoothly without ads.
</details>

<details>
<summary><b>Is it safe? Can Cloudflare read my messages?</b></summary>
No. Telegram's messages are end-to-end encrypted (MTProto). The proxy only tunnels the encrypted packets to Telegram's data centers; it cannot decrypt or read your chats.
</details>

---

### ⚠️ Disclaimer

This project is created strictly for educational purposes, protocol study, and personal experimental use. Please note that using Cloudflare Workers for general proxy or VPN services may be subject to Cloudflare's Terms of Service (Section 2.2.1(j)). Please use responsibly.

---

### 💖 Support the Project
This utility is free and open source. If it saves you time and simplifies your routing infrastructure, support ongoing development by giving a ⭐ on GitHub or contributing via crypto:

* 🔹 **USDT (BEP20):** `0xd593ae9D32bEA690EC62460C54BF3951aFFF7803`
* 🔸 **USDT (TRC20):** `THaaHzoTwXfUfcrtYTDXRsMmk9qhnXa56M`

---
