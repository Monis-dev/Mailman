import redis from "../config/redis.js";
import pool from "../config/db.js";
import {
  canExecute,
  recordSuccess,
  recordFailure,
} from "../utils/circuitBreaker.js";
import { jobDurationSeconds, jobsProcessedTotal } from "../utils/metrics.js";
import logger from "../utils/logger.js";
import dotenv from "dotenv";

dotenv.config();

const STREAM_KEY = process.env.STREAM_KEY;
const GROUP_NAME = process.env.GROUP_NAME;
const CONSUMERE = 1;
const MAX_ATTEMPTS = 3;
let isPolling = false;

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

async function processJob(messageId, rawFields) {
  try {
    const fields = {};
    for (let i = 0; i < rawFields.length; i += 2) {
      fields[rawFields[i]] = rawFields[i + 1];
    }
    const job_id = fields.job_id;
    const domain = new URL(fields.target_url).hostname;
    const currentAttempt = fields.attempts ? parseInt(fields.attempts, 10) : 0;
    const startTime = performance.now();
    try {
      const isAllowed = await canExecute(domain);
      if (!isAllowed) {
        const wakeUpTime = Date.now() + 30000;
        await redis.zadd(
          "task:delayed",
          wakeUpTime,
          JSON.stringify({
            job_id: fields.job_id,
            service: fields.service,
            target_url: fields.target_url,
            payload: fields.payload,
            attempts: currentAttempt,
          }),
        );
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        logger.warn("CIRCUIT_SKIPPED", {domain, job_id})
        return;
      }
      const response = await fetch(fields.target_url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: fields.payload,
      });
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }
      const durationMs = Math.round(performance.now() - startTime);
      jobDurationSeconds.observe(
        { service: fields.service, domain },
        durationMs / 1000,
      );
      await pool.query(
        "INSERT INTO job_attempts (job_id, attempt_number, response_status_code, execution_duration_ms, error_message) VALUES ($1, $2, $3, $4, $5);",
        [job_id, currentAttempt + 1, response.status, durationMs, null],
      );
      await pool.query(
        "UPDATE jobs SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1",
        [job_id],
      );
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
      if (nextAttempt >= MAX_ATTEMPTS) {
        await redis.xadd(
          "task:dlq",
          "*",
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
        const delay =
          1000 * 2 ** currentAttempt + Math.floor(Math.random() * 500);
        const wakeUpTime = Date.now() + delay;
        await redis.zadd(
          "task:delayed",
          wakeUpTime,
          JSON.stringify({
            job_id: fields.job_id,
            service: fields.service,
            target_url: fields.target_url,
            payload: fields.payload,
            attempts: nextAttempt,
          }),
        );
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

async function startWorker() {
  while (true) {
    try {
      const result = await redis.xreadgroup(
        "GROUP",
        GROUP_NAME,
        CONSUMERE,
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
      console.log(error.message);
    }
  }
}

async function pollDelayJobs() {
  if (isPolling) return;
  isPolling = true;
  try {
    const now = Date.now();
    const readyJobs = await redis.zrangebyscore("task:delayed", 0, now);
    if (readyJobs.length === 0) return;
    for (const jobString of readyJobs) {
      const job = JSON.parse(jobString);
      await redis.xadd(
        STREAM_KEY,
        "*",
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
    isPolling = false;
  }
}

async function recoverStuckjobs() {
  if (isPolling) return;
  isPolling = true;
  try {
    const result = await redis.xautoclaim(
      STREAM_KEY,
      GROUP_NAME,
      CONSUMERE,
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
    isPolling = false;
  }
}

startWorker();
setInterval(pollDelayJobs, 1000);
setInterval(recoverStuckjobs, 10000);
