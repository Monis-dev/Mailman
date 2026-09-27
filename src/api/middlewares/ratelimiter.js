import redis from "../../config/redis.js";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATE_LIMIT_SCRIPT = fs.readFileSync(
  path.join(__dirname, "..", "..", "utils", "rate_limit.lua"),
  "utf-8",
);

async function rateLimiter(req, res, next) {
  try {
    const clientIp = req.ip;
    const key = `ratelimit:${clientIp}`;
    const now = Date.now();
    const windowStart = now - 10000;
    const limit = Number(process.env.RATE_LIMIT_MAX) || 10;
    const member = `${now}-${Math.random()}`;

    const allowed = await redis.eval(
      RATE_LIMIT_SCRIPT,
      1,
      key,
      now,
      windowStart,
      limit,
      member,
    );

    if (allowed === 0) {
      console.log("Client has used up there quota!");
      res.setHeader("Retry-After", 10);
      return res.status(429).json({ error: "Too many Request. Chill Bro!" });
    }
    next();
  } catch (error) {
    console.log("Unable to make connection with client");
    next(); // fail open, same as before
  }
}

export default rateLimiter;
