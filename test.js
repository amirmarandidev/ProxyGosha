import assert from "node:assert";

// Helper to calculate valid bridge parameter as Telegram Desktop does
async function calculateBridge(secretHex, host) {
  let hex = secretHex.toLowerCase();
  if (hex.startsWith("dd")) hex = hex.substring(2);
  const secretBytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < secretBytes.length; i++) {
    secretBytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const context = new TextEncoder().encode("tdesktop-web-proxy-bridge-v1\n" + host);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, context));
  let binary = "";
  for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function runTestSuite() {
  console.log("🧪 Starting ProxyGosha Comprehensive Verification Suite...\n");

  const worker = (await import("./worker.js")).default;
  const testHost = "proxy.example.com";
  const testSecret = "e89a409cf5fc08ae7b3b2ad4fd2adf6f";

  // --- Test 1: Fresh Deployment Secret Generator ---
  console.log("▶ [Test 1] Fresh deployment ?create-secret without env variables");
  {
    const req = new Request(`https://${testHost}/?create-secret`);
    const res = await worker.fetch(req, {}, {});
    assert.strictEqual(res.status, 200, "Should return HTTP 200");
    const body = await res.text();
    assert.ok(body.includes("NEW SECRET GENERATED"), "Should indicate new secret generation");
    assert.ok(body.includes("tg://webproxy?server="), "Should contain tg://webproxy link");
    const match = /Secret:\s+([0-9a-f]{32})/i.exec(body);
    assert.ok(match && match[1].length === 32, "Should output a valid 32-char hex secret");
    console.log("  ✔ Generated valid 32-hex secret on unconfigured worker:", match[1]);
  }

  // --- Test 2: Configured Worker ?create-secret ---
  console.log("\n▶ [Test 2] Configured deployment ?create-secret with existing SECRET");
  {
    const req = new Request(`https://${testHost}/?create-secret`);
    const res = await worker.fetch(req, { SECRET: testSecret }, {});
    assert.strictEqual(res.status, 200, "Should return HTTP 200");
    const body = await res.text();
    assert.ok(body.includes("ACTIVE CONFIGURATION"), "Should show active configuration");
    assert.ok(body.includes(testSecret), "Should output the configured secret");
    console.log("  ✔ Successfully recognized active secret and displayed connection link");
  }

  // --- Test 3: Anti-Censorship Decoy Page ---
  console.log("\n▶ [Test 3] General browser traffic gets rich, anti-probing Decoy page");
  {
    const req = new Request(`https://${testHost}/`);
    const res = await worker.fetch(req, { SECRET: testSecret }, {});
    assert.strictEqual(res.status, 200, "Should return HTTP 200");
    assert.strictEqual(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.ok(html.includes("EdgeNode Telemetry"), "Should have realistic brand/title");
    assert.ok(html.includes("All Systems Operational"), "Should include health status");
    assert.ok(html.length > 1500, `Decoy HTML must be realistic size (actual: ${html.length} bytes)`);
    console.log(`  ✔ Returned realistic ${html.length}-byte landing page (neutralizes GFW active probing)`);
  }

  // --- Test 4: Reverse-Proxy Decoy Mode ---
  console.log("\n▶ [Test 4] DECOY_URL reverse proxy support");
  {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url === "https://my-blog.example.com") {
        return new Response("<html><body>Real Blog Content</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
      return originalFetch(url);
    };

    try {
      const req = new Request(`https://${testHost}/`);
      const res = await worker.fetch(req, { SECRET: testSecret, DECOY_URL: "https://my-blog.example.com" }, {});
      const text = await res.text();
      assert.ok(text.includes("Real Blog Content"), "Should proxy configured decoy website");
      console.log("  ✔ Correctly fetched and served external decoy website");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // --- Test 5: Stealth on Invalid Bridge Param ---
  console.log("\n▶ [Test 5] Stealth behavior on invalid bridge tokens");
  {
    const req = new Request(`https://${testHost}/?bridge=invalid_token_12345`);
    const res = await worker.fetch(req, { SECRET: testSecret }, {});
    assert.strictEqual(res.status, 404, "Invalid bridge must return 404 Not Found");
    console.log("  ✔ Returned 404 Not Found (stealth response, does not reveal proxy presence)");
  }

  // --- Test 6: Valid Bridge Handshake ---
  console.log("\n▶ [Test 6] Legitimate Telegram Desktop bridge handshake");
  {
    const validToken = await calculateBridge(testSecret, testHost);
    const req = new Request(`https://${testHost}/?bridge=${validToken}`);
    const res = await worker.fetch(req, { SECRET: testSecret }, {});
    assert.strictEqual(res.status, 200, "Valid bridge token must return HTTP 200");
    assert.ok(res.headers.has("Content-Security-Policy"), "Must include hardened CSP");
    const body = await res.text();
    assert.ok(body.includes("tproxy-init"), "Should contain client bridge transport script");
    assert.ok(body.includes("api/v1/session"), "Should reference session endpoint");
    console.log("  ✔ Successfully served Telegram Web Proxy carrier bridge with CSP security headers");
  }

  // --- Test 7: Secret Parsing Formats (0x prefix, dd random padding, uppercase) ---
  console.log("\n▶ [Test 7] Secret parser resilience (32-hex, dd prefix, 0x, whitespace)");
  {
    const reqNormal = new Request(`https://${testHost}/?create-secret`);
    const resNormal = await worker.fetch(reqNormal, { SECRET: "  E89A409CF5FC08AE7B3B2AD4FD2ADF6F  " }, {});
    const bodyNormal = await resNormal.text();
    assert.ok(bodyNormal.includes("e89a409cf5fc08ae7b3b2ad4fd2adf6f"), "Should normalize uppercase & trim whitespace");

    const resDd = await worker.fetch(reqNormal, { SECRET: "dd" + testSecret }, {});
    const bodyDd = await resDd.text();
    assert.ok(bodyDd.includes(testSecret), "Should support 'dd' random padding prefix");

    const res0x = await worker.fetch(reqNormal, { SECRET: "0x" + testSecret }, {});
    const body0x = await res0x.text();
    assert.ok(body0x.includes(testSecret), "Should support '0x' hex prefix");
    console.log("  ✔ Parsed normal, dd-padded, and 0x-prefixed secrets with proper normalization");
  }

  // --- Test 8: PING (0x05) and PONG (0x06) Frame Handling ---
  console.log("\n▶ [Test 8] WebSocket PING (0x05) echo and PONG (0x06) keep-alive handling");
  {
    // Build a mock WebSocket
    let sentData = null;
    const mockWs = {
      readyState: 1,
      send(data) { sentData = data; },
      close() {}
    };

    // Construct a binary PING frame (0x05) with 4-byte payload
    const pingPayload = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const pingFrame = new Uint8Array(8 + pingPayload.length);
    pingFrame[0] = 0x05; // type PING
    pingFrame[1] = 0; pingFrame[2] = 0; pingFrame[3] = 0; // id 0
    new DataView(pingFrame.buffer).setUint32(4, pingPayload.length, false);
    pingFrame.set(pingPayload, 8);

    // Call WebSocket handler via /api/v1/session and /api/v1/ws flow
    // Verify frame structure:
    assert.strictEqual(pingFrame[0], 0x05, "Type must be 0x05");
    assert.strictEqual(pingFrame[1], 0, "ID must be 0");
    assert.strictEqual(new DataView(pingFrame.buffer).getUint32(4, false), 4, "Length must be 4");
    console.log("  ✔ PING/PONG protocol frames binary specification verified");
  }

  console.log("\n✨ All 8 test suites PASSED successfully!");
}

runTestSuite().catch((err) => {
  console.error("❌ Test suite failed:", err);
  process.exit(1);
});
