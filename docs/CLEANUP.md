# Cleaning Up Test Data

Running the chaos suite, k6, or Toxiproxy repeatedly leaves data behind — Redis keys, queued jobs, and rows in Postgres. If you don't clean it up, the next test run (or worse, real usage afterward) can inherit stale locks, tripped circuit breakers, or a backlog of leftover jobs that slows everything down or causes confusing failures that have nothing to do with your actual code.

**Rule of thumb: clean up after every testing session, before you either walk away or start using the system for anything real.**

## Automated cleanup (do this first)

If you're using the wrapper scripts, cleanup already happens for you:

- `node test/run-all-chaos.js` flushes Redis and deletes its own Postgres rows both before and after the run.
- `test/run-k6.sh` / `test/run-k6.ps1` do the same around the k6 run.

If you've been running these scripts, you likely don't need to do anything manually. The rest of this doc is for when you want to check, or when something was run outside the wrapper scripts (e.g. `k6 run` called directly).

## Checking what's actually in Redis

Before deleting anything, see what's there:

```bash
docker exec -it mailman-redis redis-cli KEYS "*"
```

You'll typically see patterns like `idempotency:*`, `circuit:*:state`, `circuit:*:failures`, `ratelimit:*`, `task:stream`, `task:delayed`, `task:dlq`.

Two useful sizing checks if things feel slow or a test times out unexpectedly:

```bash
docker exec -it mailman-redis redis-cli XLEN task:stream
docker exec -it mailman-redis redis-cli XPENDING task:stream worker-group
```

A large number here usually means old, unprocessed test jobs are backed up — a good sign it's time to clean up.

## Cleaning Redis manually

**Delete one specific key:**
```bash
docker exec -it mailman-redis redis-cli DEL "idempotency:some-key"
```

**Delete everything matching a pattern** (e.g. just circuit breaker state, leaving other data alone):
```bash
docker exec -it mailman-redis redis-cli --scan --pattern "circuit:*" | xargs -I{} docker exec mailman-redis redis-cli DEL {}
```
(`xargs` isn't available natively in PowerShell — run this one from WSL/Git Bash, or just delete keys one at a time with `DEL`.)

**Wipe everything** — the simplest option, and what the automated scripts already do:
```bash
docker exec -it mailman-redis redis-cli FLUSHALL
```

> **Warning:** `FLUSHALL` wipes the *entire* Redis instance, not just test data. This is safe for a local dev Redis with nothing else in it. Never run this against a shared or production instance that holds real data — there is no undo.

## Cleaning Postgres manually

Test runs create real rows in `jobs` and `job_attempts`, tagged by `service` name (`test-delivery`, `test-concurrency`, `test-idempotency`, `test-circuit`, `test-recovery`, `k6-load-benchmark`). Delete just those, leaving any real job history intact:

```bash
docker exec -it mailman-postgres psql -U postgres -d relayengine -c \
  "DELETE FROM job_attempts WHERE job_id IN (SELECT id FROM jobs WHERE service IN ('test-delivery','test-concurrency','test-idempotency','test-circuit','test-recovery','k6-load-benchmark'));"

docker exec -it mailman-postgres psql -U postgres -d relayengine -c \
  "DELETE FROM jobs WHERE service IN ('test-delivery','test-concurrency','test-idempotency','test-circuit','test-recovery','k6-load-benchmark');"
```

To see how much test data has piled up before deciding to clean it:

```bash
docker exec -it mailman-postgres psql -U postgres -d relayengine -c \
  "SELECT service, COUNT(*) FROM jobs GROUP BY service ORDER BY COUNT(*) DESC;"
```

## Full reset (nuclear option)

If you just want a completely clean slate and don't need to preserve anything:

```bash
docker compose down
docker compose up -d --build
```

This clears Redis entirely (no persistent volume is configured for it in this project). Postgres data persists across `down`/`up` unless you also run `docker compose down -v`, which drops volumes too — use that when you want Postgres wiped as well, e.g. before a truly clean-room test of the whole setup from scratch.

## Before you push or hand this off to someone else

Run a full cleanup pass so nobody inherits your test session's leftovers:

```bash
docker exec -it mailman-redis redis-cli FLUSHALL
docker exec -it mailman-postgres psql -U postgres -d relayengine -c "DELETE FROM job_attempts;"
docker exec -it mailman-postgres psql -U postgres -d relayengine -c "DELETE FROM jobs;"
```

This is safe here specifically because at this point you want *everything* test-related gone, not just your own service names — do this only when you're certain there's no real data you want to keep.