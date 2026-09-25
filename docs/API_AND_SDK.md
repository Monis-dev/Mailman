# API & SDK Reference

## Authentication

Every endpoint except delivery webhooks themselves requires a bearer token:

```
Authorization: Bearer <RELAY_API_KEY>
```

Requests without a valid token get `401 Unauthorized`.

## Rate limiting

All endpoints are rate-limited per client IP: a sliding 10-second window, `RATE_LIMIT_MAX` requests per window (default 10). Exceeding it returns `429 Too Many Requests` with a `Retry-After: 10` header. If Redis is unreachable, the limiter fails open — requests are allowed through rather than blocked, so a Redis outage doesn't take down your ingestion.

---

## `POST /v1/jobs`

Queue a new job for background delivery.

**Headers**

| Header | Required | Notes |
|---|---|---|
| `Authorization` | Yes | `Bearer <RELAY_API_KEY>` |
| `Content-Type` | Yes | `application/json` |
| `Idempotency-Key` | Yes | Any unique string. Submitting the same key twice returns `409` on the second attempt — this is the de-dup guarantee, not a bug. |

**Body**

```json
{
  "service": "welcome-email",
  "target_url": "https://your-app.com/webhooks/send-email",
  "payload": { "to": "user@example.com" }
}
```

All three fields are required. `target_url` must be a public `http`/`https` URL — private IPs, loopback, and cloud metadata addresses are rejected.

**Responses**

| Status | Meaning |
|---|---|
| `202 Accepted` | Queued. Body: `{ "job_id": <id>, "status": "QUEUED" }` |
| `400 Bad Request` | Missing field, or `target_url` failed the SSRF check |
| `401 Unauthorized` | Missing/invalid bearer token |
| `409 Conflict` | This `Idempotency-Key` was already used |
| `429 Too Many Requests` | Rate limit exceeded |

**curl**

```bash
curl -X POST http://localhost:3000/v1/jobs \
  -H "Authorization: Bearer $RELAY_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-1234-checkout" \
  -d '{
    "service": "welcome-email",
    "target_url": "https://your-app.com/webhooks/send-email",
    "payload": { "to": "user@example.com" }
  }'
```

**Python (requests)**

```python
import requests

resp = requests.post(
    "http://localhost:3000/v1/jobs",
    headers={
        "Authorization": f"Bearer {RELAY_API_KEY}",
        "Idempotency-Key": "order-1234-checkout",
    },
    json={
        "service": "welcome-email",
        "target_url": "https://your-app.com/webhooks/send-email",
        "payload": {"to": "user@example.com"},
    },
)
print(resp.status_code, resp.json())
```

**Go (net/http)**

```go
body, _ := json.Marshal(map[string]interface{}{
    "service":    "welcome-email",
    "target_url": "https://your-app.com/webhooks/send-email",
    "payload":    map[string]string{"to": "user@example.com"},
})
req, _ := http.NewRequest("POST", "http://localhost:3000/v1/jobs", bytes.NewBuffer(body))
req.Header.Set("Authorization", "Bearer "+relayAPIKey)
req.Header.Set("Content-Type", "application/json")
req.Header.Set("Idempotency-Key", "order-1234-checkout")
resp, err := http.DefaultClient.Do(req)
```

---

## `GET /v1/jobs/:id`

Fetch a job's current state.

**Response `200`**

```json
{
  "id": 42,
  "idempotency_key": "order-1234-checkout",
  "service": "welcome-email",
  "target_url": "https://your-app.com/webhooks/send-email",
  "payload": { "to": "user@example.com" },
  "status": "COMPLETED",
  "created_at": "...",
  "updated_at": "..."
}
```

`status` is one of `QUEUED`, `COMPLETED`, or `DEAD_LETTER`. `404` if the ID doesn't exist.

```bash
curl -H "Authorization: Bearer $RELAY_API_KEY" http://localhost:3000/v1/jobs/42
```

---

## `POST /v1/jobs/:id/replay`

Re-enqueues a job that landed in `DEAD_LETTER`. Only jobs in that status can be replayed — anything else returns `400`.

```bash
curl -X POST -H "Authorization: Bearer $RELAY_API_KEY" http://localhost:3000/v1/jobs/42/replay
```

This actually re-fires the webhook — don't expose it to anyone you wouldn't trust to trigger that job again.

---

## `GET /metrics`

Prometheus-format metrics: job counts by status, ingestion counts, and delivery duration histograms. Requires the same bearer auth as everything else.

```bash
curl -H "Authorization: Bearer $RELAY_API_KEY" http://localhost:3000/metrics
```

---

## Node.js SDK

```javascript
import Mailman from "./sdk/index.js";

const relay = new Mailman({
  endpoint: "http://localhost:3000", // default: http://localhost:3000
  apiKey: process.env.RELAY_API_KEY, // default: ""
  maxRetries: 3,                     // default: 3 — client-side retries on 5xx/network errors
  timeout: 5000,                     // default: 5000ms per attempt
});
```

4xx responses (`400`, `401`, `409`, etc.) are not retried by the SDK — they fail immediately, since retrying a request that's deterministically wrong wastes time. Only `5xx` and network errors are retried, with a short linear backoff between attempts.

### `relay.dispatch({ service, target_url, payload, idempotencyKey })`

Queues a job. Returns the parsed response body (`{ job_id, status }`). If `idempotencyKey` is omitted, a random UUID is generated for you — meaning you lose the dedup guarantee across retries of your own request, so pass one explicitly whenever the caller might resend.

### `relay.getJobStatus(jobId)`

Returns the current job record — same shape as `GET /v1/jobs/:id`.

### `relay.replay(jobId)`

Triggers `POST /v1/jobs/:id/replay`.

---

## Verifying and deduplicating incoming webhooks

Every job delivery from the worker carries these headers:

| Header | Contents |
|---|---|
| `X-Idempotency-Key` | The same key you dispatched with |
| `X-Attempt-Number` | Which attempt this is (1, 2, 3...) |
| `X-Relay-Signature` | `t=<timestamp>,v1=<hmac-sha256-hex>` |
| `X-Relay-Timestamp` | The timestamp used in the signature |

Delivery is **at-least-once** — under failure conditions (worker crash after a successful send, network drop before the ack) the same job can be delivered more than once. Always dedupe on `X-Idempotency-Key` on your receiving end if the action isn't naturally idempotent (e.g. charging a card, sending an email).

### Option A — the built-in middleware (Express)

```javascript
import express from "express";
import Mailman from "./sdk/index.js";

const app = express();
app.use(express.json());

app.post(
  "/webhooks/send-email",
  Mailman.createReceiverMiddleware({
    secret: process.env.WEBHOOK_SECRET,
    // store: an object with a persistent Set-like interface if you want
    // dedup to survive a restart — defaults to an in-memory Set
  }),
  (req, res) => {
    // signature verified, redelivery already deduped
    console.log("verified job:", req.body);
    res.status(200).send("ok");
  },
);
```

The middleware checks the signature first and rejects with `401` if it's invalid, then checks the idempotency store and short-circuits with `200 { deduped: true }` if this key was already processed — so a bad-faith request can't use the dedup check to probe which keys are valid before it has a valid signature.

### Option B — manual verification

```javascript
import Mailman from "./sdk/index.js";

const valid = Mailman.verifySignature({
  payload: JSON.stringify(req.body),
  signatureHeader: req.headers["x-relay-signature"],
  secret: process.env.WEBHOOK_SECRET,
  toleranceInSeconds: 300, // reject signatures older than 5 minutes — replay protection
});

if (!valid) return res.status(401).send("invalid signature");
```

`verifySignature` uses `crypto.timingSafeEqual` internally, so it's safe against timing-based signature guessing.
