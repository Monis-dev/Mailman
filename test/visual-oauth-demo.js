import express from "express";
import nodemailer from "nodemailer";
import fs from "node:fs";
import Mailman from "../src/sdk/index.js";

const app = express();
app.use(express.json());

// Initialize RelayEngine SDK
const relay = new Mailman({ endpoint: "http://localhost:3000" });

// ====================================================================
// CONFIGURATION (ADD YOUR CREDENTIALS HERE)
// ====================================================================


// Creates a real, automated test SMTP inbox with zero credentials needed:
const testAccount = await nodemailer.createTestAccount();

const mailTransporter = nodemailer.createTransport({
  host: "smtp.ethereal.email",
  port: 587,
  secure: false,
  auth: {
    user: testAccount.user,
    pass: testAccount.pass,
  },
});
console.log("[SMTP READY] Connected to Ethereal SMTP test server!");

// ====================================================================
// HIGH-PRECISION NETWORK LOGGER UTILITY
// ====================================================================
const LOG_FILE = "network-audit.log";

function logNetworkEvent(flowId, phase, durationMs, details = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    flow_id: flowId,
    phase,
    duration_ms: Math.round(durationMs),
    ...details,
  };

  // 1. Log cleanly to Terminal
  console.log(
    `[NET-AUDIT] [${flowId}] ${phase.padEnd(28)} | ${String(Math.round(durationMs) + "ms").padStart(8)} |`,
    JSON.stringify(details),
  );

  // 2. Append to real-time log file: network-audit.log
  fs.appendFileSync(LOG_FILE, JSON.stringify(logEntry) + "\n");
}

// Helper: Real SMTP email delivery with network timing
async function sendRealVerificationEmail(toEmail, userName, flowId) {
  const smtpStart = performance.now();
  console.log(
    `[SMTP START] Initiating TLS handshake with Gmail SMTP for ${toEmail}...`,
  );

  const otpCode = Math.floor(100000 + Math.random() * 900000);

  const info = await mailTransporter.sendMail({
    from: `"Kontexa Security" <${process.env.EMAIL_USER || "auth@kontexa.com"}>`,
    to: toEmail,
    subject: "Kontexa: Real OTP Verification Code",
    html: `
      <h2>Hello ${userName},</h2>
      <p>Your Kontexa verification code is:</p>
      <h1 style="color: #3b82f6; letter-spacing: 4px;">${otpCode}</h1>
      <p>This was sent to verify your login latency.</p>
    `,
  });

  const smtpDuration = performance.now() - smtpStart;
  logNetworkEvent(flowId, "SMTP_SEND_EMAIL", smtpDuration, {
    to: toEmail,
    message_id: info.messageId,
    response: info.response,
  });

  return { info, duration: smtpDuration };
}

// ====================================================================
// 1. LANDING PAGE
// ====================================================================
app.get("/", (req, res) => {
  const googleAuthUrl = (mode) => {
    const rootUrl = "https://accounts.google.com/o/oauth2/v2/auth";
    const options = new URLSearchParams({
      redirect_uri: GOOGLE_REDIRECT_URI,
      client_id: GOOGLE_CLIENT_ID,
      access_type: "offline",
      response_type: "code",
      prompt: "consent",
      scope:
        "https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/userinfo.email",
      state: mode,
    });
    return `${rootUrl}?${options.toString()}`;
  };

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Real-Time Network Latency Benchmark</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
        .card { background: #1e293b; padding: 40px; border-radius: 12px; width: 540px; text-align: center; border: 1px solid #334155; }
        .btn { display: block; padding: 14px; margin: 15px 0; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px; }
        .btn-slow { background: #ef4444; color: white; }
        .btn-fast { background: #10b981; color: white; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>Real-Time Network Audit</h2>
        <p style="color: #94a3b8; font-size: 14px;">Every network packet will be logged with microsecond precision to <code>network-audit.log</code>.</p>
        
        <a href="${googleAuthUrl("slow")}" class="btn btn-slow">
          🔴 Login (Sync: Google API + SMTP Blocks Browser)
        </a>

        <a href="${googleAuthUrl("fast")}" class="btn btn-fast">
          🟢 Login (RelayEngine: Instant Redirect + Background SMTP)
        </a>
      </div>
    </body>
    </html>
  `);
});

// ====================================================================
// 2. THE OAUTH CALLBACK WITH GRANULAR NETWORK TIMING
// ====================================================================
app.get("/auth/google/callback", async (req, res) => {
  const { code, state: mode } = req.query;
  const flowId = `${mode.toUpperCase()}-${Date.now().toString().slice(-4)}`;
  const overallStart = performance.now();

  console.log(`\n======================================================`);
  console.log(`[FLOW START] ${flowId} | User arrived from Google`);
  console.log(`======================================================`);

  try {
    // ----------------------------------------------------------------
    // HOP 1: Exchange Auth Code for Tokens with Google API
    // ----------------------------------------------------------------
    const t0 = performance.now();
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokens = await tokenResponse.json();
    const tokenDuration = performance.now() - t0;
    logNetworkEvent(flowId, "GOOGLE_TOKEN_EXCHANGE", tokenDuration, {
      status: tokenResponse.status,
    });

    // ----------------------------------------------------------------
    // HOP 2: Fetch User Profile from Google API
    // ----------------------------------------------------------------
    const t1 = performance.now();
    const profileResponse = await fetch(
      "https://www.googleapis.com/oauth2/v2/userinfo",
      {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    );
    const googleUser = await profileResponse.json();
    const profileDuration = performance.now() - t1;
    logNetworkEvent(flowId, "GOOGLE_USERINFO_FETCH", profileDuration, {
      email: googleUser.email,
    });

    // ================================================================
    // THE FORK IN THE ROAD
    // ================================================================

    if (mode === "slow") {
      // -------------------------------------------------------------
      // THE SLOW WAY: Browser waits for SMTP before redirecting
      // -------------------------------------------------------------
      const emailResult = await sendRealVerificationEmail(
        googleUser.email,
        googleUser.name,
        flowId,
      );

      const totalDuration = performance.now() - overallStart;
      logNetworkEvent(flowId, "BROWSER_REDIRECT_SENT", totalDuration, {
        mode: "slow_synchronous",
        user_waited_ms: Math.round(totalDuration),
      });

      return res.redirect(
        `/dashboard?mode=slow&duration=${Math.round(totalDuration)}&googleTime=${Math.round(tokenDuration + profileDuration)}&smtpTime=${Math.round(emailResult.duration)}&email=${encodeURIComponent(googleUser.email)}`,
      );
    } else {
      // -------------------------------------------------------------
      // THE FAST WAY: RelayEngine offloads SMTP in 15ms
      // -------------------------------------------------------------
      const tRelay = performance.now();
      const job = await relay.dispatch({
        service: "user-verification-email",
        target_url: "http://localhost:4000/api/webhooks/send-email",
        payload: { email: googleUser.email, name: googleUser.name, flowId },
        idempotencyKey: `email-verify-${googleUser.id}-${Date.now()}`,
      });
      const relayDuration = performance.now() - tRelay;
      logNetworkEvent(flowId, "RELAYENGINE_DISPATCH", relayDuration, {
        job_id: job.job_id,
      });

      const totalDuration = performance.now() - overallStart;
      logNetworkEvent(flowId, "BROWSER_REDIRECT_SENT", totalDuration, {
        mode: "relayengine_fastpath",
        user_waited_ms: Math.round(totalDuration),
      });

      return res.redirect(
        `/dashboard?mode=fast&duration=${Math.round(totalDuration)}&googleTime=${Math.round(tokenDuration + profileDuration)}&relayTime=${Math.round(relayDuration)}&email=${encodeURIComponent(googleUser.email)}`,
      );
    }
  } catch (err) {
    console.error(`[ERROR] [${flowId}]`, err.message);
    logNetworkEvent(flowId, "OAUTH_FAILED", 0, { error: err.message });
    res.status(500).send("Login failed: " + err.message);
  }
});

// ====================================================================
// 3. BACKGROUND WEBHOOK (Executed by RelayEngine Worker)
// ====================================================================
app.post("/api/webhooks/send-email", async (req, res) => {
  const { email, name, flowId } = req.body;
  console.log(
    `\n[BACKGROUND WORKER] RelayEngine triggered SMTP email for flow: ${flowId}`,
  );

  try {
    const result = await sendRealVerificationEmail(email, name, flowId + "-BG");
    res.status(200).send("Delivered");
  } catch (err) {
    console.error("[BACKGROUND WORKER] SMTP delivery failed:", err.message);
    res.status(500).send(err.message);
  }
});

// ====================================================================
// 4. THE DASHBOARD (Renders Network Waterfall Table)
// ====================================================================
app.get("/dashboard", (req, res) => {
  const { mode, duration, googleTime, smtpTime, relayTime, email } = req.query;
  const isFast = mode === "fast";

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Kontexa Network Audit Dashboard</title>
      <style>
        body { font-family: -apple-system, sans-serif; background: #0f172a; color: white; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: #1e293b; padding: 35px; border-radius: 12px; width: 620px; border: 1px solid #334155; }
        .badge { display: inline-block; padding: 6px 12px; border-radius: 20px; font-weight: bold; font-size: 13px; margin-bottom: 12px; }
        .badge-slow { background: #ef4444; color: white; }
        .badge-fast { background: #10b981; color: white; }
        table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; text-align: left; }
        th, td { padding: 12px; border-bottom: 1px solid #334155; }
        th { color: #94a3b8; font-size: 12px; text-transform: uppercase; }
        .bar { height: 8px; border-radius: 4px; }
        .bar-google { background: #38bdf8; }
        .bar-smtp { background: #ef4444; }
        .bar-relay { background: #10b981; }
        .time-box { font-size: 40px; font-family: monospace; font-weight: bold; color: #f59e0b; margin: 10px 0 20px 0; }
        a { color: #38bdf8; text-decoration: none; font-size: 14px; }
      </style>
    </head>
    <body>
      <div class="card">
        <span class="badge ${isFast ? "badge-fast" : "badge-slow"}">
          ${isFast ? "⚡ RELAYENGINE OPTIMIZED" : "❌ SLOW SYNCHRONOUS BLOCKING"}
        </span>
        <h2 style="margin: 0 0 5px 0;">Network Latency Audit</h2>
        <p style="color: #94a3b8; font-size: 14px; margin: 0;">User: <b>${email}</b></p>
        
        <p style="color: #94a3b8; font-size: 13px; margin-top: 15px;">TOTAL TIME BROWSER WAS FROZEN WAITING:</p>
        <div class="time-box">${(Number(duration) / 1000).toFixed(2)}s (${duration}ms)</div>

        <table>
          <thead>
            <tr>
              <th>Network Phase</th>
              <th>Time</th>
              <th>Impact on Customer</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Google Token & Profile Fetch</td>
              <td><b>${googleTime}ms</b></td>
              <td><div class="bar bar-google" style="width: 100%;"></div></td>
            </tr>
            ${
              !isFast
                ? `
            <tr>
              <td>Real SMTP TLS & Send Email</td>
              <td><b style="color: #ef4444;">${smtpTime}ms</b></td>
              <td><div class="bar bar-smtp" style="width: 100%;"></div></td>
            </tr>
            `
                : `
            <tr>
              <td>RelayEngine Async Dispatch</td>
              <td><b style="color: #10b981;">${relayTime}ms</b></td>
              <td><div class="bar bar-relay" style="width: 20%;"></div></td>
            </tr>
            `
            }
          </tbody>
        </table>

        <p style="color: #94a3b8; font-size: 13px; line-height: 1.5;">
          ${
            isFast
              ? "<b>Why it was fast:</b> The real SMTP email was handed to RelayEngine in just " +
                relayTime +
                "ms. Your browser jumped to the dashboard immediately, and the email was delivered in the background!"
              : "<b>Why it was slow:</b> Your browser was forced to sit waiting for " +
                smtpTime +
                "ms while Node.js negotiated TLS with the Gmail mail servers before redirecting!"
          }
        </p>

        <p style="font-size: 12px; color: #64748b;">Every packet logged to: <code>network-audit.log</code></p>
        <hr style="border: none; border-top: 1px solid #334155; margin: 20px 0;">
        <a href="/">← Run the other test to compare logs</a>
      </div>
    </body>
    </html>
  `);
});

app.listen(4000, () => {
  console.log("\n=======================================================");
  console.log("Real OAuth & Email App running at: http://localhost:4000");
  console.log("Audit log will be written to: network-audit.log");
  console.log("=======================================================\n");
});
