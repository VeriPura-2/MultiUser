import { afterAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import { setCoreClient } from "../src/core/client.js";
import { closeDb, getDb } from "../src/db/client.js";
import { InMemoryFileStorage, setFileStorage } from "../src/storage/fileStorage.js";

/**
 * No test may touch the network. The global fetch is replaced with one that refuses, before every
 * test, so code that reaches for it by default (a live core client, a live position provider) fails
 * loudly instead of calling out. A test that needs a network gives the code its own fake fetch.
 * (tests/noNetwork.test.ts proves the guard works.)
 */
const NETWORK_BLOCKED_MESSAGE = "Network access is not allowed in tests";
const blockedFetch = (async () => {
  throw new Error(NETWORK_BLOCKED_MESSAGE);
}) as unknown as typeof fetch;

// Truncate every table in the public schema before each test so tests are independent.
// Discovered dynamically so tables added in later stages are covered without editing this file.
beforeEach(async () => {
  globalThis.fetch = blockedFetch;
  // Fresh in-memory storage and the env-configured (stub) core client for every test.
  setFileStorage(new InMemoryFileStorage());
  setCoreClient(undefined);

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
