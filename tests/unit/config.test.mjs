import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../../src/config/defaults.ts";
import { resolveConfig } from "../../src/config/resolve.ts";

test("config resolver matches baseline defaults", () => {
  const config = resolveConfig();
  assert.equal(config.sessionPath, "/api/v1/session");
  assert.equal(config.wsPath, "/api/v1/ws");
  assert.equal(config.carrier, "websocket-lanes");
  assert.equal(config.maxStreams, 6);
  assert.deepEqual(config.dcPorts, [443, 80, 5222]);
  assert.deepEqual(config.hostnames, ["*"]);
});

test("config resolver normalizes environment overrides", () => {
  const config = resolveConfig({
    SECRET: "  0x0123456789abcdef0123456789abcdef  ",
    AD_TAG: " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ",
    HOSTNAME: " Example.COM, api.example.com ,, ",
    EXTRA_HOSTS: "https://One.Example/path two.example:443 invalid..host",
    MAX_STREAMS: "99streams",
    SESSION_PATH: "custom/session",
    WS_PATH: "/custom/ws",
    CARRIER: "WEBSOCKET",
    DEBUG: "1",
    GENERATOR_ENABLED: "true",
    GENERATOR_KEY: " seed ",
    ACCEPT_GENERATED: "0",
    ADMIN_KEY: " admin-secret ",
    DECOY_URL: " https://example.com "
  });
  assert.equal(config.secretHex, "0x0123456789abcdef0123456789abcdef");
  assert.deepEqual(config.hostnames, ["example.com", "api.example.com"]);
  assert.deepEqual(config.extraHosts, ["one.example", "two.example"]);
  assert.equal(config.maxStreams, 32);
  assert.equal(config.sessionPath, "/custom/session");
  assert.equal(config.wsPath, "/custom/ws");
  assert.equal(config.carrier, "websocket");
  assert.equal(config.debug, true);
  assert.equal(config.generatorEnabled, true);
  assert.equal(config.generatorKey, "seed");
  assert.equal(config.acceptGenerated, false);
  assert.equal(config.adminKey, "admin-secret");
  assert.equal(config.decoyUrl, "https://example.com");
});

test("invalid carrier falls back to baseline default", () => {
  assert.equal(resolveConfig({ CARRIER: "unknown" }).carrier, DEFAULT_CONFIG.carrier);
});

test("loopback DC override requires explicit E2E test mode and does not mutate defaults", () => {
  const before = [...DEFAULT_CONFIG.dc[2]];
  const config = resolveConfig({
    E2E_TEST_MODE: "true",
    E2E_DC_HOST: "127.0.0.1",
    E2E_DC_PORT: "23456",
  });
  assert.deepEqual(config.dc[2], ["127.0.0.1"]);
  assert.deepEqual(config.dcPorts, [23456]);
  assert.deepEqual(DEFAULT_CONFIG.dc[2], before);
  assert.throws(() => resolveConfig({ E2E_TEST_MODE: "true", E2E_DC_HOST: "example.com", E2E_DC_PORT: "443" }), /requires E2E_DC_HOST=127\.0\.0\.1/);
});


test("DC overrides accept IPv4, IPv6, DNS endpoints and custom port lists", () => {
  const config = resolveConfig({ DC1: "149.154.175.50, [2001:db8::1]", DC2: "2001:db8::2 dns.example", DC_PORTS: "443, 8443;5222" });
  assert.deepEqual(config.dc[1], ["149.154.175.50", "2001:db8::1"]);
  assert.deepEqual(config.dc[2], ["2001:db8::2", "dns.example"]);
  assert.deepEqual(config.dcPorts, [443, 8443, 5222]);
});
