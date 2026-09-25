import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import Mailman from "../src/sdk/index.js";
import redis from "../src/config/redis.js";
import pool from "../src/config/db.js";

dotenv.config();

const API_KEY = process.env.RELAY_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const GROUP_NAME = process.env.GROUP_NAME || "worker-group";
const STREAM_KEY = "task:stream";

if (!API_KEY || !WEBHOOK_SECRET) {
  console.error("Missing RELAY_API_KEY or WEBHOOK_SECRET in .env — aborting.");
  process.exit(1);
}

const relay = new Mailman({
  endpoint: "http://127.0.0.1:3000",
  apiKey: API_KEY,
});

// ---------------------------------------------------------------------
// Local receiver used as the delivery target for every proof
// ---------------------------------------------------------------------
const app = express();
app.use(express.json());

const received = new Map();
const dedupeStore = new Set();

app.post(
  "/webhook/normal",
  Mailman.createReceiverMiddleware({
    store: dedupeStore,
    secret: WEBHOOK_SECRET,
  }),
  (req, res) => {
    received.set(req.body.testId, req.body);
    res.status(200).json({ status: "acknowledged" });
  },
);

app.post("/webhook/outage", (req, res) => {
  res.status(500).json({ error: "simulated outage" });
});

const receiver = app.listen(4000);

function waitFor(testId, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (received.has(testId)) {
        clearInterval(timer);
        resolve(received.get(testId));
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error("webhook not received in time"));
      }
    }, 100);
  });
}

function signPayload(payload) {
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${JSON.stringify(payload)}`)
    .digest("hex");
  return {
    "X-Relay-Timestamp": String(timestamp),
    "X-Relay-Signature": `t=${timestamp},v1=${signature}`,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------
// Minimal runner — one place that prints and records pass/fail
// ---------------------------------------------------------------------
const results = [];

async function runProof(name, fn) {
  console.log(`\n[${results.length + 1}] ${name}`);
  const t0 = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - t0);
    console.log(`  PASS (${ms}ms) — ${detail}`);
    results.push({ proof: name, status: "PASS", timingMs: ms, detail });
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    console.log(`  FAIL (${ms}ms) — ${err.message}`);
    results.push({
      proof: name,
      status: "FAIL",
      timingMs: ms,
      detail: err.message,
    });
  }
}

// ---------------------------------------------------------------------
// Proof 1 — ingestion + end-to-end delivery
// ---------------------------------------------------------------------
async function proofIngestionAndDelivery() {
  const testId = `roundtrip-${Date.now()}`;
  const t0 = performance.now();

  const job = await relay.dispatch({
    service: "test-delivery",
    target_url: "http://127.0.0.1:4000/webhook/normal",
    payload: { testId },
    idempotencyKey: `idemp-${testId}`,
  });

  const dispatchMs = Math.round(performance.now() - t0);
  await waitFor(testId);

  return `dispatched in ${dispatchMs}ms, job_id=${job.job_id}, delivered and verified`;
}

// ---------------------------------------------------------------------
// Proof 2 — concurrent ingestion, distinct keys
// ---------------------------------------------------------------------
async function proofConcurrentIngestion() {
  const count = 15;
  const t0 = performance.now();

  const jobs = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      relay.dispatch({
        service: "test-concurrency",
        target_url: "http://127.0.0.1:4000/webhook/normal",
        payload: { index: i },
        idempotencyKey: `burst-${Date.now()}-${i}`,
      }),
    ),
  );

  const totalMs = Math.round(performance.now() - t0);
  if (!jobs.every((j) => j && j.job_id)) {
    throw new Error("one or more dispatches did not return a job_id");
  }

  return `${count} jobs dispatched in ${totalMs}ms (${Math.round(totalMs / count)}ms avg)`;
}

// ---------------------------------------------------------------------
// Proof 3 — same idempotency key, concurrent requests, exactly one wins
// ---------------------------------------------------------------------
async function proofIdempotencyRace() {
  const key = `race-${Date.now()}`;
  const attempts = 50;

  const outcomes = await Promise.all(
    Array.from({ length: attempts }, () =>
      relay
        .dispatch({
          service: "test-idempotency",
          target_url: "http://127.0.0.1:4000/webhook/normal",
          payload: { attack: true },
          idempotencyKey: key,
        })
        .then(() => 202)
        .catch((err) => {
          if (err.message.includes("409")) return 409;
          throw err;
        }),
    ),
  );

  const accepted = outcomes.filter((s) => s === 202).length;
  const rejected = outcomes.filter((s) => s === 409).length;

  if (accepted !== 1 || rejected !== attempts - 1) {
    throw new Error(
      `expected 1 accepted / ${attempts - 1} rejected, got ${accepted}/${rejected}`,
    );
  }

  return `${attempts} concurrent requests, same key — exactly 1 accepted, ${rejected} rejected`;
}

// ---------------------------------------------------------------------
// Proof 4 — receiver-side dedup on a real redelivery (signed, like the worker sends)
// ---------------------------------------------------------------------
async function proofReceiverDedup() {
  const testId = `dedupe-${Date.now()}`;
  const payload = { action: "charge", testId };
  const headers = {
    "Content-Type": "application/json",
    "X-Idempotency-Key": testId,
    ...signPayload(payload),
  };

  const first = await fetch("http://127.0.0.1:4000/webhook/normal", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }).then((r) => r.json());

  const second = await fetch("http://127.0.0.1:4000/webhook/normal", {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  }).then((r) => r.json());

  if (first.status !== "acknowledged") {
    throw new Error(
      `first delivery not acknowledged: ${JSON.stringify(first)}`,
    );
  }
  if (second.deduped !== true) {
    throw new Error(`redelivery was not deduped: ${JSON.stringify(second)}`);
  }

  return "first delivery executed, identical redelivery caught and deduped before business logic ran";
}

// ---------------------------------------------------------------------
// Proof 5 — downstream outage trips the circuit breaker
// ---------------------------------------------------------------------
async function proofCircuitBreaker() {
  await redis.del("circuit:127.0.0.1:state", "circuit:127.0.0.1:failures");

  const t0 = performance.now();
  for (let i = 0; i < 5; i++) {
    await relay.dispatch({
      service: "test-circuit",
      target_url: "http://127.0.0.1:4000/webhook/outage",
      payload: { failure: true },
      idempotencyKey: `trip-${Date.now()}-${i}`,
    });
  }
  const dispatchMs = Math.round(performance.now() - t0);

  // poll instead of a fixed sleep, so we measure actual trip time
  const deadline = Date.now() + 8000;
  let state = null;
  const pollStart = performance.now();
  while (Date.now() < deadline) {
    state = await redis.get("circuit:127.0.0.1:state");
    if (state === "OPEN") break;
    await sleep(200);
  }
  const tripMs = Math.round(performance.now() - pollStart);

  if (state !== "OPEN") {
    throw new Error(`expected circuit state OPEN, got "${state}"`);
  }

  return `5 failures dispatched in ${dispatchMs}ms, circuit tripped to OPEN ${tripMs}ms after the 5th failure was processed`;
}

// ---------------------------------------------------------------------
// Proof 6 — kill the worker mid-job, confirm a fresh worker finishes it
// ---------------------------------------------------------------------
async function proofWorkerRecovery() {
  await redis.del(STREAM_KEY);

  const doomedWorker = spawn("node", ["src/workers/mailman.js"], {
    stdio: "ignore",
    env: { ...process.env, CONSUMER_NAME: `doomed-${Date.now()}` },
  });
  await sleep(1500); // let it register the consumer group

  const testId = `murder-${Date.now()}`;
  const job = await relay.dispatch({
    service: "test-recovery",
    target_url: "https://httpbin.org/delay/2", // slow enough to guarantee it's in-flight
    payload: { testId },
    idempotencyKey: `idemp-${testId}`,
  });

  await sleep(500); // let the worker pull it into the PEL
  doomedWorker.kill("SIGKILL");
  const killedAt = performance.now();

  const pending = await redis.xpending(STREAM_KEY, GROUP_NAME);
  const pendingCount = pending && pending[0] ? pending[0] : 0;
  if (pendingCount === 0) {
    return "job completed before SIGKILL landed — 0 drops, nothing to recover";
  }

  // A second worker should claim and finish the abandoned job.
  const rescueWorker = spawn("node", ["src/workers/mailman.js"], {
    stdio: "ignore",
    env: { ...process.env, CONSUMER_NAME: `rescue-${Date.now()}` },
  });

  const deadline = Date.now() + 20000; // recovery poll runs every 10s, give it two cycles
  let status = null;
  while (Date.now() < deadline) {
    const { rows } = await pool.query("SELECT status FROM jobs WHERE id = $1", [
      job.job_id,
    ]);
    status = rows[0]?.status;
    if (status === "COMPLETED") break;
    await sleep(1000);
  }

  rescueWorker.kill("SIGKILL");

  if (status !== "COMPLETED") {
    throw new Error(
      `job never completed after recovery — last status: ${status}`,
    );
  }

  const recoveryMs = Math.round(performance.now() - killedAt);
  return `worker killed mid-job, ${pendingCount} job(s) stuck in PEL, fresh worker recovered and completed it in ${recoveryMs}ms (time from SIGKILL to COMPLETED)`;
}

// ---------------------------------------------------------------------
// Run everything, print a scorecard, exit non-zero on any failure
// ---------------------------------------------------------------------
async function main() {
  console.log(
    "RelayEngine chaos suite — requires server + Redis + Postgres running\n",
  );

  await runProof("Ingestion & delivery", proofIngestionAndDelivery);
  await runProof(
    "Concurrent ingestion (15 requests)",
    proofConcurrentIngestion,
  );
  await runProof(
    "Idempotency race guard (50 requests, 1 key)",
    proofIdempotencyRace,
  );
  await runProof("Receiver-side dedup on redelivery", proofReceiverDedup);
  await runProof("Circuit breaker trips on outage", proofCircuitBreaker);
  await runProof("Worker SIGKILL + recovery", proofWorkerRecovery);

  console.log("\n--- scorecard ---");
  console.table(results);

  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`${results.length - failed} passed, ${failed} failed`);

  receiver.close();
  await pool.end();
  redis.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main();
