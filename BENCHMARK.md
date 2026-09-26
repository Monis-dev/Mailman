# Benchmarks

Two kinds of testing here, and they answer different questions. Load testing (k6) asks "how does it perform under normal, high-volume traffic?" Fault injection (Toxiproxy) asks "what happens when the network in between actually breaks?" Most benchmarks only show the first one.

## Load test — k6

50 virtual users, 30 seconds, hitting `POST /v1/jobs` continuously.

```
checks_total.......: 35610   1183.984293/s
checks_succeeded...: 100.00% 35610 out of 35610
checks_failed......: 0.00%

http_reqs..........: 17805   591.992147/s
http_req_failed....: 0.00%   0 out of 17805

http_req_duration:
  avg  33.77ms   min 12.1ms    med  30.64ms
  p90  45.77ms   p95 54.89ms   p99  79.71ms
  max  354.5ms
```

| Threshold | Target | Result |
|---|---|---|
| p95 latency | < 75ms | 54.89ms — passed |
| p99 latency | < 120ms | 79.71ms — passed |
| Failure rate | < 1% | 0.00% — passed |

17,805 requests, zero failures, zero non-202 responses, sustained ~592 req/s on a single local instance for the full 30s run.

**What this doesn't tell you:** this is one machine, one process, no other load sharing the box. It's a real number, but it's not a promise about your infrastructure. Run it yourself against your own hardware before trusting it for capacity planning — see "Reproduce this" below.

## Fault injection — Toxiproxy

Load testing shows how the system behaves when everything works. This shows what happens when it doesn't. [Toxiproxy](https://github.com/Shopify/toxiproxy) sits between the worker and the destination endpoint and lets you inject real network faults — latency, timeouts, connection resets — instead of just imagining them.

**Setup:** Toxiproxy proxying port 8500 → 4000 (the destination webhook receiver).

**Test 1 — clean path.** Dispatch a job through the proxy with no fault injected, confirm it delivers normally.

```
✔ Toxiproxy online: Proxying port 8500 -> 4000
✔ Clean proxy delivery verified
```

**Test 2 — 4,000ms latency injected into the TCP stream.** This simulates a slow or struggling downstream, not a clean failure.

```
✔ Ingestion remained sub-50ms (20ms) despite 4s network toxic
ℹ Worker timed out and scheduled exponential backoff (resilience verified)
```

The result that matters here: injecting 4 seconds of latency into the delivery path did not touch ingestion latency. A client calling `POST /v1/jobs` has no idea the downstream is struggling — it still gets a fast `202` back. The worker is the one that eats the timeout, and it responds the way it's supposed to: mark the attempt failed, schedule a retry with backoff, move on. That separation — a slow or broken destination degrading the worker instead of the client — is the actual point of the architecture, and this is what verifies it rather than assumes it.

## Hardened security

**TOCTOU-resistant SSRF protection.** Target URLs are resolved with dual-stack DNS lookup (both IPv4 and IPv6 addresses checked, not just the first result) immediately before every egress `fetch` — not just once at job submission. This closes the window where a domain could pass validation, then repoint its DNS to an internal address before delivery actually happens, which can be well after the initial check if a job sits on a retry or behind a circuit-breaker delay. Blocked ranges include IPv4 RFC 1918 private subnets, IPv6 link-local addresses, and the cloud metadata address `169.254.169.254`. Redirects are disabled on the delivery request (`redirect: "manual"`), so a `302` response can't be used to bounce a request into an internal address after the check has already passed. Full detail in `docs/ARCHITECTURE.md`.

**Crash recovery, verified not assumed.** A running worker was killed mid-job with `SIGKILL` — no graceful shutdown, no chance to acknowledge. The in-flight job was left in Redis's Pending Entries List (PEL), reserved under a now-dead consumer. A second worker process, started after the kill, reclaimed it via `XAUTOCLAIM` and completed it — zero message loss, no manual intervention.

## Local chaos & security test suite

Beyond the k6 load test and the Toxiproxy fault injection above, there's a local suite (`test/run-all-chaos.js`) that exercises the failure paths those two don't reach — idempotency under a real race, receiver-side dedup, and the SIGKILL recovery scenario described above. All six proofs passed on the last local run:

| # | Proof | What it verifies |
|---|---|---|
| 1 | Ingestion & delivery | A job dispatched through the real API is picked up by the worker and actually delivered to the destination. |
| 2 | Concurrent ingestion (15 requests) | 15 simultaneous dispatches with distinct keys all succeed and return valid job IDs — no lock contention failures under concurrency. |
| 3 | Idempotency race guard (50 requests, 1 key) | 50 simultaneous requests with the *same* idempotency key — exactly 1 is accepted, 49 rejected with `409`. Proves the Redis `SET NX` lock is atomic under real concurrent load, not just in theory. |
| 4 | Receiver-side dedup on redelivery | Two signed, identical webhook deliveries — the first executes, the second is caught and deduped before it reaches business logic. This is what turns at-least-once delivery into effectively-once handling. |
| 5 | Circuit breaker trips on outage | 5 consecutive failed deliveries to the same domain trip the circuit to `OPEN`, halting further attempts to that domain until cooldown. |
| 6 | Worker SIGKILL + recovery | Worker killed mid-delivery with `SIGKILL`; a fresh worker recovers the orphaned job from the PEL via `XAUTOCLAIM` and completes it. |

Run it yourself:

```bash
node test/run-all-chaos.js
```

It prints per-proof timing and a full scorecard at the end (`console.table`) — paste your own run's output here once you have a copy you want to keep as a record, since exact timings will vary by machine.



```bash
# load test
k6 run benchmarks/load-test.js

# fault injection (requires Toxiproxy running)
node test/<your-toxiproxy-test-file>.js
```

<!-- fill in the exact script name/path once finalized -->

Both require the API and worker running locally first — see `docs/GETTING_STARTED.md`.

## Caveats, stated plainly

- Single local machine, not a distributed or multi-node setup.
- 50 concurrent users is a meaningful number, not a stress-test ceiling — it hasn't been pushed to find where it actually breaks.
- The Toxiproxy run tested one fault type (latency) at one value (4s). It hasn't been run against connection resets, packet loss, or bandwidth throttling yet.
- These numbers are from one run. If you want confidence they're stable, run it a few times and look at the spread, not just one good result.