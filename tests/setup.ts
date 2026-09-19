import { afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb } from "../src/db/client.js";

// Truncate every table in the public schema before each test so tests are independent.
// Discovered dynamically so tables added in later stages are covered without editing this file.
beforeEach(async () => {
  const db = getDb();
  const result = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const tables = result.rows.map((r) => `"public"."${r.tablename}"`);
  if (tables.length > 0) {
    await db.execute(sql.raw(`TRUNCATE ${tables.join(", ")} RESTART IDENTITY CASCADE`));
  }
});

afterAll(async () => {
  await closeDb();
});
