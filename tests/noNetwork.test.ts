import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { provider_calls } from "../src/db/schema.js";
import { createTrackingRuntime } from "../src/tracking/runtime.js";
import { FAKE_KEY } from "./trackingHelpers.js";

describe("no test may touch the network", () => {
  it("the global fetch refuses, so nothing can call out by accident", async () => {
    await expect(fetch("https://api.vesselapi.com/v1/vessels/positions")).rejects.toThrow(/Network access is not allowed in tests/);
  });

  it("a live position provider built with no fake network of its own cannot reach one: its one call fails as a network error and is still counted", async () => {
    const runtime = createTrackingRuntime({ AIS_PROVIDER: "vesselapi", AIS_LIVE_ALLOWED: "true", VESSELAPI_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    const error = await runtime.provider.fetchPositions([{ mmsi: "111111111" }], { purpose: "test" }).catch((e) => e);
    expect(error).toMatchObject({ name: "ProviderError", status: "network_error" });
    expect(String(error.message)).not.toContain(FAKE_KEY);
    expect((await getDb().select().from(provider_calls)).map((c) => c.status)).toEqual(["network_error"]);
  });
});
