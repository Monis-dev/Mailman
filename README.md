# Mailman

> A lightweight, fault-tolerant background task and webhook delivery engine built with Node.js, Redis Streams, and PostgreSQL.

Mailman lets your backend offload slow, unreliable operations (transactional emails, third-party webhooks, CRM syncs) in under **15ms**, while guaranteeing background delivery with exponential backoff, atomic deduplication, and crash recovery.

<!-- DEMO_VIDEO_PLACEHOLDER -->
<!-- [![Demo](./assets/demo-thumbnail.png)](https://your-video-link) -->
<!-- or embed a GIF: ![demo](./assets/demo.gif) -->

---

## ⚡ Performance & Guarantees at a Glance

- **Throughput & Latency:** Sustained ~740 RPS with a 94ms P99 latency across 15,000 requests under heavy concurrency.
- **At-Least-Once Delivery:** Tasks survive worker crashes and process kills using Redis `XAUTOCLAIM`.
- **Atomic Deduplication:** Zero duplicate executions via Redis distributed locks (`SET ... NX`).
- **Hardened Security:** Built-in SSRF defense (dual-stack DNS resolution), HMAC-SHA256 payload signing, and sliding-window rate limiting.
- **No Lock-In:** 100% self-hosted using your own Redis and PostgreSQL instances.

---

## 🛑 The Problem It Solves

When an API executes multi-step external I/O directly in the HTTP request loop:

```javascript
// The Anti-Pattern: Slow and Fragile
app.post("/api/checkout", async (req, res) => {
  await chargeCard(req.body);
  await sendReceiptEmail(req.body); // If this hangs 5s, the user waits 5s.
  await triggerPartnerWebhook(req.body); // If this fails, the whole call throws 500.
  res.json({ ok: true });
});
```

Using unawaited promises (`sendReceiptEmail()` without `await`) creates bigger risks:

- **No Durability:** If the Node process restarts or crashes mid-flight, the job vanishes forever.
- **No Retries:** If the downstream API drops the connection, no retry is attempted.
- **No Dedup:** Accidental double-clicks trigger duplicated side-effects.

Mailman decouples ingestion from delivery safely: your app drops the job into Mailman in under 15ms, answers the user with `202 Accepted`, and lets the worker engine handle retries, backoff, and crash recovery.

---

## 🏗️ Architecture & Operational Flow

```text
                    Your Application
                              │
                              │ POST /v1/jobs (Bearer Auth + Idempotency-Key)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│ Ingestion API (Express / Node.js)                           │
│ 1. Verify Bearer Token (crypto.timingSafeEqual)             │
│ 2. Enforce 64KB Payload Limit & Sliding-Window Rate Limiter │
│ 3. Reserve Idempotency Lock (Redis SET NX)                  │
│ 4. Persist initial state to PostgreSQL (jobs table)         │
│ 5. Push task to Redis Stream (XADD)                         │
│ 6. Respond 202 Accepted in <15ms                            │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ Redis Stream: 'task:stream' (Durable Buffer)                │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼ (XREADGROUP)
┌─────────────────────────────────────────────────────────────┐
│ Background Worker Process                                   │
│ 1. Validate Target URL (DNS lookup & SSRF shield)           │
│ 2. Check Circuit Breaker for target domain                  │
│ 3. Stamp HMAC-SHA256 signature (X-Relay-Signature)          │
│ 4. Dispatch HTTP POST (redirects disabled)                  │
│                                                             │
│ Outcome A (Success): Send XACK + Record DB latency          │
│ Outcome B (Failure): Reschedule with backoff in ZSET        │
│ Outcome C (Max Retries): Move to 'task:dlq'                 │
│ Outcome D (Worker Dies): Reclaimed via XAUTOCLAIM           │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart

### 1. Clone & Configure

```bash
git clone https://github.com/Monis-dev/mailman.git
cd mailman
cp .env.example .env
```

### 2. Launch Infrastructure

```bash
docker-compose up -d
```

### 3. Run Migrations & Start Services

```bash
npm install
npm run migrate

# Start the Ingestion API
npm run server

# In a separate terminal, start the Background Worker
npm run worker
```

---

## 💻 Zero-Dependency Client SDK

Mailman includes a zero-dependency SDK for interaction and signature verification:

### Sending a Job from Your App

```javascript
import Mailman from "./sdk/index.js";

const relay = new Mailman({
  endpoint: "http://localhost:3000",
  apiKey: process.env.RELAY_API_KEY,
});

const job = await relay.dispatch({
  service: "welcome-email",
  target_url: "https://your-api.com/webhooks/send-email",
  payload: { to: "user@example.com", name: "Alex" },
  idempotencyKey: "order_99182_checkout",
});

console.log(job); // { job_id: "...", status: "QUEUED" }
```

### Safe Webhook Verification on Receiver Side

Mailman provides built-in Express middleware to eliminate timing attacks and deduplicate deliveries:

```javascript
import express from "express";
import Mailman from "./sdk/index.js";

const app = express();

app.post(
  "/webhooks/send-email",
  express.raw({ type: "application/json" }),
  Mailman.createReceiverMiddleware({
    secret: process.env.WEBHOOK_SECRET,
  }),
  (req, res) => {
    // Verified, timing-safe, and deduplicated
    const event = JSON.parse(req.body);
    console.log("Processing verified task:", event);
    res.status(200).send("OK");
  },
);
```

---

## 🛡️ Security Engineering

- **SSRF Shield with Dual-Stack DNS Resolution:** Resolves target domains via `dns.promises.lookup` right before invocation. Blocks IPv4 private subnets (RFC 1918), loopbacks, AWS metadata endpoints (`169.254.169.254`), and IPv6 private/link-local variants (`::1`, `fc00::/7`, `fe80::/10`).
- **Cryptographic Request Signing:** Every outgoing webhook carries `X-Relay-Signature` (HMAC-SHA256) and timestamp tolerance checks to prevent replay attacks.
- **Compensating Transactions:** If an internal PostgreSQL or Redis Stream write fails after an idempotency lock is claimed, the lock is instantly released (`redis.del`), preventing customer requests from becoming trapped in a 24-hour `409 Conflict` state.
- **Timing-Safe Auth:** Prevents side-channel timing analysis on API keys using `crypto.timingSafeEqual`.

---

## 🧪 Chaos Engineering & Benchmarks

Run the built-in stress and failure injection suite:

```bash
# Run chaos scenarios (Worker SIGKILL, Circuit Breakers, Race Attacks)
node test/run-all-chaos.js

# Run high-concurrency performance benchmark
node test/benchmark.js
```

### Benchmark Summary (Local Machine, Concurrency = 50)

| Metric | Value |
| --- | --- |
| Total Requests | 15,000 in 20.16s |
| Throughput | ~737.15 req/sec |
| Status Codes | 14,743 `202 Accepted` (100% non-rate-limited success) |
| P50 Latency | 66 ms |
| P97.5 Latency | 86 ms |
| P99 Latency | 94 ms |


---

## ⚙️ Environment Variables

Copy `.env.example` to `.env` and configure before running:

| Variable | Required | Consumed By | Purpose |
| --- | --- | --- | --- |
| `RELAY_API_KEY` | Yes | Server, SDK | Bearer token securing the ingestion API. |
| `WEBHOOK_SECRET` | Yes | Server, Worker, SDK | Secret used for HMAC-SHA256 webhook signatures. |
| `DATABASE_URL` | Yes | Server, Worker | PostgreSQL connection string for migrations and audit logs. |
| `REDIS_URL` | No | Server, Worker | Redis connection string (defaults to `redis://127.0.0.1:6379`). |
| `STREAM_KEY` | No | Worker | Redis Stream identifier (defaults to `task:stream`). |
| `GROUP_NAME` | No | Worker | Redis Consumer Group name (defaults to `worker-group`). |
| `CONSUMER_NAME` | No | Worker | Worker instance ID (auto-generated per process if omitted). |
| `RATE_LIMIT_MAX` | No | Server | Max requests per client IP per 10s window (defaults to `100`). |
| `NODE_ENV` | No | All | Set to `production` to activate strict loopback/private IP blocking. |

---

## 📜 License

Distributed under the MIT License. See `LICENSE` for details.