import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The backend serves routes such as /me and /consignments with no prefix. The app calls them under
// /api, and in development this proxy strips that prefix and forwards to the local backend.
const apiTarget = process.env.API_TARGET ?? "http://127.0.0.1:3100";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: apiTarget,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // The suite includes a real production build, which takes a while.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
