import "dotenv/config";
import { buildApp } from "./http/app.js";
import type { Logger } from "./tracking/provider.js";
import { createTrackingRuntime, startTrackingScheduler } from "./tracking/runtime.js";

// Local sandbox server. Binds to loopback only; nothing here is meant to be exposed.
const port = Number(process.env.PORT ?? 3100);

// The tracking runtime logs through the app's logger, which does not exist until the app does.
let appLog: Pick<Logger, "info" | "warn" | "error"> = console;
const log: Logger = { info: (m) => appLog.info(m), warn: (m) => appLog.warn(m), error: (m) => appLog.error(m) };

// Throws, and so the server does not start, if a live provider is configured without AIS_LIVE_ALLOWED=true.
const tracking = createTrackingRuntime(process.env, { log });
const app = buildApp({ logger: true, tracking });
appLog = app.log;

app
  .listen({ port, host: "127.0.0.1" })
  .then(() => {
    app.log.info(`tracking: provider ${tracking.config.provider}, scheduled refresh ${tracking.config.refreshEnabled ? "on" : "off"}`);
    startTrackingScheduler(tracking);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
