# Architecture

## Job lifecycle

```
Client
  │  POST /v1/jobs  (Bearer auth, Idempotency-Key header)
  ▼
Ingestion API (src/api/server.js)
  │  1. rate limiter (fails open on Redis error)
  │  2. bearer auth (timing-safe comparison)
  │  3. presence check on service/target_url/payload
  │  4. SSRF check on target_url (DNS-resolved, all A/AAAA records)
  │  5. Redis SET idempotency:<key> NX EX 86400  — atomic lock
  │  6. INSERT into Postgres jobs table, status=QUEUED
  │  7. XADD to Redis stream task:stream
  │  8. respond 202 { job_id, status: "QUEUED" }
  │
  │  if step 6 or 7 throws after step 5 succeeded: DEL the idempotency
  │  key so the client can retry with the same key instead of being
  │  locked out for 24h
  ▼
Redis Stream (task:stream)
  ▼  XREADGROUP, consumer group per worker fleet
Worker (src/workers/mailman.js)
  │  1. canExecute(domain) — circuit breaker check
  │  2. isValidWebhookUrl(target_url) — SSRF check, re-run here because
  │     the target could have changed DNS since ingestion
  │  3. sign payload with HMAC-SHA256, timestamp included
  │  4. fetch(target_url, { redirect: "manual" }) — redirects are not
  │     followed, closing a 302-to-internal-IP bypass
  │  5. on success: XACK, UPDATE jobs SET status=COMPLETED, log to
  │     job_attempts
  │  6. on failure: log to job_attempts, increment circuit breaker
  │     failure count, then either:
  │     - schedule a retry on the delayed shelf (ZADD task:delayed)
  │       with exponential backoff + jitter, or
  │     - if MAX_ATTEMPTS (3) reached: XADD to task:dlq, UPDATE jobs
  │       SET status=DEAD_LETTER
  ▼
Destination endpoint
  │  verifies X-Relay-Signature, checks X-Idempotency-Key against its
  │  own store to dedupe redeliveries (see API_AND_SDK.md)
```

Two background loops run alongside the main read loop:

- `pollDelayJobs()` — every 1s, moves matured entries from the `task:delayed` ZSET back onto `task:stream`.
- `recoverStuckjobs()` — every 10s, runs `XAUTOCLAIM` to find jobs that have sat unacknowledged in the Pending Entries List (PEL) for more than 5s and reassigns them to an active consumer. This is what recovers work from a worker that was killed mid-job.

## Why two stores

Redis holds everything that needs to be fast and is fine to lose in the worst case: the stream itself, the PEL, delayed retries, circuit breaker counters, rate limit windows, idempotency locks. Postgres holds the permanent record: job status and the full `job_attempts` audit log (status code, duration, error message per attempt). If Redis loses data, you lose in-flight coordination, not history. If you only had Redis, a flush or eviction would erase your audit trail; if you only had Postgres, you'd need to poll a table to find work, which doesn't scale the way a stream with consumer groups does.

## Delivery semantics — read this before you rely on it

Mailman gives you **at-least-once delivery**, not exactly-once. A job can be delivered more than once in ordinary failure conditions:

- The worker's `fetch` succeeds, but the process is killed before it can `XACK`. The job stays in the PEL, gets reclaimed by `XAUTOCLAIM`, and is delivered again.
- A network timeout happens after the destination already received and processed the request.

This is a property of delivering over a network, not a bug to be fixed. The fix lives on the receiving end: every webhook carries `X-Idempotency-Key` and `X-Attempt-Number`, and the SDK ships `Mailman.createReceiverMiddleware({ secret, store })`, which verifies the HMAC signature first, then checks the idempotency key against a store you provide, and short-circuits with `{ deduped: true }` on a repeat. Signature check runs before the dedupe lookup specifically so an unauthenticated request can't probe which keys have already been processed. Combining at-least-once delivery with receiver-side dedup is what the README calls "effective exactly-once" — the guarantee is enforced at the edge, not inside the queue.

## Crash recovery in detail

`XAUTOCLAIM` is the mechanism, and it only works because of consumer groups. When a worker reads a message with `XREADGROUP`, Redis doesn't delete it — it moves the message into that consumer's entry in the PEL and waits for an explicit `XACK`. If the worker dies before acking, the message just sits there under a dead consumer's name. `recoverStuckjobs()` calls `XAUTOCLAIM` with a minimum idle time of 5000ms, which finds any PEL entry idle longer than that, reassigns it to the calling (live) consumer, and returns it for processing — same code path as a normal message via `processJob()`.

Each worker process generates its own consumer name (`worker-<pid>-<random hex>`, or `CONSUMER_NAME` if you set it) so that multiple worker instances don't collide in the same consumer group, and so a dead worker's abandoned entries are attributable and claimable.

## Security model

**SSRF protection.** `isValidWebhookUrl()` resolves the target hostname with `dns.lookup(hostname, { all: true })`, checking every returned address rather than just the first, and blocks: the AWS/GCP metadata address `169.254.169.254`, `0.0.0.0`, loopback (`127.0.0.1`/`localhost` in production only), private IPv4 ranges (`10.x`, `192.168.x`, `172.x`), and IPv6 private/link-local ranges (`fc00::/7` families, `fe80::/10`). This check runs twice: once at ingestion (`server.js`), and again inside the worker immediately before the `fetch` call. The second check exists because a domain that resolved to a public IP at ingestion time could repoint its DNS to an internal address before the job is actually delivered — which can be well over a minute later if it goes through a retry or circuit-breaker delay. Re-checking at delivery time closes that window.

Known gap: the IPv6 prefix check uses `startsWith("fc")`, which does not catch the full `fc00::/7` range — addresses starting `fd` are also inside that range but aren't matched by a plain `fc` prefix check. If you're hardening this further, fix the prefix logic or parse and compare the address numerically instead of string-matching.

**No redirect bypass.** The worker's `fetch` call sets `redirect: "manual"`, so a public URL that responds with a `302` to an internal address is not followed automatically.

**Signed webhooks.** Every outbound webhook carries `X-Relay-Signature: t=<timestamp>,v1=<hmac>` computed as `HMAC-SHA256(secret, "<timestamp>.<payload>")`. `Mailman.verifySignature()` recomputes it and compares with `crypto.timingSafeEqual`, and also rejects signatures older than a configurable tolerance (default 300s) to limit replay of a captured request.

**Timing-safe auth.** The `Authorize` middleware should use `crypto.timingSafeEqual` for the bearer token comparison rather than `!==`, to avoid leaking match-length information via response timing. Confirm this is the case in your copy of `auth.js` before treating it as hardened.

**Fail-open, not fail-closed.** Both the rate limiter and the circuit breaker treat a Redis error as "allow the request" rather than "block everything," so a Redis blip degrades to no-rate-limiting/no-circuit-breaking rather than a full outage. This is a deliberate tradeoff — you lose protection during a Redis incident, in exchange for not taking down the whole system because of it.

## Known limitations, stated plainly

- Delivery order is not guaranteed once retries and the delayed shelf are involved.
- The circuit breaker has no half-open state — after the 30s OPEN window expires, it goes straight back to fully open, so if the downstream is still failing you'll get a fresh burst of attempts before it trips again.
- `job_attempts` grows unbounded; there's no built-in archival or pruning.
