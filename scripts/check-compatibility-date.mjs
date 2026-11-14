import { readFile } from 'node:fs/promises';

const configText = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
const configuredMatch = /"compatibility_date"\s*:\s*"(\d{4}-\d{2}-\d{2})"/.exec(configText);
if (!configuredMatch) {
  console.error('Could not read compatibility_date from wrangler.jsonc.');
  process.exit(1);
}
const configured = configuredMatch[1];
const baseline = process.env.PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE?.trim();

if (!baseline) {
  console.error(`Configured compatibility date: ${configured}`);
  console.error('NOT VERIFIED: set PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE to the date shown in the original deployed Worker settings, then rerun npm run check:compatibility-date.');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(baseline) || Number.isNaN(Date.parse(`${baseline}T00:00:00Z`)) || new Date(`${baseline}T00:00:00Z`).toISOString().slice(0, 10) !== baseline) {
  console.error('PROXY_GOSHA_BASELINE_COMPATIBILITY_DATE must be a valid YYYY-MM-DD date.');
  process.exit(1);
}
if (configured !== baseline) {
  console.error(`MISMATCH: wrangler.jsonc uses ${configured}, but the original deployed Worker uses ${baseline}.`);
  console.error('Update wrangler.jsonc compatibility_date to the verified original date, then rerun this check.');
  process.exit(1);
}
console.log(`PASS: wrangler.jsonc compatibility_date matches the verified original date (${baseline}).`);
