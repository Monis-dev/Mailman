import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST || "127.0.0.1",
  port: Number(process.env.REDIS_PORT) || 6379,
  maxRetriesPerRequest: null,
});

redis.on("connect", () => console.log("Connect to Redis"));
redis.on("error", (err) => console.log("Redis Client Error: ", err));

export default redis;
