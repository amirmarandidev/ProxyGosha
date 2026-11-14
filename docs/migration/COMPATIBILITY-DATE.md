# Cloudflare compatibility date verification

The original supplied source archive contains `worker.js` but no `wrangler.toml`,
`wrangler.json`, or deployed Worker metadata. Therefore the original deployed
compatibility date cannot be recovered from that archive. The current
`wrangler.jsonc` value (`2026-11-13`) is an initial migration value, not a verified
baseline value.

## Retrieve the authoritative value

In the Cloudflare dashboard, open the original deployed Worker and inspect its
**Settings → Runtime → Compatibility date** value. If the original deployment was
managed from a separate Wrangler project, inspect the exact `wrangler.toml` or
`wrangler.jsonc` used for that deployment instead. Do not infer the value from the
Worker source file or choose a new date just because it is newer.

## Compare the value

PowerShell:

```powershell
$env:PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE = "YYYY-MM-DD"
npm run check:compatibility-date
```

Bash:

```sh
PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE=YYYY-MM-DD npm run check:compatibility-date
```

The check passes only when the supplied original date exactly matches
`wrangler.jsonc`. If it reports a mismatch, update `compatibility_date` to the
verified original date and rerun the check. Do not deploy until the date is verified.
