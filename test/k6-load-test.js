import http from "k6/http";
import { check, sleep } from "k6";

// ====================================================================
// 1. HARD SLO THRESHOLDS (Fails CI if performance degrades)
// ====================================================================
export const options = {
  vus: 50, // 50 concurrent virtual users
  duration: "30s", // Sustained blast for 30 seconds
  thresholds: {
    // 95% of requests must complete in under 75ms:
    http_req_duration: ["p(95)<75", "p(99)<120"],
    // Error rate must be strictly less than 1%:
    http_req_failed: ["rate<0.01"],
  },
};

const BASE_URL = __ENV.TARGET_URL || "http://127.0.0.1:3000/v1/jobs";
const API_KEY = __ENV.RELAY_API_KEY || "mail_man_secret_key_0909";

export default function () {
  // Generate unique keys per VU and iteration
  const uniqueKey = `k6-${__VU}-${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    service: "k6-load-benchmark",
    target_url: "https://httpbin.org/post",
    payload: { vu: __VU, iter: __ITER, timestamp: Date.now() },
  });

  const params = {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "Idempotency-Key": uniqueKey,
    },
  };

  const res = http.post(BASE_URL, payload, params);
  if (__ITER === 0)
    console.log(`[k6 DEBUG] Status: ${res.status} | Body: ${res.body}`);

  // Assertions: Must return 202 Accepted with a valid job_id
  check(res, {
    "status is 202": (r) => r.status === 202,
    "has job_id": (r) => JSON.parse(r.body).job_id !== undefined,
  });

  // Short pacing delay between requests per virtual user
  sleep(0.05);
}
