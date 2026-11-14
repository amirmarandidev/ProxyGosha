import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../../worker.js", import.meta.url), "utf8");

test("baseline remains a Cloudflare ES module using native TCP sockets", () => {
  assert.match(source, /import\s*\{\s*connect\s*\}\s*from\s*["']cloudflare:sockets["']/);
  assert.match(source, /export\s+default\s*\{/);
  assert.match(source, /async\s+fetch\s*\(request,\s*env,\s*ctx\)/);
});

test("baseline retains both supported carrier modes", () => {
  assert.match(source, /carrier:\s*["']websocket-lanes["']/);
  assert.match(source, /carrierEnv\s*===\s*["']websocket["']/);
  assert.match(source, /carrierEnv\s*===\s*["']websocket-lanes["']/);
});

test("baseline retains the session and WebSocket routes", () => {
  assert.match(source, /sessionPath:\s*["']\/api\/v1\/session["']/);
  assert.match(source, /wsPath:\s*["']\/api\/v1\/ws["']/);
  assert.match(source, /function\s+serveSession\s*\(/);
  assert.match(source, /function\s+serveWebSocket\s*\(/);
});

test("baseline retains all six WebSocket frame types", () => {
  for (const frameType of ["0x01", "0x02", "0x03", "0x04", "0x05", "0x06"]) {
    assert.ok(source.includes(frameType), `missing frame type ${frameType}`);
  }
});

test("baseline retains the existing environment binding names", () => {
  const expected = [
    "ADMIN_KEY", "SECRET", "AD_TAG", "HOSTNAME", "EXTRA_HOSTS", "DEBUG",
    "DECOY_URL", "MAX_STREAMS", "SESSION_PATH", "WS_PATH", "CARRIER",
    "GENERATOR_ENABLED", "GENERATOR_KEY", "ACCEPT_GENERATED"
  ];
  for (const name of expected) {
    assert.ok(new RegExp(`env\\?\\.${name}|env\\.${name}`).test(source), `missing environment binding ${name}`);
  }
});

test('post-exports rollback wrapper preserves the original Worker and Durable Object class export', async () => {
  const wrapper = await readFile(new URL('../../src/baseline-entry.js', import.meta.url), 'utf8');
  assert.match(wrapper, /export\s*\{\s*default\s*\}\s*from\s*["']\.\.\/worker\.js["']/);
  assert.match(wrapper, /export\s*\{\s*ProxyGoshaControlPlane\s*\}\s*from\s*["']\.\/observability\/control-plane\.ts["']/);
});
