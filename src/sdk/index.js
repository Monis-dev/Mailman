import crypto from "node:crypto";
import Authorize from "../api/middlewares/auth";
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
      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: headers,
          body: options.body,
          signal: AbortSignal.timeout(this.timeout),
        });
        if (response.status === 503) {
          delayInMs = 200 * (i + 1);
        }
        if (response.ok) {
          return response.json();
        }
        if (i === this.maxRetries - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, delayInMs));
      } catch (error) {
        throw new Error(
          "RelayEngine request failed after " + this.maxRetries + " attempts",
        );
      }
    }
  }

  static verifySignature({
    payload,
    signatureHeader,
    secret,
    toleranceInSeconds = 300,
  }) {
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
