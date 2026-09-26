import pg from 'pg'
import dotenv from "dotenv";

dotenv.config();

const pool = new pg.Pool({
  max: 50,
  idleTimeoutMillis: 30000,
  host: process.env.DB_HOST || process.env.HOST || "localhost",
  port: Number(process.env.DB_PORT) || 5432,
  user: process.env.DB_USER || process.env.USER || "postgres",
  password: String(
    process.env.DB_PASSWORD || process.env.PASSWORD || "postgres",
  ),
  database: process.env.DB_NAME || process.env.DATABASE || "relayengine",
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

export default pool;