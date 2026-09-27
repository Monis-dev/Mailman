// Prometheus metrics configuration for tracking job throughput, execution times, and node health.

import client from "prom-client";

const register = new client.Registry();

// Automatically collect Node.js process metrics (memory usage, CPU, event loop lag)
client.collectDefaultMetrics({ register });

export { register };

// Counter: tracks the total count of new jobs submitted via the API
export const jobsIngestedTotal = new client.Counter({
  name: "job_ingested_total",
  help: "Total number of jobs ingested via POST /v1/jobs",
  labelNames: ["service"],
  registers: [register],
});

// Gauge: tracks the number of processed jobs broken down by service and final status
export const jobsProcessedTotal = new client.Gauge({
  name: "jobs_processed_total",
  help: "Number of jobs processed",
  labelNames: ["service", "status"],
  registers: [register],
});

// Histogram: tracks how long webhook requests take to execute across predefined time buckets
export const jobDurationSeconds = new client.Histogram({
  name: "job_duration_seconds",
  help: "Execution duration of webhook requests in seconds",
  labelNames: ["service", "domain"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], // Response time buckets
  registers: [register],
});
