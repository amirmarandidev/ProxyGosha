import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const host = '127.0.0.1';
const port = Number(process.env.PROXY_GOSHA_SMOKE_PORT || 8787);
const url = `http://${host}:${port}/`;
// Invoke Wrangler's JavaScript CLI through the current Node executable.
// This avoids trying to spawn npm's .cmd shim directly on Windows (EINVAL).
const wranglerCli = resolve('node_modules', 'wrangler', 'bin', 'wrangler.js');
if (!existsSync(wranglerCli)) {
  console.error(`Wrangler CLI not found at ${wranglerCli}. Run npm install first.`);
  process.exit(1);
}
const child = spawn(
  process.execPath,
  [wranglerCli, 'dev', 'src/index.ts', '--local', '--ip', host, '--port', String(port)],
  { stdio: ['ignore', 'pipe', 'pipe'], env: process.env, windowsHide: true },
);

let output = '';
let exited = false;
let exitCode = null;
const collect = (chunk) => {
  output = `${output}${chunk}`.slice(-12_000);
};
child.stdout.setEncoding('utf8').on('data', collect);
child.stderr.setEncoding('utf8').on('data', collect);
child.on('error', (error) => {
  exited = true;
  exitCode = 1;
  output = `${output}\nFailed to start Wrangler: ${error.message}`.slice(-12_000);
});
child.on('exit', (code) => {
  exited = true;
  exitCode = code;
});

async function stop() {
  if (exited) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(3_000),
  ]);
  if (!exited) child.kill('SIGKILL');
}

try {
  let response;
  let lastError;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Wrangler exited with code ${exitCode}.\n${output}`);
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      break;
    } catch (error) {
      lastError = error;
      await delay(500);
    }
  }
  if (!response) throw new Error(`Wrangler did not become ready: ${lastError?.message || 'timeout'}.\n${output}`);

  const body = await response.text();
  if (response.status !== 200) throw new Error(`Expected HTTP 200 from ${url}, received ${response.status}.\n${body.slice(0, 500)}\n${output}`);
  if (!response.headers.get('content-type')?.includes('text/html')) {
    throw new Error(`Expected an HTML setup response, received ${response.headers.get('content-type') || 'no content type'}.`);
  }
  if (!body.includes('Proxy setup')) {
    throw new Error(`The TypeScript Worker did not return the expected setup page.\n${body.slice(0, 500)}\n${output}`);
  }

  console.log(`Wrangler local smoke test passed: GET ${url} -> ${response.status}, HTML setup page detected.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await stop();
}
