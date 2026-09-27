// Main HTTP server: Handles job ingestion, status lookups, job replaying, and metrics.

import express from "express";
import redis from "../config/redis.js";
import pool from "../config/db.js";
import rateLimiter from "./middlewares/ratelimiter.js";
import Authorize from "./middlewares/auth.js";
import isValidWebhookUrl from "../utils/urlValidator.js";
import { register, jobsIngestedTotal } from "../utils/metrics.js";
import logger from "../utils/logger.js";

const app = express();
const port = 3000;

app.use(express.json({ limit: "64kb" }));

// Expose Prometheus metrics for server health and job monitoring
app.get("/metrics", Authorize, async (req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    const metricsData = await register.metrics();
    res.end(metricsData);
  } catch (error) {
    console.log("Unable to monitor");
  }
});

// Fetch a job's current status and details by its database ID
app.get("/v1/jobs/:id", rateLimiter, Authorize, async (req, res) => {
  try {
    const jobId = req.params.id;
    const response = await pool.query("SELECT * FROM jobs WHERE id = $1", [
      jobId,
    ]);
    // Return 404 if no job matches the given ID
    if (response.rows.length === 0) {
      throw new Error("Job id is invalid!");
    }
    res.status(200).json(response.rows[0]);
  } catch (error) {
    console.log("Unable to fetch data from database!");
    res.status(404).json({ error: error.message });
  }
});

// Ingest a new webhook task, enforce idempotency, and push it to the Redis queue
app.post("/v1/jobs", rateLimiter, Authorize, async (req, res) => {
  let lockAcquired = false;
  // Ensure all required fields and the idempotency header are provided
  const idempotencyKey = req.headers["idempotency-key"];
  try {
    const { service, target_url, payload } = req.body;
    if (!idempotencyKey || !service || !target_url || !payload) {
      const error = new Error("Bad Request");
      error.statusCode = 400;
      throw error;
    }

    // Prevent SSRF attacks by blocking private network, local, or cloud metadata URLs
    const isAllowed = await isValidWebhookUrl(target_url);
    if (!isAllowed) {
      return res.status(400).json({
        error:
          "Invalid target_url: Private or metadata addresses are prohibited",
      });
    }

    // Acquire an idempotency lock in Redis for 24 hours (NX ensures only the first request wins)
    const result = await redis.set(
      `idempotency:${idempotencyKey}`,
      "PROCESSING",
      "EX",
      86400,
      "NX",
    );

    // If the key already exists, reject the request to prevent duplicate processing
    if (result == null) {
      const error = new Error("Confict");
      error.statusCode = 409;
      throw error;
    }
    lockAcquired = true;
    const currentStatus = "QUEUED";
    // Store the job record in PostgreSQL with an initial 'QUEUED' status
    const response = await pool.query(
      "INSERT INTO jobs (idempotency_key, service, target_url, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [
        idempotencyKey,
        service,
        target_url,
        JSON.stringify(payload),
        currentStatus,
      ],
    );
    const pgJobId = response.rows[0].id;
    // Push the job onto the Redis Stream for worker consumers to process
    const job_id = await redis.xadd(
      "task:stream",
      "*",
      "idempotency_key",
      idempotencyKey,
      "job_id",
      pgJobId,
      "service",
      service,
      "target_url",
      target_url,
      "payload",
      JSON.stringify(payload),
    );
    // Update metrics and write a structured log for tracking
    jobsIngestedTotal.inc({ service });
    logger.info("JOB_INGESTED", {
      job_id: pgJobId,
      service,
      idempotency_key: idempotencyKey,
    });
    res.status(202).json({ job_id: pgJobId, status: "QUEUED" });
  } catch (error) {
    // Release the idempotency lock if an error occurred so the user can safely retry
    logger.error("JOB_INGESTION_FAILED", {
      error: error.message,
      status_code: error.statusCode || 500,
    });
    if (lockAcquired && idempotencyKey) {
      await redis.del(`idempotency:${idempotencyKey}`);
    }
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// Replay a failed job by moving it out of the dead letter queue back to the stream
app.post("/v1/jobs/:id/replay", rateLimiter, Authorize, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    const job = result.rows[0];
    if (result.rows.length <= 0) {
      return res.status(404).json({ error: "Job not found!" });
    }

    // Only allow retries for jobs that have completely failed and exhausted their retries
    if (job.status !== "DEAD_LETTER") {
      return res
        .status(400)
        .json({ error: "Only Dead Letter Jobs can be replayed" });
    }

    // Reset the job status back to QUEUED in the database
    await pool.query(
      "UPDATE jobs SET status = 'QUEUED', updated_at = NOW() WHERE id = $1",
      [job.id],
    );

    // Re-add the job to the Redis Stream with its attempt counter reset to 0
    await redis.xadd(
      "task:stream",
      "*",
      "job_id",
      String(job.id),
      "service",
      job.service,
      "target_url",
      job.target_url,
      "payload",
      JSON.stringify(job.payload),
      "attempts",
      "0",
    );
    res
      .status(200)
      .json({ message: "Job re-enqueued for execution", job_id: job.id });
    console.log(`Job ${job.id} successfully re-enqueued for exeuction`);
  } catch (error) {
    console.log("Unable to get Job Id");
    res.status(400).json({ error: "Unable to fetch the job id" });
  }
});

app.listen(port, () => {
  console.log("Server Listining on Port:", port);
});
