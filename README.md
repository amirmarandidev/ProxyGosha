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

## 🚀 What's New in v1.2.2

This release brings major connection reliability improvements, protocol optimizations, and built-in diagnostics:

- 🛠️ **Bug Fixes & Connection Stability:** Fixed intermittent connection issues, eliminated socket leaks on timeouts, removed invalid test endpoints, and updated official Telegram DC IPs for stable failover.
- ⚡ **Optimized Data Coalescing (Upstream Batching):** Small MTProto upstream data frames are now coalesced into batches before encrypting and sending to Telegram DCs, drastically cutting WebCrypto CPU cycles on Cloudflare Workers.
- 📊 **Live Telemetry & Diagnostics (Special thanks to EmadReza):** Added the `/<ADMIN_KEY>/status` dashboard, providing real-time metrics (active sessions, bandwidth, isolate uptime) and an on-demand Telegram DC Reachability Probe (DC1–DC5).

---

## What this is

Telegram added a new proxy type called **WEB**. Unlike the classic MTProto proxy, it travels as ordinary HTTPS traffic, so it can run behind Cloudflare.

ProxyGosha turns a free Cloudflare Worker into that kind of proxy.

**In plain terms:** Cloudflare is a huge network that a large part of the web runs through, so blocking it outright is costly for a censor. Your Worker is a small program running inside that network. Telegram talks to your Worker, and your Worker passes the traffic on to Telegram's servers.

- **It looks like a website.** Anyone who opens your address in a browser sees an ordinary online store.
- **It cannot read your messages.** Telegram encrypts traffic between your app and its servers. The proxy only carries those encrypted bytes.
- **It costs nothing to run.** The Worker runs on Cloudflare's free plan. The only optional cost is a domain name, which usually costs a few dollars a year.

---

## Before you start

You need:

1. **A Cloudflare account.** It's free. Sign up at [dash.cloudflare.com](https://dash.cloudflare.com/).
2. **A domain name (strongly recommended).** The default `workers.dev` address is filtered in some countries, including Iran, and may not open on every port. Any cheap domain added to Cloudflare will do.
3. **A Telegram app that offers the WEB proxy type.** Telegram Desktop already has it. Mobile apps get it through app updates.

---

## Setup — five steps

### Step 1 — Create the Worker

1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com/).
2. Go to **Workers & Pages** → **Create application** → **Create Worker**.
3. Give it any name (for example `my-tg-proxy`) and click **Deploy**.

### Step 2 — Paste the code

1. On the Worker's page, click **Edit code**.
2. Delete everything in the editor and paste the full contents of [`worker.js`](worker.js).
3. Click **Deploy**.

### Step 3 — Set your admin key (the only required setting)

1. Open your Worker's address in a browser. You will see a **setup page** that suggests a random key. Copy it.
2. In the dashboard, open your Worker → **Settings** → **Variables and Secrets** → **Add**:
   - **Name:** `ADMIN_KEY`
   - **Value:** the key you copied (or any password of at least 16 English letters and digits)
3. Click **Deploy**.

> [!IMPORTANT]
> Treat `ADMIN_KEY` like a password. Anyone who has it can open your panel and see your proxy secret.

### Step 4 — Connect your domain

1. Add your domain to Cloudflare. Cloudflare will show you two nameservers. Set those nameservers at the company you bought the domain from.
2. In your Worker, go to **Settings** → **Domains & Routes** → **Add** → **Custom Domain**.
3. Enter a subdomain, for example `tg.yourdomain.com`. Cloudflare sets up the certificate and DNS automatically.

#### 🌐 Domain Setup Guide (Why a Custom Domain is Required)

Many users have asked whether a custom domain is mandatory and where to acquire one:

> [!WARNING]
> The default Cloudflare **`workers.dev`** domain is blocked by default in state firewalls across **Iran**, **China**, **Russia**, and other heavily filtered regions.  
> To guarantee stable connectivity across all network providers, **you must attach a custom domain to your Worker.**

### Options for acquiring a domain:

- ☑️ **Free Domains:**  
  You can register a free domain using services such as **[digitalplat](https://domain.digitalplat.org/)** and bind it to Cloudflare at no cost.
- ❇️ **Country-Code Domains (e.g. `.ir` for Iran, `.ru` for Russia, etc.):**  
  - National ccTLDs can be used for your proxy.  
  - ⚠️ **Caution:** Exercise caution and avoid hazardous activities when using personally identifiable national domains.  
  - National domains are typically very cheap, but identity verification and registration approval (e.g., via [nic.ir](https://nic.ir/)) often takes **1–2 business days**.
- ‼️ **Low-Cost International Domains (Crypto / International Cards):**  
  If you have access to cryptocurrency or international payment methods, registrars like **[Namecheap](https://namecheap.com/)** offer bargain TLDs (such as `.xyz` or `.top`) often priced under $1.

### Step 5 — Open your panel and connect

Go to:

```text
https://tg.yourdomain.com/YOUR_ADMIN_KEY
```

The panel shows two ways to connect:

- **One tap:** a **Connect in Telegram** button for each of the six ports. On a phone or desktop with Telegram installed, tapping it adds the proxy straight away.
- **Manual entry:** the **server**, and the corresponding **port** and **secret** pair shown in the panel table:

| Field | Value |
|---|---|
| Server | `tg.yourdomain.com` |
| Port | any one of `443` · `2053` · `2083` · `2087` · `2096` · `8443` |
| Secret | the specific secret shown for that port in the panel table |

Where to enter them in Telegram:

- **Desktop:** Settings → Advanced → Connection type → Use custom proxy → Add proxy → **WEB**
- **Mobile:** Settings → Data and Storage → Proxy → Add Proxy → **WEB** (once your app version offers it)

**Done.** To share the proxy, send people **the links or the connection values (server, port, and that port's secret)**. Never send the panel address.

### Live Status & Diagnostics

To verify your proxy is running, monitor real-time traffic, or diagnose connection issues:

```text
https://tg.yourdomain.com/YOUR_ADMIN_KEY/status
```

- **Live Statistics:** Active sessions, streams opened, bandwidth up/down, and isolate uptime.
- **DC Probe:** Run an on-demand latency & reachability check directly from Cloudflare to all Telegram Data Centers (DC1–DC5).
- **Privacy-first:** Metrics and event logs are kept strictly in isolate memory and reset automatically; no IP addresses, tokens, or secrets are ever stored.

### Optional custom-client subscriptions

A subscription credential API is available at `/<ADMIN_KEY>/api/subscriptions`. It
supports creation, listing, expiry, per-subscription concurrent-session and traffic
limits, and revocation. The credential is returned only once and its SHA-256 digest
is stored. To enforce it, set `requireSubscription: true` through the authenticated
`PUT /<ADMIN_KEY>/api/config` endpoint. Compatible clients must send
`X-Proxy-Gosha-Subscription` on both `/api/v1/session` and `/api/v1/ws`.

This is not supported by stock Telegram WEB-proxy clients unless they can add that
custom header. Do not enable the requirement for an ordinary Telegram deployment.
It does not implement Telegram account identity, billing, or automatic renewal.

---

## Ports

All six Cloudflare HTTPS ports work without any extra setting:

`443` · `2053` · `2083` · `2087` · `2096` · `8443`

Each port has its own unique secret (derived deterministically from your setup) to keep connections isolated. If one port is slow or blocked, switch to another port and use its matching secret from the panel. You can add the proxy multiple times with different ports and switch between them in Telegram anytime.

---

## Settings reference

Only `ADMIN_KEY` is required. Everything else is optional.

| Variable | Purpose |
|---|---|
| `ADMIN_KEY` | **Required.** Password for your panel. Your proxy secrets are derived from it. |
| `SECRET` | A fixed 32-character hex secret for port 443 (and the base for other ports). Set this if you want to change `ADMIN_KEY` later without breaking links you already shared. |
| `EXTRA_HOSTS` | Other domains attached to this Worker, separated by commas. The panel generates links for them too. |
| `DECOY_URL` | A real website to show visitors instead of the built-in store page. Using one makes your proxy harder to tell apart from other deployments. |
| `CARRIER` | Leave it empty. Set it to `websocket` only if the default mode gives you trouble. |
| `DC1` … `DC5`, `DC203` | Optional per-DC endpoint overrides. Comma/semicolon/space-separated IPv4, IPv6, or DNS hosts. IPv6 can be bracketed. |
| `DC_PORTS` | Optional TCP port list replacing the default `443,80,5222`. |

> [!WARNING]
> If `SECRET` is not set, changing `ADMIN_KEY` also changes the secrets, and **every link you have shared stops working.**

---

## Under heavy censorship

Try these in order:

1. **Switch ports.** Use another port from the list above.
2. **Use a different domain.** If one domain is blocked, attach another one to the same Worker and add it to `EXTRA_HOSTS`.
3. **Use a clean Cloudflare IP (desktop only).** If the IPs your domain normally resolves to are blocked, point your domain at a Cloudflare IP that still works on your network. Add one line to your `hosts` file:
   - Windows: `C:\Windows\System32\drivers\etc\hosts`
   - macOS / Linux: `/etc/hosts`

   ```text
   CLEAN_IP   tg.yourdomain.com
   ```

   Replace `CLEAN_IP` with a Cloudflare IP that works on your network. Clean IPs vary by ISP and stop working over time, so test them yourself.
4. **Turn off ECH where it is blocked (for example Russia).** In Cloudflare, open your domain → **SSL/TLS** → **Edge Certificates** → **Encrypted Client Hello (ECH)** → **Off**.

> [!NOTE]
> No proxy works during a **complete** shutdown of international internet access. Cloudflare's servers are outside the country, so once the border is closed, nothing on Cloudflare can be reached. These measures help while access is filtered or partially restricted, not after it is fully cut.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| The address shows an online store | Normal. The proxy works behind it. To open the panel, add `/YOUR_ADMIN_KEY` to the address. |
| The panel address shows the store | The key in the address doesn't match `ADMIN_KEY`, or you didn't click **Deploy** after setting it. |
| The setup page appears again | `ADMIN_KEY` is missing or shorter than 16 characters. |
| Telegram shows "connecting" forever | Try another port. Then try another domain. On `workers.dev`, connect a custom domain instead. |
| Links you shared stopped working | `ADMIN_KEY` was changed while `SECRET` was not set. Send out the new links from the panel. |

---

## FAQ

<details>
<summary><b>Which Telegram apps work?</b></summary>
Any Telegram app that offers the <b>WEB</b> proxy type. Telegram Desktop already does. Android and iOS apps support it once the option arrives in their updates.
</details>

<details>
<summary><b>How many people can use one proxy?</b></summary>
It is built for you and a small circle. Cloudflare's free plan allows 100,000 requests per day per account. For more people, it is better for each group to deploy its own Worker. That spreads the load, and a single leaked link doesn't take everyone down.
</details>

<details>
<summary><b>Can Cloudflare or the proxy read my messages?</b></summary>
No. Telegram encrypts traffic between your app and its servers. The proxy only forwards those encrypted bytes and cannot decrypt them.
</details>

<details>
<summary><b>Can I add a sponsored channel (ad tag)?</b></summary>
No. Sponsored channels require a server with a fixed outgoing port. Cloudflare's network changes outgoing ports, so this is not possible on Workers. The proxy connects straight to Telegram's servers, with no ads.
</details>

---

## Disclaimer

This project is provided for educational purposes and personal use. Running proxy services on Cloudflare Workers may conflict with Cloudflare's Terms of Service (Section 2.2.1(j)). You are responsible for how you use it.

---

## Support

ProxyGosha is free and open source. To support its development, star the repository or donate:

- **USDT (BEP20):** `0xd593ae9D32bEA690EC62460C54BF3951aFFF7803`
- **USDT (TRC20):** `THaaHzoTwXfUfcrtYTDXRsMmk9qhnXa56M`

---

## Development and deployment

The TypeScript Worker is now the configured Wrangler entry point (`src/index.ts`).
The original `worker.js` is retained unchanged as the JavaScript baseline and
rollback implementation.

Requirements: Node.js 22.6 or newer and npm.

```bash
npm install
npm run check
npm run smoke:worker
npm run test:e2e
npm run test:tcp-integration
npm run test:protocol-diff
npm run test:workerd-tcp
```

Run locally with:

```bash
npm run dev:ts
```

Deploy the TypeScript entry point with Wrangler after completing the staging and
independent Telegram-client validation described in
[`docs/migration/DEPLOYMENT-AND-CLIENT-VALIDATION.md`](docs/migration/DEPLOYMENT-AND-CLIENT-VALIDATION.md):

```bash
npm run deploy
```

`wrangler.jsonc` contains non-secret Worker settings. Configure credentials such as
`ADMIN_KEY`, `SECRET`, and other sensitive values with Cloudflare Worker secrets or
the dashboard; do not commit them to this repository. Never set `E2E_TEST_MODE`,
`E2E_DC_HOST`, or `E2E_DC_PORT` in a deployed Worker.

Migration notes and the JavaScript baseline are maintained in
[`docs/migration/`](docs/migration/).

## Retained features and operational enhancements

The TypeScript port retains the original setup/admin experience, bilingual
English/Persian pages, browser bridge, Telegram proxy links, optional secret
generator, LUXVEIL decoy storefront, health/static routes, DC reachability probe,
both WebSocket carrier modes, and the original Direct-DC/Obfuscated2 proxy path.
The original `worker.js` remains available as the JavaScript baseline;
`src/baseline-entry.js` provides a rollback entry point that retains the Durable
Object class export after the first TypeScript deployment.

New operational capabilities include shared DC endpoint health and scheduled
probes, per-IP session admission and traffic accounting, webhook alerts, configurable
metrics retention, audited settings import/export, bounded WebSocket input queues,
configurable TCP stream idle timeouts, and GitHub Actions CI/manual deployment
workflows. See
[`docs/migration/NEW-FEATURES.md`](docs/migration/NEW-FEATURES.md) and [`docs/migration/ROADMAP-COMPLETION.md`](docs/migration/ROADMAP-COMPLETION.md) for the complete
feature inventory, API fields, bounds, and deployment notes.

### Local core benchmarks

Run `npm run bench:core` to benchmark frame encode/decode across several payload
sizes and adaptive DC ranking across 32 endpoints. These Node.js microbenchmarks are
intended for relative comparisons between revisions; they are not representative of
Cloudflare Worker throughput or real DC network latency.
