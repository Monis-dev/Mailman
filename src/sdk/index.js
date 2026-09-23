import crypto from "node:crypto";
class Mailman {
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
  async #request(path, options) {
    const url = `${this.endpoint}${path}`;
    const headers = {
      ...(options.headers || {}),
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
    for (let i = 0; i < this.maxRetries; i++) {
      const delayInMs = 200 * (i + 1);
      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: headers,
          body: options.body,
          signal: AbortSignal.timeout(this.timeout),
        });
        if (response.ok) {
          return await response.json();
        }
        if (response.status >= 400 && response.status < 500) {
          const errText = await response.text().catch(() => "");
          throw new Error(`Client Error (${response.status}): ${errText}`);
        }
        await new Promise((resolve) => setTimeout(resolve, delayInMs));
      } catch (error) {
        if (
          error.message.startsWith("Client Error") ||
          i === this.maxRetries - 1
        ) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delayInMs));
      }
    }
  }

  static verifySignature({
    payload,
    signatureHeader,
    secret,
    toleranceInSeconds = 300,
  }) {
    if (!signatureHeader || !secret) return false;
    const part = Object.fromEntries(
      signatureHeader.split(",").map((part) => part.split("=")),
    );
    const t = part.t;
    const v1 = part.v1;
    if (!t || !v1) return false;
    const timePassed = Date.now() - t;
    if (timePassed > toleranceInSeconds * 1000) return false;
    const clientSignature = crypto
      .createHmac("sha256", secret)
      .update(`${t}.${payload}`)
      .digest("hex");
    const bufRecevied = Buffer.from(v1, "hex");
    const bufExpected = Buffer.from(clientSignature, "hex");
    if (bufRecevied.length !== bufExpected.length) return false;
    return crypto.timingSafeEqual(bufRecevied, bufExpected);
  }

  static createReceiverMiddleware({ secret, store = new Set() } = {}) {
    return (req, res, next) => {
      const signatureHeader = req.headers["x-relay-signature"];
      const idempKey = req.headers["x-idempotency-key"];
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

  async getJobStatus(jobId) {
    const response = this.#request(`/v1/jobs/${jobId}`, {
      method: "GET",
    });
    return response;
  }

  async replay(jobId) {
    const status = this.#request(`/v1/jobs/${jobId}/replay`, {
      method: "POST",
    });
    return status;
  }
}

export default Mailman;
