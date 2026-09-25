# Getting Started

Get Mailman running locally and dispatch your first job in a few minutes.

## Prerequisites

- Node.js 18+
- Docker and Docker Compose
- `git`

## 1. Clone and configure

```bash
git clone https://github.com/<your-username>/mailman.git
cd mailman
cp .env.example .env
```

Open `.env` and fill in `RELAY_API_KEY` and `WEBHOOK_SECRET` with your own random strings (don't leave them blank — the server refuses to start without them). See the environment variable reference in `docs/DEPLOYMENT.md` for what every other variable does.

## 2. Start Redis and PostgreSQL

```bash
docker compose up -d
```

This starts local Redis and Postgres containers as defined in `docker-compose.yml`. Confirm both are up:

```bash
docker compose ps
```

## 3. Install dependencies and run the schema migration

```bash
npm install
node src/config/migrate.js
```

> Check `package.json` for a matching `npm run migrate` script — use that instead if one exists, it's equivalent.

## 4. Start the API and the worker

These are two separate long-running processes — start each in its own terminal.

**Terminal 1 — ingestion API:**
```bash
node src/api/server.js
```
You should see `Server Listining on Port: 3000`.

**Terminal 2 — background worker:**
```bash
node src/workers/mailman.js
```
You should see a line confirming the consumer group was created (or already exists) on `task:stream`.

## 5. Verify it's alive

```bash
curl -H "Authorization: Bearer <your RELAY_API_KEY>" http://localhost:3000/metrics
```

A `401` means your API key doesn't match `.env`. A connection error means the server isn't running or is on a different port.

## 6. Dispatch your first job

Create a tiny local receiver to see a job actually arrive — save this as `hello.js` in the repo root:

```javascript
import express from "express";
import Mailman from "./src/sdk/index.js";

// 1. A receiver that logs whatever it gets
const app = express();
app.use(express.json());
app.post("/hello", (req, res) => {
  console.log("Job received:", req.body);
  res.status(200).send("ok");
});
app.listen(4000, () => console.log("Receiver listening on :4000"));

// 2. Dispatch a job to it
const relay = new Mailman({
  endpoint: "http://localhost:3000",
  apiKey: process.env.RELAY_API_KEY,
});

const job = await relay.dispatch({
  service: "hello-world",
  target_url: "http://localhost:4000/hello",
  payload: { message: "first job" },
  idempotencyKey: "hello-" + Date.now(),
});

console.log("Dispatched:", job);
```

Run it:

```bash
node hello.js
```

Within a couple seconds you should see `Job received: { message: 'first job' }` printed — that's the worker picking the job up from Redis and delivering it. Check the worker's terminal too; it logs `JOB_COMPLETED` on success.

## Next steps

- Full endpoint and SDK reference: `docs/API_AND_SDK.md`
- How the pieces fit together and what guarantees you actually get: `docs/ARCHITECTURE.md`
- Running it somewhere other than your laptop: `docs/DEPLOYMENT.md`
- Something not working: `docs/TROUBLESHOOTING.md`
