import express from "express";
import redis from "../config/redis.js";

const app = express();
const port = 3000;

app.use(express.json());

app.post("/", (req, res) => {
  console.log(req.body);
  res.end();
});

app.post("/v1/jobs", async (req, res) => {
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
    const job_id = await redis.xadd(
      "task:stream",
      "*",
      "service",
      service,
      "target_url",
      target_url,
      "payload",
      JSON.stringify(payload),
    );
    console.log("Successful created job id ")
    res.status(202).json({ job_id: job_id, status: "QUEUED" });
  } catch (error) {
    console.log("Unable to fetch data");
    res.status(error.statusCode || 500 ).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log("Server Listining on Port:", port);
});
