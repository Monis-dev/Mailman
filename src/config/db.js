import pg from 'pg'
import dotenv from "dotenv";

dotenv.config();

const pool = new pg.Pool({
  host: process.env.HOST || "localhost",
  port: Number(process.env.PORT) || 5432,
  user: process.env.USER || "postgres",
  password: String(process.env.PASSWORD || "postgres"),
  database: process.env.DATABASE || "relayengine",
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
  process.exit(-1);
});

export default pool;