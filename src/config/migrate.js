import pg from "pg";
import { readFile } from "node:fs/promises";
import dotenv from "dotenv";

dotenv.config();

const pool = new pg.Pool({
  host: process.env.HOST || "localhost",
  port: Number(process.env.PORT) || 5432,
  user: process.env.USER || "postgres",
  password: String(process.env.PASSWORD || "postgres"),
  database: process.env.DATABASE || "relayengine",
});
const sql = await readFile("schema.sql", "utf-8");

await pool.query(sql);

pool.end();
