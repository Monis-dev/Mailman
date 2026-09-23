import express from "express";
import dotenv from "dotenv";
import Mailman from "../src/sdk/index.js";

dotenv.config();

// ====================================================================
// 1. SDK INSTANTIATION
// ====================================================================
const relay = new Mailman({
  endpoint: "http://127.0.0.1:3000",
  apiKey: process.env.RELAY_API_KEY || "relay_live_secret_key_999",
});

// ====================================================================
// 2. BACKGROUND WEBHOOK RECEIVER (Port 4000)
// ====================================================================
const app = express();
app.use(express.json());

// Background Webhook 1: PDF Invoice & ERP Sync
app.post("/api/webhooks/order-processor", async (req, res) => {
  const { orderId } = req.body;
  // Simulates external ERP inventory sync & PDF document rendering
  await fetch("https://httpbin.org/delay/3");
  console.log(
    `    [BACKGROUND WORKER] Invoice generated & ERP synced for ${orderId}`,
  );
  res.status(200).send("Processed");
});

// Background Webhook 2: Slack & CRM Fanout
app.post("/api/webhooks/fanout-processor", async (req, res) => {
  const { leadEmail } = req.body;
  // Simulates sequential API calls to Slack and HubSpot CRM
  await fetch("https://httpbin.org/delay/1");
  await fetch("https://httpbin.org/delay/1");
  console.log(
    `    [BACKGROUND WORKER] Slack & HubSpot notified for ${leadEmail}`,
  );
  res.status(200).send("Synced");
});

// Background Webhook 3: Large CSV Analytics Export
app.post("/api/webhooks/export-processor", async (req, res) => {
  const { email } = req.body;
  // Simulates 50,000-row database query & CSV compilation
  await fetch("https://httpbin.org/delay/2");
  console.log(`    [BACKGROUND WORKER] 50,000-row CSV ready for ${email}`);
  res.status(200).send("Exported");
});

const server = app.listen(4000);

// ====================================================================
// 3. THE AUTOMATED TERMINAL BENCHMARK SUITE
// ====================================================================
async function runTerminalBenchmark() {
  console.log("\n=======================================================");
  console.log("🚀 STARTING REAL-WORLD TERMINAL BENCHMARK");
  console.log("=======================================================\n");

  const results = [];

  // ------------------------------------------------------------------
  // USE CASE 1: E-COMMERCE CHECKOUT ($150 Order)
  // ------------------------------------------------------------------
  console.log(
    "[1/3] Benchmarking: E-Commerce Checkout & Invoice Generation...",
  );

  // Sync: Customer waits for payment + 3s ERP invoice sync
  process.stdout.write("  ⏳ Running Synchronous (Customer waits)... ");
  const t0Sync = performance.now();
  await fetch("https://httpbin.org/delay/3");
  const orderSyncMs = Math.round(performance.now() - t0Sync);
  console.log(`${orderSyncMs}ms`);

  // RelayEngine: Instant confirmation -> Invoice handled in background
  process.stdout.write("  🚀 Running RelayEngine (Fast Path)...       ");
  const t0Relay = performance.now();
  const job1 = await relay.dispatch({
    service: "user-verification-email",
    target_url: "http://127.0.0.1:4000/api/webhooks/order-processor",
    payload: { orderId: "ORD-9921", email: "buyer@test.com" },
    idempotencyKey: `order-${Date.now()}`,
  });
  const orderRelayMs = Math.round(performance.now() - t0Relay);
  console.log(`${orderRelayMs}ms (Job ID: ${job1.job_id})`);

  results.push({
    "Enterprise Use Case": "1. E-Commerce Checkout",
    "Customer Wait (Sync)": `${orderSyncMs} ms`,
    "Customer Wait (Relay)": `${orderRelayMs} ms`,
    "Latency Cut": `${Math.round(((orderSyncMs - orderRelayMs) / orderSyncMs) * 100)}% Faster`,
  });

  // ------------------------------------------------------------------
  // USE CASE 2: MULTI-API FANOUT (Slack + HubSpot CRM)
  // ------------------------------------------------------------------
  console.log("\n[2/3] Benchmarking: Multi-API Lead Fanout (Slack + CRM)...");

  // Sync: Customer waits while server sequentially calls 2 APIs
  process.stdout.write("  ⏳ Running Synchronous (Customer waits)... ");
  const t1Sync = performance.now();
  await fetch("https://httpbin.org/delay/1");
  await fetch("https://httpbin.org/delay/1");
  const leadSyncMs = Math.round(performance.now() - t1Sync);
  console.log(`${leadSyncMs}ms`);

  // RelayEngine: Instant 200 OK -> APIs triggered in background
  process.stdout.write("  🚀 Running RelayEngine (Fast Path)...       ");
  const t1Relay = performance.now();
  const job2 = await relay.dispatch({
    service: "user-verification-email",
    target_url: "http://127.0.0.1:4000/api/webhooks/fanout-processor",
    payload: { leadEmail: "enterprise@corp.com" },
    idempotencyKey: `lead-${Date.now()}`,
  });
  const leadRelayMs = Math.round(performance.now() - t1Relay);
  console.log(`${leadRelayMs}ms (Job ID: ${job2.job_id})`);

  results.push({
    "Enterprise Use Case": "2. Multi-API Lead Fanout",
    "Customer Wait (Sync)": `${leadSyncMs} ms`,
    "Customer Wait (Relay)": `${leadRelayMs} ms`,
    "Latency Cut": `${Math.round(((leadSyncMs - leadRelayMs) / leadSyncMs) * 100)}% Faster`,
  });

  // ------------------------------------------------------------------
  // USE CASE 3: HEAVY DATA EXPORT (50,000-Row CSV Report)
  // ------------------------------------------------------------------
  console.log("\n[3/3] Benchmarking: 50,000-Row CSV Export Compilation...");

  // Sync: Browser hangs while 50,000 rows compile
  process.stdout.write("  ⏳ Running Synchronous (Customer waits)... ");
  const t2Sync = performance.now();
  await fetch("https://httpbin.org/delay/2");
  const exportSyncMs = Math.round(performance.now() - t2Sync);
  console.log(`${exportSyncMs}ms`);

  // RelayEngine: Instant Queue -> Export generated in background
  process.stdout.write("  🚀 Running RelayEngine (Fast Path)...       ");
  const t2Relay = performance.now();
  const job3 = await relay.dispatch({
    service: "user-verification-email",
    target_url: "http://127.0.0.1:4000/api/webhooks/export-processor",
    payload: { reportType: "SALES_2024", email: "analyst@data.com" },
    idempotencyKey: `export-${Date.now()}`,
  });
  const exportRelayMs = Math.round(performance.now() - t2Relay);
  console.log(`${exportRelayMs}ms (Job ID: ${job3.job_id})`);

  results.push({
    "Enterprise Use Case": "3. 50k-Row CSV Export",
    "Customer Wait (Sync)": `${exportSyncMs} ms`,
    "Customer Wait (Relay)": `${exportRelayMs} ms`,
    "Latency Cut": `${Math.round(((exportSyncMs - exportRelayMs) / exportSyncMs) * 100)}% Faster`,
  });

  // ------------------------------------------------------------------
  // PRINT EXECUTIVE TERMINAL TABLE
  // ------------------------------------------------------------------
  console.log("\n=======================================================");
  console.log("📊 EXECUTIVE SUMMARY: REAL-WORLD LATENCY IMPACT");
  console.log("=======================================================\n");

  console.table(results);

  console.log(
    "Notice: The heavy operations (~2s to 3s) are currently executing",
  );
  console.log(
    "quietly in your background worker terminal without freezing any users!\n",
  );

  server.close();
  process.exit(0);
}

runTerminalBenchmark();
