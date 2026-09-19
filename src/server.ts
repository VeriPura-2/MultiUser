import "dotenv/config";
import { buildApp } from "./http/app.js";

// Local sandbox server. Binds to loopback only; nothing here is meant to be exposed.
const port = Number(process.env.PORT ?? 3100);
const app = buildApp({ logger: true });

app.listen({ port, host: "127.0.0.1" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
