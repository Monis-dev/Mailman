import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "./db.js"; 

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sql = await readFile(path.join(__dirname, "schema.sql"), "utf-8");

console.log("[MIGRATE] Applying schema.sql to PostgreSQL...");
await pool.query(sql);
console.log("[MIGRATE] Schema applied successfully!");

await pool.end();
