import "dotenv/config";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Db = NodePgDatabase<typeof schema>;
/** A transaction handle. Structurally interchangeable with Db for queries and inserts. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** Anything you can run queries on: the root client or an open transaction. */
export type DbExecutor = Db | Tx;

let pool: pg.Pool | undefined;
let db: Db | undefined;

/**
 * Lazily creates the shared client from DATABASE_URL. Lazy so that importing a module never
 * opens a connection, and so tests can point DATABASE_URL at the test database first.
 */
export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env (see README).");
    }
    pool = new pg.Pool({ connectionString: url });
    db = drizzle(pool, { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
    db = undefined;
  }
}
