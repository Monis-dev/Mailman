import redis from "../../config/redis.js";

async function rateLimiter(req, res, next) {
  try {
    const clientIp = req.ip;
    const key = `ratelimit:${clientIp}`;
    const now = Date.now();
    const windowStart = now - 10000;
    await redis.zremrangebyscore(key, 0, windowStart); // Removes all elements in the sorted set stored at key with a score between min and max (inclusive).
    const requestCount = await redis.zcard(key); //Returns the sorted set cardinality (number of elements) of the sorted set stored at key.
    if (requestCount >= 10) {
      console.log("Client has used up there quota!");
      res.setHeader("Retry-After", 10);
      return res.status(429).json({ error: "Too many Request. Chill Bro!" });
    }
    await redis.zadd(key, now, `${now}-${Math.random()}`);
    await redis.expire(key, 10);
    next();
  } catch (error) {
    console.log("Unable to make connection with client");
    res.status(400).json({ error: "Unable to make connection with client" });
  }
}

export default rateLimiter;
