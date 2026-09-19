import "dotenv/config";
import pg from "pg";
import { runMigrations } from "../src/db/migrate.js";

const DEFAULT_URL = "postgres://veripura:veripura_local_only@localhost:5433/veripura_test";

/** Creates the test database if it does not exist, then applies all migrations to it. */
export default async function globalSetup(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
  const parsed = new URL(testUrl);
  const dbName = decodeURIComponent(parsed.pathname.slice(1));

  // The suite truncates every table between tests. Refuse to run against anything that
  // does not look like a throwaway test database.
  if (!/_test$/.test(dbName)) {
    throw new Error(`Refusing to run tests: TEST_DATABASE_URL database "${dbName}" must end in "_test".`);
  }

  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Cannot reach Postgres for the test suite. Is the sandbox up? Run "npm run db:up". (${(err as Error).message})`,
    );
  }
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      // Identifiers cannot be parameterized. dbName is constrained to /_test$/ above and quoted here.
      await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }

  await runMigrations(testUrl);
}
