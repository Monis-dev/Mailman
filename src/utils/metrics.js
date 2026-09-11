import client from "prom-client";

const register = new client.Registry();

client.collectDefaultMetrics({ register });

export {register}

export const jobsIngestedTotal = new client.Counter({
  name: "job_ingested_total",
  help: "Total number of jobs ingested via POST /v1/jobs",
  labelNames: ["service"],
  registers: [register],
});

export const jobsProcessedTotal = new client.Gauge({
  name: "jobs_processed_total",
  help: "Number of jobs processed",
  labelNames: ["service", "status"],
  registers: [register],
});

export const jobDurationSeconds = new client.Histogram({
  name: "job_duration_seconds",
  help: "Execution duration of webhook requests in seconds",
  labelNames: ["service", "domain"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], // Response time buckets
  registers: [register],
});
