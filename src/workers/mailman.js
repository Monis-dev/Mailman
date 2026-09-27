// Worker process: Consumes tasks from Redis Stream, executes webhook HTTP requests, handles retries, and recovers stuck jobs.

import redis from "../config/redis.js";
import pool from "../config/db.js";
import {
  canExecute,
  recordSuccess,
  recordFailure,
} from "../utils/circuitBreaker.js";
import { jobDurationSeconds, jobsProcessedTotal } from "../utils/metrics.js";
import isValidWebhookUrl from "../utils/urlValidator.js";
import logger from "../utils/logger.js";
import dotenv from "dotenv";
import process from "node:process";
import crypto from "node:crypto";

console.log("Worker ID: ", process.pid);

dotenv.config();

const STREAM_KEY = process.env.STREAM_KEY;
const GROUP_NAME = process.env.GROUP_NAME;
const CONSUMER_NAME =
  process.env.CONSUMER_NAME ||
  `worker-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
const MAX_ATTEMPTS = 3;
let isPollingDelay = false;
let isRecovering = false;
const WEBHOOK_SECRET =
  process.env.WEBHOOK_SECRET || "whsec_default_secrete_key";

  // Create the consumer group on the Redis stream if it doesn't already exist
try {
  await redis.xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM");
  console.log(`Created group "${GROUP_NAME}" on stream "${STREAM_KEY}"`);
} catch (error) {
  if (error.message.includes("BUSYGROUP")) {
    console.log(`Group "${GROUP_NAME}" already exist`);
  } else {
    throw error;
  }
}

// Core delivery pipeline: handles circuit checking, webhook signing, HTTP dispatch, and retry/DLQ scheduling
async function processJob(messageId, rawFields) {
  try {
    const fields = {};
    // Redis returns stream fields as flat key-value arrays; convert them into an object
    for (let i = 0; i < rawFields.length; i += 2) {
      fields[rawFields[i]] = rawFields[i + 1];
    }
    const job_id = fields.job_id;
    const domain = new URL(fields.target_url).hostname;
    const currentAttempt = fields.attempts ? parseInt(fields.attempts, 10) : 0;
    const startTime = performance.now();
    try {
      // Check if the destination domain circuit is open; if so, delay execution by 30s
      const isAllowed = await canExecute(domain);
      if (!isAllowed) {
        const wakeUpTime = Date.now() + 30000;
        await redis.zadd(
          "task:delayed",
          wakeUpTime,
          JSON.stringify({
            idempotency_key: fields.idempotency_key,
            job_id: fields.job_id,
            service: fields.service,
            target_url: fields.target_url,
            payload: fields.payload,
            attempts: currentAttempt,
          }),
        );
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        logger.warn("CIRCUIT_SKIPPED", { domain, job_id });
        return;
      }
      const timestamp = Date.now();
      // Generate an HMAC signature so the webhook receiver can verify authenticity
      const signature = crypto
        .createHmac("sha256", WEBHOOK_SECRET)
        .update(`${timestamp}.${fields.payload}`)
        .digest("hex");
      // Re-verify URL at runtime to prevent SSRF attacks against internal network hosts
      const isSafeUrl = await isValidWebhookUrl(fields.target_url);
      if (!isSafeUrl) {
        throw new Error(
          "SSRF Guard: Target URL resolved to a blocked IP address",
        );
      }
      // Dispatch the webhook payload with idempotency, signature, and attempt headers
      const response = await fetch(fields.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": fields.idempotency_key || fields.job_id,
          "X-Attempt-Number": String(currentAttempt + 1),
          "X-Relay-Signature": `t=${timestamp},v1=${signature}`,
          "X-Relay-Timestamp": String(timestamp),
        },
        body: fields.payload,
        redirect: "manual",
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const durationMs = Math.round(performance.now() - startTime);
      jobDurationSeconds.observe(
        { service: fields.service, domain },
        durationMs / 1000,
      );
      // Log the successful execution attempt and update the job status in PostgreSQL
      await pool.query(
        "INSERT INTO job_attempts (job_id, attempt_number, response_status_code, execution_duration_ms, error_message) VALUES ($1, $2, $3, $4, $5);",
        [job_id, currentAttempt + 1, response.status, durationMs, null],
      );
      await pool.query(
        "UPDATE jobs SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1",
        [job_id],
      );
      // Reset circuit breaker failure count and acknowledge the message in Redis
      await recordSuccess(domain);
      await redis.xack(STREAM_KEY, GROUP_NAME, messageId);

      jobsProcessedTotal.inc({ service: fields.service, status: "COMPLETED" });

      logger.info("JOB_COMPLETED", {
        job_id: job_id,
        durationMs: durationMs,
      });
    } catch (error) {
      const nextAttempt = currentAttempt + 1;
      const durationMs = Math.round(performance.now() - startTime);
      jobDurationSeconds.observe(
        { service: fields.service, domain },
        durationMs / 1000,
      );
      await pool.query(
        "INSERT INTO job_attempts (job_id, attempt_number, response_status_code, execution_duration_ms, error_message) VALUES ($1, $2, $3, $4, $5);",
        [job_id, nextAttempt, null, durationMs, error.message],
      );
      await recordFailure(domain);
      // If the maximum retry attempts are exhausted, move the job to the Dead Letter Queue
      if (nextAttempt >= MAX_ATTEMPTS) {
        await redis.xadd(
          "task:dlq",
          "*",
          "idempotency_key",
          fields.idempotency_key || "",
          "service",
          fields.service,
          "target_url",
          fields.target_url,
          "payload",
          fields.payload,
          "attempts",
          String(nextAttempt),
          "error",
          error.message,
        );
        await pool.query(
          "UPDATE jobs SET status = 'DEAD_LETTER', updated_at = NOW() WHERE id = $1",
          [job_id],
        );
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        jobsProcessedTotal.inc({
          service: fields.service,
          status: "DEAD_LETTER",
        });
        logger.error("JOB_DEAD_LETTER", {
          job_id: job_id,
          durationMs: durationMs,
          error: error.message,
        });
      } else {
        // Schedule a retry with exponential backoff plus random jitter to avoid thundering herds
        const delay =
          1000 * 2 ** currentAttempt + Math.floor(Math.random() * 500);
        const wakeUpTime = Date.now() + delay;
        await redis.zadd(
          "task:delayed",
          wakeUpTime,
          JSON.stringify({
            idempotency_key: fields.idempotency_key,
            job_id: fields.job_id,
            service: fields.service,
            target_url: fields.target_url,
            payload: fields.payload,
            attempts: nextAttempt,
          }),
        );
        // Store retry in a sorted set scored by timestamp, then acknowledge the current message
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        console.log(
          `Job ${messageId} failed. Scheduling retry #${nextAttempt}`,
        );
      }
    }
    console.log(`Processing Job: ${messageId}`, fields);
  } catch (error) {
    console.log("Error occured with error: ", error.message);
  }
}

// Continuously poll the Redis stream for new pending messages assigned to this consumer
async function startWorker() {
  while (true) {
    try {
      const result = await redis.xreadgroup(
        "GROUP",
        GROUP_NAME,
        CONSUMER_NAME,
        "BLOCK",
        2000,
        "COUNT",
        1,
        "STREAMS",
        STREAM_KEY,
        ">",
      );

      if (result && result.length > 0) {
        const [stream, messages] = result[0];
        for (const [messageId, rawFields] of messages) {
          await processJob(messageId, rawFields);
        }
      }
    } catch (error) {
      // Auto-heal: recreate consumer group if it was accidentally dropped or flushed
      if (error.message.includes("NOGROUP")) {
        await redis
          .xgroup("CREATE", STREAM_KEY, GROUP_NAME, "0", "MKSTREAM")
          .catch(() => {});
      } else {
        console.error("[WORKER ERROR]:", error.message);
      }
    }
  }
}

// Periodically checks the delayed sorted set and moves due jobs back to the main processing stream
async function pollDelayJobs() {
  if (isPollingDelay) return;
  isPollingDelay = true;
  try {
    const now = Date.now();
    // Fetch all jobs whose wake-up time is less than or equal to current timestamp
    const readyJobs = await redis.zrangebyscore("task:delayed", 0, now);
    if (readyJobs.length === 0) return;
    for (const jobString of readyJobs) {
      const job = JSON.parse(jobString);
      await redis.xadd(
        STREAM_KEY,
        "*",
        "idempotency_key",
        job.idempotency_key || "",
        "job_id",
        String(job.job_id),
        "service",
        job.service,
        "target_url",
        job.target_url,
        "payload",
        job.payload,
        "attempts",
        job.attempts,
        "error",
        job.error,
      );
      await redis.zrem("task:delayed", jobString);
    }
    console.log(`Job moved to the main stream: ${STREAM_KEY}`);
  } catch (error) {
    console.log(`Unable to move the job to main stream`);
  } finally {
    isPollingDelay = false;
  }
}

// Reclaim jobs that have been pending for over 5 seconds from crashed or unresponsive workers
async function recoverStuckjobs() {
  if (isRecovering) return;
  isRecovering = true;
  try {
    // Transfer ownership of abandoned messages to this worker
    const result = await redis.xautoclaim(
      STREAM_KEY,
      GROUP_NAME,
      CONSUMER_NAME,
      5000,
      "0-0",
      "COUNT",
      10,
    );
    const [nextStartId, claimedMessage, deletedMessageId] = result;
    if (claimedMessage.length === 0) return;
    for (const [messageId, rawFields] of claimedMessage) {
      console.log(`Recovered abandoned job: ${messageId}`);
      await processJob(messageId, rawFields);
    }
  } catch (error) {
    console.log(error.message);
  } finally {
    isRecovering = false;
  }
}

startWorker();
setInterval(pollDelayJobs, 1000);
setInterval(recoverStuckjobs, 10000);
