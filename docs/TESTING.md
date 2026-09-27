# Load Testing & Fault Injection

Two extra test types beyond the chaos suite (`test/run-all-chaos.js`): a k6 load test for throughput/latency under concurrency, and a Toxiproxy fault-injection test for behavior under real network degradation. Full results from both are in `BENCHMARK.md` — this doc is just how to install and run them yourself.

## k6 (load test)

k6 is a load-testing tool that runs your test script as a compiled binary, not through Node, so install it separately.

**Install:**

```bash
# macOS
brew install k6

# Windows (via Chocolatey)
choco install k6

# Linux (Debian/Ubuntu)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

Full instructions (other package managers, Docker image): [grafana.com/docs/k6/latest/set-up/install-k6](https://grafana.com/docs/k6/latest/set-up/install-k6/)

**Run it:**

Start the API and worker locally first (`docs/GETTING_STARTED.md`), then:

```bash
k6 run benchmarks/load-test.js
```

<!-- confirm this is the correct script path/name -->

It prints a full summary to the terminal, including the threshold pass/fail table — no separate report file needed unless you want one (`k6 run --out json=result.json benchmarks/load-test.js` if so).

## Toxiproxy (fault injection)

Toxiproxy is a proxy you put in front of a service, then inject faults into — latency, timeouts, connection resets — to see how your code actually handles a degrading network, instead of assuming.

**Install and run the Toxiproxy server:**

```bash
# macOS
brew tap shopify/shopify
brew install toxiproxy

# Linux / manual — download the binary for your platform
# https://github.com/Shopify/toxiproxy/releases

# start the server (keep this running in its own terminal)
toxiproxy-server
```

Docker is also an option if you'd rather not install it directly:

```bash
docker run -d --name toxiproxy -p 8474:8474 -p 8500:8500 shopify/toxiproxy
```

**What the test does:** it creates a proxy from port 8500 to your local webhook receiver (port 4000), confirms a clean delivery through it, then injects 4,000ms of latency into the stream and confirms the worker times out and schedules a retry rather than hanging or crashing.

**Run it:**

With `toxiproxy-server` running, plus the API and worker (same prerequisites as the chaos suite):

```bash
node test/<your-toxiproxy-test-file>.js
```

<!-- fill in the actual filename once finalized -->

## Order of operations

If you want to run everything in one sitting:

```bash
docker compose up -d          # Redis + Postgres
node src/config/migrate.js    # schema (first time only)
node src/api/server.js        # terminal 1
node src/workers/mailman.js   # terminal 2
toxiproxy-server               # terminal 3, only needed for the fault injection test

node test/run-all-chaos.js                    # chaos + idempotency + recovery suite
k6 run benchmarks/load-test.js                # throughput/latency under load
node test/<your-toxiproxy-test-file>.js       # network fault injection
```

## Cleaning up afterward

Test runs leave data behind in Redis and Postgres — stale locks, tripped circuit breakers, leftover job rows. See [`CLEANUP.md`](./CLEANUP.md) for how to check what's there and clear it, manually or with the automated wrapper scripts.