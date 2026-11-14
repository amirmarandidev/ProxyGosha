import { performance } from "node:perf_hooks";
import { encodeFrame, decodeFrameBatch } from "../src/protocol/frame.ts";
import { DcHealthRegistry } from "../src/dc-health.ts";

const requested = Number.parseInt(process.env.BENCH_ITERATIONS ?? "30000", 10);
const sizes = [64, 1024, 16 * 1024, 64 * 1024, 256 * 1024];
const rounds = Math.max(3, Math.min(9, Number.parseInt(process.env.BENCH_ROUNDS ?? "5", 10)));

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function measure(label, operation, iterations) {
  for (let i = 0; i < Math.min(5_000, iterations); i++) operation();
  const samples = [];
  const startHeap = process.memoryUsage().heapUsed;
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) operation();
    samples.push((performance.now() - start) / iterations);
  }
  const heapDelta = (process.memoryUsage().heapUsed - startHeap) / 1024 / 1024;
  const meanMs = samples.reduce((a, b) => a + b, 0) / samples.length;
  return `${label}: ${(1_000 / meanMs).toFixed(0)} ops/s; p50 ${(percentile(samples, .5) * 1_000).toFixed(3)} µs/op; p95 ${(percentile(samples, .95) * 1_000).toFixed(3)} µs/op; heap delta ${heapDelta >= 0 ? "+" : ""}${heapDelta.toFixed(2)} MiB`;
}

process.stdout.write(`ProxyGosha core microbenchmark (Node ${process.version}, ${rounds} rounds)\n`);
for (const size of sizes) {
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i++) payload[i] = i & 0xff;
  const frame = { type: 2, streamId: 7, payload };
  const encoded = encodeFrame(frame);
  const iterations = Math.max(1_000, Math.floor(requested * (16 * 1024 / size) ** .35));
  process.stdout.write(`\nPayload ${size.toLocaleString()} bytes (${iterations} iterations/round)\n`);
  process.stdout.write(measure("  frame encode", () => encodeFrame(frame), iterations) + "\n");
  process.stdout.write(measure("  frame decode", () => decodeFrameBatch(encoded), iterations) + "\n");
  process.stdout.write(measure("  encode + decode", () => decodeFrameBatch(encodeFrame(frame)), iterations) + "\n");
}

const registry = new DcHealthRegistry();
const endpoints = Array.from({ length: 32 }, (_, i) => ({ hostname: `dc-${i}.example`, port: 443 }));
for (let i = 0; i < endpoints.length; i++) {
  for (let n = 0; n < 20; n++) {
    if ((i + n) % 7 === 0) registry.reportFailure(endpoints[i]);
    else registry.reportSuccess(endpoints[i], 20 + ((i * 17 + n * 13) % 180));
  }
}
process.stdout.write("\n" + measure("DC ranking (32 endpoints)", () => registry.order(endpoints), Math.max(1_000, Math.floor(requested / 10))) + "\n");
