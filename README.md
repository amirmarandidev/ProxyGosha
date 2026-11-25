# ProxyGosha — Telegram WEB Proxy on Cloudflare Workers

> A private Telegram proxy that runs on Cloudflare's free tier. One file, one setting, no server to rent or maintain.

<p align="center">
  <a href="https://github.com/amirmarandidev/ProxyGosha/stargazers"><img src="https://img.shields.io/github/stars/amirmarandidev/ProxyGosha?style=for-the-badge&color=gold" alt="GitHub Stars"></a>
  <a href="https://workers.cloudflare.com/"><img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
  <a href="https://desktop.telegram.org/"><img src="https://img.shields.io/badge/Telegram-WEB%20Proxy-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram WEB Proxy"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License MIT"></a>
</p>

<p align="center">
  <a href="README.md"><b>English</b></a> •
  <a href="docs/README.ar.md"><b>العربية</b></a> •
  <a href="docs/README.fa.md"><b>فارسی</b></a> •
  <a href="docs/README.ru.md"><b>Русский</b></a> •
  <a href="docs/README.zh.md"><b>简体中文</b></a> •
  <a href="docs/llms.txt"><b>llms.txt</b></a>
</p>

---

## 📺 Video Tutorial

> [!TIP]
> Prefer a visual walkthrough? Watch the complete step-by-step setup tutorial on YouTube:  
> ▶️ **[Watch the Tutorial on YouTube](https://youtu.be/7StSCQdpqvk)** *(with clear on-screen instructions)*

<p align="center">
  <a href="https://youtu.be/7StSCQdpqvk">
    <img src="https://img.youtube.com/vi/7StSCQdpqvk/maxresdefault.jpg" alt="ProxyGosha Video Tutorial" width="700">
  </a>
</p>

<p align="center">
  <a href="https://t.me/amirdotlog"><img src="https://img.shields.io/badge/Telegram-amirdotlog-2CA5E0?style=for-the-badge&logo=telegram&logoColor=white" alt="Telegram Channel"></a>
  <a href="https://www.youtube.com/@amirmarandidev"><img src="https://img.shields.io/badge/YouTube-amirmarandidev-red?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube Channel"></a>
</p>

> [!NOTE]
> 📢 **Telegram Updates Channel:** Join our channel for clean domains, latest announcements, and setup tips: **[t.me/amirdotlog](https://t.me/amirdotlog)**  
> 🔴 **YouTube Channel:** Subscribe for video tutorials and technical anti-censorship walkthroughs: **[youtube.com/@amirmarandidev](https://www.youtube.com/@amirmarandidev)**

---

## ✨ What's New in v1.5.1

This update focuses on **real-world stability across different internet providers** — especially mobile networks that slow down uploads or drop multiple connections — while keeping everything fast on open home connections.

- 📶 **Ready-to-use links for every network type (zero extra setup):** Different providers behave differently. Your panel now automatically creates separate ready links for **Fast / Home Internet**, **Mobile Single-Channel** (great when a mobile carrier throttles upload or drops parallel connections), **Mobile Multi-Channel**, and optional **HTTPS-Only** (when WebSocket is blocked). Add the ones you need in Telegram and switch with one tap.
- 🎛️ **Change settings live from your panel (optional free KV):** Want to switch your **existing main link** between Fast and Mobile modes without making new links or redeploying? Attach a free Cloudflare KV (`SETTINGS_KV`, takes 30 seconds, no credit card) and save changes directly in your panel.
- 🔁 **Smoother uploads & automatic fallback:** On slow mobile connections, photos, voice notes, and files are sent in smaller pieces so chats don't freeze or time out. If multi-channel mode fails to open, it automatically and safely falls back to single-channel mode without losing messages.
- 🧭 **Smarter connection to Telegram servers:** If port `443` to a Telegram data center is slow or unreachable, the Worker automatically tries different IPs and backup ports (`80`, `5222`) instead of getting stuck.
- 🕵️ **Better camouflage against scanners:** Automated probes checking hidden paths (`/?bridge=...`, `/api/v1/session`, `/api/v1/ws`, `/health`) now see the normal website instead of telltale error pages.
- 🩺 **Clear 5-step diagnostics (`/status`):** Shows step by step where a connection stopped (reaching Cloudflare → bridge → session → WebSocket/HTTPS → Telegram) without ever storing passwords, secrets, or user IPs.
- 🔒 **Optional real HTTPS mode (`PROXY_DO`):** For networks that block WebSocket completely while allowing normal HTTPS, you can optionally attach a free SQLite Durable Object. Without it, the panel stays honest and never pretends HTTPS mode is active.
- ✅ **Your old links keep working:** All previous secrets and links are 100% compatible. Just paste the new `worker.js` and click **Deploy**.

<details>
<summary><b>Previous releases (v1.2.3 &amp; v1.2.2)</b></summary>

- **v1.2.3:** Fixed Cloudflare **Error 1101** by wrapping every route safely so unexpected errors show the normal decoy page instead of a Cloudflare crash screen, improved error logging, and made `DECOY_URL` safer for unusual HTTP status codes.
- **v1.2.2:** Fixed socket leaks on timeouts, updated official Telegram DC IPs, added upstream batching to reduce CPU usage, and introduced the `/<ADMIN_KEY>/status` page (thanks to EmadReza).

</details>

---

## What this is

Telegram has a built-in proxy type called **WEB**. Unlike classic MTProto proxies, it travels as ordinary HTTPS web traffic, so it can run behind Cloudflare.

ProxyGosha turns a free Cloudflare Worker into that kind of proxy.

**In plain terms:** Cloudflare is a huge network that a massive part of the web runs through, so blocking it completely is costly for a censor. Your Worker is a tiny script running inside that network. Telegram talks to your Worker like a normal website, and your Worker passes the encrypted traffic straight to Telegram's servers.

- **It looks like a website.** Anyone who opens your address in a browser sees a normal online store (or your own website if you set `DECOY_URL`).
- **It cannot read your messages.** Telegram encrypts everything between your app and its servers. The proxy only carries encrypted bytes.
- **It costs nothing to run.** The Worker runs on Cloudflare's free plan. The only optional cost is a domain name (and free options exist too).

---

## Before you start

You need:

1. **A Cloudflare account.** It's free — sign up at [dash.cloudflare.com](https://dash.cloudflare.com/).
2. **A domain name (strongly recommended).** The default `workers.dev` address is blocked in several countries (including Iran, China, and Russia). Any cheap or free domain added to Cloudflare works much better.
3. **A Telegram app that supports the WEB proxy type.** Telegram Desktop already has it. Mobile apps support it depending on your installed version.

---

## Setup — five simple steps

### Step 1 — Create the Worker

1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** → **Create application** → **Create Worker**.
3. Give it any name (for example `my-tg-proxy`) and click **Deploy**.

### Step 2 — Paste the code

1. On the Worker's page, click **Edit code**.
2. Delete everything inside the editor and paste the full contents of [`worker.js`](worker.js).
3. Click **Deploy**.

### Step 3 — Set your admin key (the only required setting)

1. Open your Worker's address in a browser. You will see a **setup page** with a ready random password. Copy it.
2. In the dashboard, open your Worker → **Settings** → **Variables and Secrets** → **Add**:
   - **Name:** `ADMIN_KEY`
   - **Value:** the key you copied (or any password with at least 16 English letters and digits)
3. Click **Deploy**.

> [!IMPORTANT]
> Treat `ADMIN_KEY` like a password. Anyone who knows it can open your panel and copy your proxy links.

### Step 4 — Connect your domain

1. Add your domain to Cloudflare. Cloudflare will give you two nameservers — set those nameservers where you registered the domain.
2. In your Worker, go to **Settings** → **Domains & Routes** → **Add** → **Custom Domain**.
3. Enter a subdomain, for example `tg.yourdomain.com`. Cloudflare sets up DNS and HTTPS certificates automatically.

> [!TIP]
> **Using a subdomain of an existing live website (with the owner's permission)?**  
> Before moving DNS to Cloudflare, make sure all existing website, email (`MX`, `TXT` / SPF / DKIM), and payment-related records are copied accurately and kept on **DNS-only (gray cloud)** so the main website and emails are not affected. Only attach the dedicated proxy subdomain to the Worker.

#### 🌐 Why a Custom Domain is Strongly Recommended

> [!WARNING]
> Cloudflare's default **`workers.dev`** domain is widely blocked in **Iran**, **China**, **Russia**, and other filtered networks.  
> For reliable access, **connect a custom domain to your Worker.**

Options for getting a domain:

- ☑️ **Free Domains:**  
  Services like **[digitalplat](https://domain.digitalplat.org/)** let you register a free domain and connect it to Cloudflare at no cost.
- ❇️ **Country-Code Domains (e.g. `.ir`, `.ru`, etc.):**  
  - National domains can work too, though registration and verification (for example via [nic.ir](https://nic.ir/)) usually take **1–2 business days**.
  - ⚠️ **Caution:** Because national domains are tied to real identity, use them responsibly and never use someone else's domain without their permission.
- ‼️ **Low-Cost International Domains (Crypto / International Cards):**  
  Registrars like **[Namecheap](https://namecheap.com/)** often offer budget domains (such as `.xyz` or `.top`) for under $1.

### Step 5 — Open your panel and connect

Open:

```text
https://tg.yourdomain.com/YOUR_ADMIN_KEY
```

Inside the panel you will see:

- **One-tap Connect buttons:** Tap **Connect in Telegram** on your phone or computer to add the proxy immediately.
- **Manual entry (official Telegram WEB proxy uses port `443` automatically — no port field needed):**

| Field | Value |
|---|---|
| Server | `tg.yourdomain.com` |
| Secret | the secret shown for the Default link (or whichever operator profile you pick) |

Where to add it in Telegram:

- **Desktop:** Settings → Advanced → Connection type → Use custom proxy → Add proxy → **WEB**
- **Mobile:** Settings → Data and Storage → Proxy → Add Proxy → **WEB** *(available depending on your app version)*

**Done!** To share the proxy with family or friends, send **only the `tg://webproxy` links (or server + secret)**. Never share your panel URL.

---

## Picking the right mode for your internet (Profiles & Live Panel Settings)

Not every internet provider behaves the same way. Home broadband is usually open and fast, while some mobile carriers slow down uploads or drop multiple simultaneous connections. ProxyGosha gives you **two easy ways** to adapt:

### Way 1 — Ready-made Operator Links (works immediately, zero extra setup)

Right under your domain in the panel, you will see ready links for each network type. Each link uses its own secret, so **your home internet and a friend's restricted mobile SIM can use completely different modes on the exact same Worker at the same time**:

| Profile | Best for | What it actually does |
|---|---|---|
| **Default (Primary Link)** | Everyday use | Uses balanced settings (or whatever you save in the panel if you add `SETTINGS_KV`). Keeps 100% compatibility with your older links. |
| **Fast (`fast`)** | Home Wi-Fi / FTTH / ADSL / unrestricted carriers | Uses multi-channel WebSocket with large `1 MiB` batches for top download and upload speed. |
| **Mobile Single-Channel (`mobile-mux`)** | Restricted mobile carriers (e.g. Irancell) | Uses **one single WebSocket**, small `32 KiB` upload pieces (so sending photos/voice doesn't freeze chats), 4 connection retries, and a longer patience timer (`75s`). |
| **Mobile Multi-Channel (`mobile-lanes`)** | Mobile networks that allow multiple channels but have slow upload | Uses multi-channel WebSocket with smaller `64 KiB` pieces and switches quickly to single-channel if blocked. |
| **HTTPS Only (`https-do`)** | Networks that block WebSocket completely but allow normal HTTPS | Uses true HTTPS long-polling. **Only active if you optionally attach `PROXY_DO`** (see below). |

### Way 2 — Change Your Existing Main Link Live from the Panel (Optional Free `SETTINGS_KV`)

If you already shared your main link with people and want to switch its behavior live from the panel (with quick buttons like **Quick: Unrestricted / Fast** and **Quick: Irancell / Mobile Mux**) without sending new links or redeploying:

1. In the Cloudflare Dashboard, go to **Storage & Databases** → **KV** *(or **Workers & Pages** → **KV**)*.
2. Click **Create instance** (or **Create a namespace**), give it any name (for example `proxygosha-settings`), and click **Create**.
3. Open your Worker → **Settings** → **Bindings** → **Add** → **KV Namespace**.
4. Set **Variable name** to **`SETTINGS_KV`** *(exact uppercase letters!)*, select the KV you just created, and click **Deploy**.
5. Open your panel (`https://tg.yourdomain.com/YOUR_ADMIN_KEY`). The settings box at the top will now say **`SETTINGS_KV active`**. Pick a mode, click **Save** (or a Quick button), and toggle the proxy off and on once in Telegram.

> [!NOTE]
> Workers KV is **100% free** (no credit card needed — 100,000 reads and 1,000 writes per day). Changes apply right away on the same Cloudflare server and spread across all Cloudflare locations within ~60 seconds. No passwords, secrets, or user IPs are ever stored in KV.

---

## Live Status & 5-Step Diagnostics

Open:

```text
https://tg.yourdomain.com/YOUR_ADMIN_KEY/status
```

This page splits every connection into **5 clear stages** so you can immediately tell where a problem is happening:

1. **DNS / TLS / Edge access** — Did your device even reach Cloudflare? Also shows your live Cloudflare server code (PoP), HTTP version (`HTTP/2` or `HTTP/3`), and TLS version.
2. **Bridge handshake** — Did Telegram's built-in WebView load the proxy page?
3. **Session startup** — Did Telegram start a proxy session?
4. **Data transport (WebSocket / HTTPS)** — Did WebSocket (or optional HTTPS) open? If Stage 3 works but Stage 4 stays `0`, your carrier is likely blocking or disrupting WebSocket — try the `mobile-mux` profile or optional `PROXY_DO` HTTPS mode.
5. **Telegram DC connection** — Did Cloudflare reach Telegram's servers? Includes an on-demand **DC Probe (`?probe=1`)**.

> [!NOTE]
> - **Counters live in temporary memory on one server:** Cloudflare runs many servers worldwide and restarts them automatically, so seeing `0` can simply mean Telegram connected to a different Cloudflare server than your browser.
> - **The DC Probe only tests Cloudflare → Telegram (Stage 5):** Passing the DC Probe does **not** guarantee your local ISP can reach Cloudflare.
> - **Privacy first:** No client IPs, `ADMIN_KEY`, secrets, tokens, or full bridge URLs are ever recorded or shown on `/status`.

---

## Ports (Honest Note)

Cloudflare Custom Domains accept HTTPS traffic on six ports: `443` · `2053` · `2083` · `2087` · `2096` · `8443`.

However, **official Telegram WEB Proxy clients currently connect only on standard port `443`** and ignore `&port=`.  
All six port links and their matching secrets are still kept inside a collapsible section in the panel for backward compatibility and custom clients — **but on official Telegram, switching operator profiles or adding a backup custom domain is what actually helps when a network is filtered.**

---

## Settings reference

Only `ADMIN_KEY` is required. Everything else is optional.

### Environment Variables (**Settings → Variables and Secrets**)

| Variable | Purpose |
|---|---|
| `ADMIN_KEY` | **Required.** Password for your panel (16+ letters/digits). Proxy secrets are derived from it unless `SECRET` is set. |
| `SECRET` | Optional fixed 32-char hex (or `dd` + 32-char hex) secret. Set this if you want to change `ADMIN_KEY` later without breaking shared links. |
| `EXTRA_HOSTS` | Other custom domains **already attached** to this Worker in Cloudflare, separated by commas. The panel generates links for them too. *(Adding a domain here does NOT set up DNS or SSL by itself.)* |
| `DECOY_URL` | A real `https://` website **you own or have permission to mirror**, shown to normal visitors instead of the built-in store page. |
| `CARRIER` | Default is `websocket-lanes`. Set to `websocket` for single-channel WS, or `https` *(only works when `PROXY_DO` is attached — otherwise falls back honestly with a warning)*. |
| `WS_AUTO_FALLBACK` | Default is `true`. Set to `false` to disable automatic `websocket-lanes → websocket` fallback. |
| `SESSION_PATH`, `WS_PATH`, `UP_PATH`, `DOWN_PATH` | Optional custom endpoint paths instead of `/api/v1/*` if you want extra path disguise. |

### Optional Free Bindings (**Settings → Bindings**)

| Binding Name | Type | Purpose |
|---|---|---|
| `SETTINGS_KV` | Workers KV Namespace | Enables saving Global Default Settings live from the panel across all Cloudflare servers (free, 100k reads/day). |
| `PROXY_DO` | SQLite Durable Object (`ProxySessionDO`) | Unlocks **true `CARRIER=https` long-polling** for networks that block WebSocket completely. |

<details>
<summary><b>How to enable optional true HTTPS mode (<code>PROXY_DO</code>) on Cloudflare Free</b></summary>

Normal single-file Cloudflare Workers cannot keep a TCP connection open between separate HTTP requests, so true HTTPS long-polling requires Cloudflare's free **SQLite Durable Object** (`ProxySessionDO`, already included inside `worker.js`).

1. Place this `wrangler.toml` next to `worker.js`:
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
2. Deploy with `wrangler deploy`.
3. You can now either tap the **HTTPS Only (`https-do`)** profile link in your panel (keeps normal users on free WebSocket!) or set `CARRIER=https` for everyone.

**Free Durable Objects quota note:** Cloudflare Free includes **100,000 requests/day** and **13,000 GB-s/day** (~28 hours of active single-user session time per day). Best suited for personal or small-circle use, not public distribution.

</details>

> [!WARNING]
> If `SECRET` is not set, changing `ADMIN_KEY` changes all derived secrets, and **every link you shared before will stop working.**

---

## Under heavy censorship

Try these steps in order (change one thing at a time so you know what worked):

1. **Switch operator profile.** If you're on mobile (e.g. Irancell) and connections hang or photos stall, try **Mobile Single-Channel (`mobile-mux`)** from your panel. If WebSocket is blocked completely, try optional **`PROXY_DO` + HTTPS Only**.
2. **Use a backup custom domain.** If one domain gets filtered, attach a second domain you own under **Domains & Routes → Custom Domain** and add it to `EXTRA_HOSTS`.
3. **Use a clean Cloudflare IP (desktop only).** If the Cloudflare IPs your domain resolves to are blocked, point your domain to a working Cloudflare IP in your `hosts` file:
   - Windows: `C:\Windows\System32\drivers\etc\hosts`
   - macOS / Linux: `/etc/hosts`

   ```text
   CLEAN_IP   tg.yourdomain.com
   ```

   Clean IPs vary by ISP and change over time, so test them on your own network.
4. **Turn off ECH where it is blocked (for example Russia).** In Cloudflare, open your domain → **SSL/TLS** → **Edge Certificates** → **Encrypted Client Hello (ECH)** → **Off**.

> [!NOTE]
> No Cloudflare proxy can work during a **complete** shutdown of international internet access. Cloudflare's servers are outside the country, so if international traffic is cut completely, changing Worker code alone cannot reach them. These tools help during filtering, throttling, and partial disruption.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| Opening your domain shows an online store | Completely normal! The proxy runs behind it. Add `/YOUR_ADMIN_KEY` to the URL to open your panel. |
| The panel URL also shows the store | The password in the URL doesn't match `ADMIN_KEY`, or you forgot to click **Deploy** after adding it. |
| The setup page appears again | `ADMIN_KEY` is missing or shorter than 16 characters. |
| Telegram connects, then freezes when sending photos/files | Try the **Mobile Single-Channel (`mobile-mux`)** link in your panel (smaller upload chunks prevent stalling on throttled mobile links). |
| Telegram stays on "Connecting…" | Open `/<ADMIN_KEY>/status` to see which of the 5 stages stopped. Try `mobile-mux`, then try a backup custom domain. On `workers.dev`, switch to a custom domain. |
| Panel says "No KV binding" | Totally fine! You can use the ready **Per-Operator links** right below without KV, or attach free `SETTINGS_KV` in 30 seconds to save global settings in the panel. |
| Panel warns `CARRIER=https` is not active | True HTTPS mode needs the optional `PROXY_DO` binding. Without it, the Worker stays on WebSocket and tells you honestly. |
| `/status` shows `0` even while you are connected | Normal — Cloudflare runs multiple servers and each one keeps its own temporary memory counters. |
| Shared links stopped working | `ADMIN_KEY` was changed while `SECRET` was empty. Share the updated links from the panel. |

---

## FAQ

<details>
<summary><b>Which Telegram apps work?</b></summary>
Any Telegram app that includes the <b>WEB</b> proxy type. Telegram Desktop already supports it natively. Mobile (Android / iOS) support depends on whether your installed Telegram version includes WEB proxy.
</details>

<details>
<summary><b>Do the Fast / Mobile profiles actually change how my phone sends data?</b></summary>
Yes. In Telegram WEB Proxy, your Worker delivers the small bridge page that runs inside Telegram's WebView on your device. Switching profiles genuinely changes whether it opens one WebSocket or multiple channels, how large each upload batch is (e.g. 32 KiB vs 1 MiB), and how retries and timeouts work. It cannot change your carrier's hard bandwidth cap or bypass a total IP/domain block, but it makes a real difference on unstable or upload-throttled networks.
</details>

<details>
<summary><b>How many people can use one proxy?</b></summary>
It is built for you and a small circle of friends or family. Cloudflare's free plan gives 100,000 requests per day per account. For larger groups, each group should deploy its own Worker so load is spread out and one leaked link doesn't affect everyone.
</details>

<details>
<summary><b>Can Cloudflare or the proxy read my messages?</b></summary>
No. Telegram encrypts traffic between your app and its servers. The proxy only forwards those encrypted bytes and cannot decrypt them.
</details>

<details>
<summary><b>Can I add a sponsored channel (Ad Tag)?</b></summary>
No. Sponsored channels require a server with a fixed outgoing TCP port. Cloudflare's network dynamically translates outgoing ports, so Ad Tags cannot work on Workers. The proxy connects directly to Telegram's servers with no ads.
</details>

---

## Disclaimer

This project is provided for educational purposes and personal use. Running proxy services on Cloudflare Workers may conflict with Cloudflare's Terms of Service (Section 2.2.1(j)). You are responsible for how you use it.

---

## Support

ProxyGosha is free and open source. To support its development, star the repository or donate:

- **USDT (BEP20):** `0xd593ae9D32bEA690EC62460C54BF3951aFFF7803`
- **USDT (TRC20):** `THaaHzoTwXfUfcrtYTDXRsMmk9qhnXa56M`
