// Mailman SDK: Client library to dispatch jobs, check status, replay failures, and verify webhook signatures.

import crypto from "node:crypto";

class Mailman {
  // Initialize the client with server URL, API key, retry limits, and request timeout
  constructor({
    endpoint = "http://localhost:3000",
    apiKey = "",
    maxRetries = 3,
    timeout = 5000,
  } = {}) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
    this.maxRetries = maxRetries;
    this.timeout = timeout;
  }

  // Private helper method that makes HTTP requests with automatic retries and backoff
  async #request(path, options) {
    const url = `${this.endpoint}${path}`;

    const headers = {
      ...(options.headers || {}),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };

    let lastError;

    for (let i = 0; i < this.maxRetries; i++) {
      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: headers,
          body: options.body,
          signal: AbortSignal.timeout(this.timeout),
        });

        if (response.ok) {
          return await response.json(); // <-- the missing piece: success now actually returns
        }

        const errorText = await response.text().catch(() => "");

        // 4xx is never retryable — a bad request or a genuine 409 conflict
        // will never succeed by trying again with the same payload/key.
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`Client Error (${response.status}): ${errorText}`);
        }

        // 5xx is retryable — fall through to the retry delay below.
        lastError = new Error(
          `Server Error (${response.status}): ${errorText}`,
        );
      } catch (error) {
        // AbortSignal timeouts and network failures land here too.
        if (error.message.startsWith("Client Error")) {
          throw error; // never retry 4xx
        }
        lastError = error;
      }

      if (i < this.maxRetries - 1) {
        const delayInMs = 200 * (i + 1);
        await new Promise((resolve) => setTimeout(resolve, delayInMs));
      }
    }

    throw new Error(
      `RelayEngine request failed after ${this.maxRetries} attempts: ${lastError.message}`,
    );
  }

  // Verify that an incoming webhook was sent by Mailman and has not been tampered with
  static verifySignature({
    payload,
    signatureHeader,
    secret,
    toleranceInSeconds = 300,
  }) {
    if (!signatureHeader || !secret) return false;

    // Parse the header string into key-value pairs (e.g., t=timestamp, v1=signature)
    const part = Object.fromEntries(
      signatureHeader.split(",").map((part) => part.split("=")),
    );
    const t = part.t;
    const v1 = part.v1;
    if (!t || !v1) return false;

    // Reject timestamps older than the allowed tolerance (default: 5 mins) to prevent replay attacks
    const timePassed = Date.now() - t;
    if (timePassed > toleranceInSeconds * 1000) return false;

    // Recompute the HMAC SHA-256 hash using the secret, timestamp, and raw payload
    const clientSignature = crypto
      .createHmac("sha256", secret)
      .update(`${t}.${payload}`)
      .digest("hex");
    const bufRecevied = Buffer.from(v1, "hex");
    const bufExpected = Buffer.from(clientSignature, "hex");
    if (bufRecevied.length !== bufExpected.length) return false;

    // Compare signatures using a constant-time comparison to prevent timing attacks
    return crypto.timingSafeEqual(bufRecevied, bufExpected);
  }

  // Express middleware for consumers to verify incoming webhooks and deduplicate retries
  static createReceiverMiddleware({ secret, store = new Set() } = {}) {
    return (req, res, next) => {
      const signatureHeader = req.headers["x-relay-signature"];
      const idempKey = req.headers["x-idempotency-key"];

      // Validate the webhook signature before processing
      if (secret) {
        const response = this.verifySignature({
          payload: JSON.stringify(req.body),
          signatureHeader,
          secret,
        });
        if (!response) {
          return res.status(401).json({ error: "Invalid webhook signature" });
        }
      }

      // Deduplicate requests: ignore if this idempotency key was already handled
      if (idempKey && store.has(idempKey)) {
        console.log("Job already executed on previous attempt!");
        return res
          .status(200)
          .json({ status: "already_processed", deduped: true });
      }

      store.add(idempKey);
      return next();
    };
  }

  // Send a new job to the queue; automatically creates an idempotency key if none is provided
  async dispatch({ service, target_url, payload, idempotencyKey }) {
    const key = idempotencyKey || crypto.randomUUID();

    return this.#request("/v1/jobs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ service, target_url, payload }),
    });
  }

  // Look up the current status and execution history of a specific job
  async getJobStatus(jobId) {
    const response = this.#request(`/v1/jobs/${jobId}`, {
      method: "GET",
    });
    return response;
  }

  // Request a failed dead-letter job to be re-queued and retried
  async replay(jobId) {
    const status = this.#request(`/v1/jobs/${jobId}/replay`, {
      method: "POST",
    });
    return status;
  }
}

export default Mailman;
