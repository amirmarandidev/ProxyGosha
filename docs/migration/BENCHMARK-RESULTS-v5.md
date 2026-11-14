# ProxyGosha v5 local microbenchmark sample

Date: 2026-11-14  
Runtime: Node.js v22.16.0  
Host: Linux x64, AMD EPYC 9V74, 5 logical CPUs  
Rounds: 5; payload sizes: 64 B, 1 KiB, 16 KiB, 64 KiB, 256 KiB

These are local Node.js microbenchmarks. They are useful for comparing revisions
under the same runtime and host conditions. They are not Cloudflare Workers
throughput, Telegram DC throughput, or end-to-end network measurements. Heap delta
is a process-level before/after observation and is not a precise per-operation
allocation measurement.

| Payload | Operation | Ops/s | p50 µs/op | p95 µs/op |
|---:|---|---:|---:|---:|
| 64 B | Encode | 2,774,269 | 0.317 | 0.532 |
| 64 B | Decode | 7,705,472 | 0.128 | 0.137 |
| 64 B | Encode + decode | 2,212,262 | 0.456 | 0.458 |
| 1 KiB | Encode | 1,113,183 | 0.843 | 1.014 |
| 1 KiB | Decode | 7,951,800 | 0.125 | 0.131 |
| 1 KiB | Encode + decode | 843,361 | 1.206 | 1.244 |
| 16 KiB | Encode | 466,798 | 1.836 | 2.942 |
| 16 KiB | Decode | 8,096,654 | 0.120 | 0.145 |
| 16 KiB | Encode + decode | 491,577 | 1.886 | 2.472 |
| 64 KiB | Encode | 207,877 | 4.594 | 6.183 |
| 64 KiB | Decode | 7,626,917 | 0.126 | 0.146 |
| 64 KiB | Encode + decode | 203,348 | 4.604 | 5.984 |
| 256 KiB | Encode | 66,038 | 14.619 | 18.565 |
| 256 KiB | Decode | 5,831,051 | 0.153 | 0.271 |
| 256 KiB | Encode + decode | 62,978 | 15.682 | 17.341 |
| 32 endpoints | DC ranking | 137,714 | 7.130 | 8.066 |

Re-run with `npm run bench:core`. Use the same Node version, host, power profile,
and iteration settings when comparing revisions. Do not infer a proxy throughput
improvement from these microbenchmarks alone.
