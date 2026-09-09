import express from "express";
import redis from "../config/redis.js";
import pool from "../config/db.js";
import rateLimiter from "./middlewares/ratelimiter.js";

const app = express();
const port = 3000;

app.use(express.json());

app.post("/", (req, res) => {
  console.log(req.body);
  res.end();
});

app.post("/v1/jobs", rateLimiter, async (req, res) => {
  try {
    const idempotencyKey = req.headers["idempotency-key"];
    const { service, target_url, payload } = req.body;
    if (!idempotencyKey || !service || !target_url || !payload) {
      const error = new Error("Bad Request");
      error.statusCode = 400;
      throw error;
    }
    const result = await redis.set(
      `idempotency:${idempotencyKey}`,
      "PROCESSING",
      "EX",
      86400,
      "NX",
    );
    if (result == null) {
      const error = new Error("Confict");
      error.statusCode = 409;
      throw error;
    }
    const currentStatus = "QUEUED"
    const response = await pool.query(
      "INSERT INTO jobs (idempotency_key, service, target_url, payload, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [
        idempotencyKey,
        service, 
        target_url,
        JSON.stringify(payload),
        currentStatus
      ]
    );
    const pgJobId = response.rows[0].id
    const job_id = await redis.xadd(
      "task:stream",
      "*",
      "job_id",
      pgJobId,
      "service",
      service,
      "target_url",
      target_url,
      "payload",
      JSON.stringify(payload),
    );
    console.log("Successful created job id ");
    res.status(202).json({ job_id: pgJobId, status: "QUEUED" });
  } catch (error) {
    console.log("Unable to fetch data");
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post("/v1/jobs/:id/replay", async(req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM jobs WHERE id = $1", [id]);
    const job = result.rows[0]
    if( result.rows.length <= 0) {
      return res.status(404).json({error: "Job not found!"})
    }
    if(job.status !== "DEAD_LETTER") {
      return res.status(400).json({error: "Only Dead Letter Jobs can be replayed"})
    }
    await pool.query("UPDATE jobs SET status = 'QUEUED', updated_at = NOW() WHERE id = $1", [job.id])
    await redis.xadd(
      "task:stream",
      "*",
      "job_id", String(job.id),
      "service", job.service,
      "target_url", job.target_url,
      "payload", JSON.stringify(job.payload),
      "attempts", "0"
    )
    res
      .status(200)
      .json({ message: "Job re-enqueued for execution", job_id: job.id });
    console.log(`Job ${job.id} successfully re-enqueued for exeuction`)
  } catch (error) {
    console.log("Unable to get Job Id")
    res.status(400).json({error: "Unable to fetch the job id"})
  }
  
})

app.listen(port, () => {
  console.log("Server Listining on Port:", port);
});
