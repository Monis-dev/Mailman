import Redis from "ioredis";
import pg from "pg";

const redis = new Redis();
const pool = new pg.Pool({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "postgres",
  database: "relayengine",
});

try {
  const result = await redis.ping();
  const result_pg = await pool.query("SELECT NOW()");
  console.log(result_pg);
  console.log(result);
} catch (error) {
  console.log(error);
}

redis.quit();
pool.end();
