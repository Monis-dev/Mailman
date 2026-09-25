# Deployment

## Topology

Run the API and the worker as two separate processes/containers — they scale independently and a crash in one shouldn't take down the other. A minimal production layout:

```
[Load balancer] → [API instances] ──┐
                                     ├── Redis
[Worker instances] ──────────────────┘
                     └── Postgres
```

## Scaling workers

Each worker generates its own consumer name on startup (`worker-<pid>-<random hex>`, or set `CONSUMER_NAME` explicitly if you need a stable name for a given container). Running multiple worker instances in the same `GROUP_NAME` is safe — Redis consumer groups distribute stream messages across active consumers, and `XAUTOCLAIM` recovers work from any instance that dies. There's no shared in-memory state between workers, so you can scale this horizontally without coordination code.

## Redis persistence

By default Redis is in-memory only. For jobs to survive a Redis restart, enable AOF persistence in `redis.conf` or via `docker-compose.yml`:

```
appendonly yes
appendfsync everysec
```

`everysec` can lose up to one second of writes on a hard crash — that's the practical tradeoff between durability and write throughput. If you need stronger guarantees, `appendfsync always` fsyncs every write at a real performance cost. Whichever you choose, state it explicitly somewhere visible (this file, or your own ops docs) — don't let "zero data loss" be an assumption nobody checked.

## Postgres pool sizing

`src/config/db.js` sets `max: 50` for the connection pool. That number should stay below your Postgres instance's `max_connections`, with headroom for other clients (migrations, admin tools, other services). If you run multiple API or worker instances, remember the pool size is per-process — 5 worker instances at `max: 50` each is 250 potential connections, not 50. Size `max_connections` on the Postgres side accordingly, or lower the per-instance pool size.

## Environment variables

| Variable | Required | Read by | Notes |
|---|---|---|---|
| `RELAY_API_KEY` | Yes | server, SDK | No safe default — generate a real secret. |
| `WEBHOOK_SECRET` | Yes | server, worker, SDK | No safe default — generate a real secret. |
| `STREAM_KEY` | Yes | worker | No fallback in code; worker breaks if unset. |
| `GROUP_NAME` | Yes | worker | No fallback in code; worker breaks if unset. |
| `CONSUMER_NAME` | No | worker | Auto-generated per process if omitted. |
| `RATE_LIMIT_MAX` | No | server | Defaults to `10` requests per 10s window per IP. |
| `HOST` | No | server, migrate | Postgres host. Defaults to `localhost`. |
| `PORT` | No | server, migrate | Postgres port. Defaults to `5432`. |
| `USER` | No | server, migrate | Postgres user. Defaults to `postgres`. |
| `PASSWORD` | No | server, migrate | Postgres password. Defaults to `postgres` — change this in any real deployment. |
| `DATABASE` | No | server, migrate | Postgres database name. Defaults to `relayengine`. |
| `NODE_ENV` | No | server, worker | Set to `production` to enable stricter SSRF checks (blocks loopback/localhost as a webhook target). |

`HOST`, `PORT`, `USER`, `PASSWORD`, `DATABASE` are generic names shared with many other tools' conventions — double check nothing else in your deployment environment sets these and collides. Redis's host and port are hardcoded in `src/config/redis.js` (`127.0.0.1:6379`) and are not configurable via env var as shipped; edit that file or add an env-driven config if you're deploying against a non-local Redis.

## Monitoring

`GET /metrics` (behind bearer auth) exposes Prometheus-format metrics: `jobs_ingested_total`, `jobs_processed_total` (labeled by status), and `job_duration_seconds` as a histogram. A minimal scrape config:

```yaml
scrape_configs:
  - job_name: "mailman"
    metrics_path: /metrics
    bearer_token: "<RELAY_API_KEY>"
    static_configs:
      - targets: ["mailman-api:3000"]
```

Reasonable things to alert on: a sustained rise in `jobs_processed_total{status="DEAD_LETTER"}`, `job_duration_seconds` p99 climbing (downstream slowness), and `jobs_ingested_total` dropping to zero while your app is still sending traffic (ingestion is down).

## Before you deploy this for real traffic

- Rotate `RELAY_API_KEY` and `WEBHOOK_SECRET` away from any values used in development or testing.
- Set `NODE_ENV=production` so the SSRF guard blocks loopback targets.
- Decide and document your Redis persistence setting — see above.
- Set `PASSWORD` to something other than the default.
- Confirm `job_attempts` won't grow unbounded on your disk budget; there's no built-in pruning yet.
