import "dotenv/config";
import { defineConfig } from "vitest/config";

const testDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? "postgres://veripura:veripura_local_only@localhost:5433/veripura_test";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["./tests/global-setup.ts"],
    setupFiles: ["./tests/setup.ts"],
    // Every test file shares one Postgres database and truncates it between tests,
    // so files must not run in parallel.
    fileParallelism: false,
    // The app code reads DATABASE_URL. Point it at the test database, never the dev one.
    env: { DATABASE_URL: testDatabaseUrl },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
