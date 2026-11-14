import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.ts";
import { importHmacKey } from "../../src/crypto/webcrypto.ts";
import { issueToken, verifyToken } from "../../src/crypto/token.ts";
import { serveSessionRoute, serveWebSocketRoute, TOKEN_KIND_BOOTSTRAP, TOKEN_KIND_SESSION } from "../../src/routes/proxy-routes.ts";

globalThis.crypto ??= webcrypto;

const NOW = 1_800_000_000;
const SESSION_BODY = Uint8Array.of(0x10, 0, 0, 0, 0, 0, 0, 1, 1);

async function setup(overrides = {}) {
  const tokenKey = await importHmacKey(new Uint8Array(32).fill(0x5a), ["sign", "verify"]);
  const base = new Uint8Array(16).fill(0x33);
  const config = {
    ...DEFAULT_CONFIG,
    ...overrides,
    base,
    portSecrets: { 443: { secret: base }, 2053: { secret: new Uint8Array(16).fill(0x44) } },
    generatorHmac: await importHmacKey(new Uint8Array(32).fill(0x66), ["sign", "verify"]),
    tokenKey,
    adTag: null,
  };
  return {
    config,
    bootstrap: (mode = 0) => issueToken(tokenKey, TOKEN_KIND_BOOTSTRAP, 300, mode, NOW),
    session: (mode = 0) => issueToken(tokenKey, TOKEN_KIND_SESSION, 300, mode, NOW),
  };
}

function sessionRequest(token, { method = "POST", body = SESSION_BODY, headers = {} } = {}) {
  return new Request("https://proxy.example/api/v1/session", {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", ...headers },
    body: method === "POST" ? body : undefined,
  });
}

test("session route issues a session token for the exact bootstrap handshake", async () => {
  const { config, bootstrap } = await setup();
  const response = await serveSessionRoute(sessionRequest(await bootstrap()), config, NOW);
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(0x11, 0, 0, 0, 0, 0, 0, 0));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Carrier-Mode"), config.carrier);
  const issued = await verifyToken(config.tokenKey, response.headers.get("X-Session-Token"), TOKEN_KIND_SESSION, NOW);
  assert.ok(issued);
  assert.equal(issued.mode, 0);
});

test("session route rejects malformed auth, cookies, content type, and handshake bodies", async () => {
  const { config, bootstrap } = await setup();
  const token = await bootstrap();
  assert.equal((await serveSessionRoute(new Request("https://proxy.example/api/v1/session", { method: "POST" }), config, NOW)).status, 404);
  assert.equal((await serveSessionRoute(sessionRequest(token, { headers: { Cookie: "sid=x" } }), config, NOW)).status, 404);
  assert.equal((await serveSessionRoute(sessionRequest(token, { headers: { "Content-Type": "application/json" } }), config, NOW)).status, 404);
  assert.equal((await serveSessionRoute(sessionRequest(token, { body: Uint8Array.of(1) }), config, NOW)).status, 404);
  assert.equal((await serveSessionRoute(sessionRequest(token, { headers: { "Content-Length": "4097" } }), config, NOW)).status, 404);
});

test("session route supports authenticated DELETE and rejects bootstrap tokens for DELETE", async () => {
  const { config, bootstrap, session } = await setup();
  assert.equal((await serveSessionRoute(sessionRequest(await session(), { method: "DELETE" }), config, NOW)).status, 204);
  assert.equal((await serveSessionRoute(sessionRequest(await bootstrap(), { method: "DELETE" }), config, NOW)).status, 404);
});

test("session route enforces generated-token acceptance policy", async () => {
  const { config, bootstrap } = await setup({ acceptGenerated: false });
  assert.equal((await serveSessionRoute(sessionRequest(await bootstrap(1)), config, NOW)).status, 404);
});

test("WebSocket route validates upgrade, protocol, and token before allocating a pair", async () => {
  const { config, session } = await setup();
  let pairCalls = 0;
  const dependencies = {
    createWebSocketPair() { pairCalls++; throw new Error("must not allocate"); },
    createUpgradeResponse() { throw new Error("must not upgrade"); },
    transport: { connect() { throw new Error("unused"); } },
    nowSeconds: () => NOW,
  };
  const invalid = new Request("https://proxy.example/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "tproxy-v1.invalid" } });
  assert.equal((await serveWebSocketRoute(invalid, config, "proxy.example", "443", dependencies)).status, 404);
  const wrongUpgrade = new Request("https://proxy.example/api/v1/ws", { headers: { "Sec-WebSocket-Protocol": `tproxy-v1.${await session()}` } });
  assert.equal((await serveWebSocketRoute(wrongUpgrade, config, "proxy.example", "443", dependencies)).status, 404);
  assert.equal(pairCalls, 0);
});

test("WebSocket route accepts one valid protocol and attaches transport with the selected secret", async () => {
  const { config, session } = await setup();
  const token = await session();
  const calls = { accepted: 0, protocol: "", secret: null, laneId: -1 };
  const server = {
    readyState: 1,
    binaryType: "",
    accept() { calls.accepted++; },
    send() {}, close() {},
    addEventListener() {},
  };
  const dependencies = {
    createWebSocketPair: () => [{}, server],
    createUpgradeResponse(client, protocol) {
      calls.protocol = protocol;
      assert.ok(client);
      return new Response(null, { status: 200, headers: { "Sec-WebSocket-Protocol": protocol } });
    },
    transport: {
      connect() { throw new Error("no stream expected"); },
      random: () => 0.5,
      heartbeat: false,
    },
    nowSeconds: () => NOW,
  };
  const protocol = `tproxy-lane-v1.${token}.7`;
  const request = new Request("https://proxy.example/api/v1/ws", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": protocol },
  });
  const response = await serveWebSocketRoute(request, config, "proxy.example", "443", dependencies);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Sec-WebSocket-Protocol"), protocol);
  assert.equal(server.binaryType, "arraybuffer");
  assert.equal(calls.accepted, 1);
  assert.equal(calls.protocol, protocol);
});

test("WebSocket route selects per-port and generated secrets from token mode", async () => {
  const { config, session } = await setup({ acceptGenerated: true });
  const selectedPortSecret = config.portSecrets[2053].secret;
  const capture = async (mode, expectedSecret, host = "proxy.example", port = "2053") => {
    let selectedSecret;
    let selectedLane = -1;
    const server = { readyState: 1, binaryType: "", accept() {}, send() {}, close() {}, addEventListener() {} };
    const response = await serveWebSocketRoute(
      new Request("https://proxy.example/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tproxy-lane-v1.${await session(mode)}.9` } }),
      config, host, port,
      {
        createWebSocketPair: () => [{}, server],
        createUpgradeResponse: () => new Response(null, { status: 200 }),
        transport: { connect() { throw new Error("unused"); }, heartbeat: false },
        attachTransport(_server, _cfg, secret, _options, laneId) { selectedSecret = secret; selectedLane = laneId; return {}; },
        nowSeconds: () => NOW,
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(selectedSecret, expectedSecret);
    assert.equal(selectedLane, 9);
  };
  await capture(11, selectedPortSecret);
  const generatedMac = new Uint8Array(await crypto.subtle.sign("HMAC", config.generatorHmac, new TextEncoder().encode("tgweb-secret-v1\nproxy.example:2053")));
  await capture(2, generatedMac.subarray(0, 16));
});

test("WebSocket route rejects multiple protocols, authorization headers, and invalid lane IDs", async () => {
  const { config, session } = await setup();
  const token = await session();
  const dependencies = {
    createWebSocketPair() { throw new Error("must not allocate"); },
    createUpgradeResponse() { throw new Error("must not upgrade"); },
    transport: { connect() { throw new Error("unused"); } },
    nowSeconds: () => NOW,
  };
  const requests = [
    new Request("https://proxy.example/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tproxy-v1.${token}, other` } }),
    new Request("https://proxy.example/api/v1/ws", { headers: { Upgrade: "websocket", Authorization: "Bearer nope", "Sec-WebSocket-Protocol": `tproxy-v1.${token}` } }),
    new Request("https://proxy.example/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tproxy-lane-v1.${token}.0` } }),
    new Request("https://proxy.example/api/v1/ws", { headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `tproxy-lane-v1.${token}.16777216` } }),
  ];
  for (const request of requests) assert.equal((await serveWebSocketRoute(request, config, "proxy.example", "443", dependencies)).status, 404);
});
