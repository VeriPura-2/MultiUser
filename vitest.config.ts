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
    // Pin every integration setting so the suite never depends on a developer's local .env.
    env: {
      DATABASE_URL: testDatabaseUrl,
      VERIPURA_CORE_MODE: "stub",
      VERIPURA_CORE_STUB_DELAY_MS: "0",
      VERIPURA_CORE_WEBHOOK_URL: "",
      VERIPURA_CORE_WEBHOOK_SECRET: "test-webhook-secret",
      ALLOW_DEV_ACTOR_HEADER: "false",
    },
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
