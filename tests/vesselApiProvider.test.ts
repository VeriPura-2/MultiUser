import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { provider_calls } from "../src/db/schema.js";
import { LiveProviderNotAllowedError, TrackingConfigError, loadTrackingConfig, redact } from "../src/tracking/config.js";
import { ProviderError } from "../src/tracking/provider.js";
import { createSampleRuntime, createTrackingRuntime } from "../src/tracking/runtime.js";
import { SampleProvider } from "../src/tracking/sampleProvider.js";
import { VesselApiProvider } from "../src/tracking/vesselApiProvider.js";
import { FAKE_KEY, apiPosition, jsonResponse, liveRuntime } from "./trackingHelpers.js";

const NOW = new Date("2026-09-10T12:00:00Z");
const ctx = { purpose: "test", now: NOW };
const calls = () => getDb().select().from(provider_calls);
const vesselApi = (runtime: ReturnType<typeof liveRuntime>) => runtime.provider as VesselApiProvider;

describe("start-up guard", () => {
  it("defaults to the sample provider, with live data off", () => {
    const config = loadTrackingConfig({} as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ provider: "sample", liveAllowed: false, monthlyBudget: 150, reserve: 15 });
    expect(createTrackingRuntime({} as NodeJS.ProcessEnv).provider).toBeInstanceOf(SampleProvider);
    expect(createSampleRuntime().provider).toBeInstanceOf(SampleProvider);
  });

  it("refuses to start a live provider unless AIS_LIVE_ALLOWED is exactly true", () => {
    for (const allowed of [undefined, "", "false", "no", "TRUE1"]) {
      const env = { AIS_PROVIDER: "vesselapi", VESSELAPI_KEY: FAKE_KEY, ...(allowed === undefined ? {} : { AIS_LIVE_ALLOWED: allowed }) } as NodeJS.ProcessEnv;
      expect(() => createTrackingRuntime(env), String(allowed)).toThrow(allowed === "no" || allowed === "TRUE1" ? TrackingConfigError : LiveProviderNotAllowedError);
    }
    expect(() => createTrackingRuntime({ AIS_PROVIDER: "vesselapi", VESSELAPI_KEY: FAKE_KEY } as NodeJS.ProcessEnv)).toThrow(/AIS_LIVE_ALLOWED/);
  });

  it("starts a live provider once it is allowed, and needs a key even then", () => {
    const live = createTrackingRuntime({ AIS_PROVIDER: "vesselapi", AIS_LIVE_ALLOWED: "true", VESSELAPI_KEY: FAKE_KEY } as NodeJS.ProcessEnv);
    expect(live.provider).toBeInstanceOf(VesselApiProvider);
    expect(live.provider.live).toBe(true);
    expect(() => createTrackingRuntime({ AIS_PROVIDER: "vesselapi", AIS_LIVE_ALLOWED: "true" } as NodeJS.ProcessEnv)).toThrow(/VESSELAPI_KEY/);
    expect(() => createTrackingRuntime({ AIS_PROVIDER: "vesselapi", AIS_LIVE_ALLOWED: "true", VESSELAPI_KEY: "  " } as NodeJS.ProcessEnv)).toThrow(/VESSELAPI_KEY/);
  });

  it("does not let an allowed flag turn a sample provider live", () => {
    expect(createTrackingRuntime({ AIS_PROVIDER: "sample", AIS_LIVE_ALLOWED: "true" } as NodeJS.ProcessEnv).provider.live).toBe(false);
  });

  it("refuses an unknown provider and sensible-looking but wrong numbers", () => {
    expect(() => loadTrackingConfig({ AIS_PROVIDER: "aisstream" } as NodeJS.ProcessEnv)).toThrow(/AIS_PROVIDER/);
    expect(() => loadTrackingConfig({ VESSELAPI_MONTHLY_BUDGET: "0" } as NodeJS.ProcessEnv)).toThrow(/VESSELAPI_MONTHLY_BUDGET/);
    expect(() => loadTrackingConfig({ VESSELAPI_MONTHLY_BUDGET: "abc" } as NodeJS.ProcessEnv)).toThrow(TrackingConfigError);
    expect(() => loadTrackingConfig({ VESSELAPI_MONTHLY_BUDGET: "10", VESSELAPI_RESERVE: "10" } as NodeJS.ProcessEnv)).toThrow(/RESERVE/);
    expect(() => loadTrackingConfig({ VESSELAPI_BATCH_SIZE: "51" } as NodeJS.ProcessEnv)).toThrow(/BATCH_SIZE/);
    expect(() => loadTrackingConfig({ VESSELAPI_LOOKUP: "many" } as NodeJS.ProcessEnv)).toThrow(/LOOKUP/);
  });

  it("never lets the refresh interval be shorter than its floor", () => {
    expect(loadTrackingConfig({ TRACKING_REFRESH_INTERVAL_MINUTES: "5", TRACKING_REFRESH_MIN_INTERVAL_MINUTES: "60" } as NodeJS.ProcessEnv).refreshIntervalMinutes).toBe(60);
    expect(loadTrackingConfig({ TRACKING_REFRESH_INTERVAL_MINUTES: "240", TRACKING_REFRESH_MIN_INTERVAL_MINUTES: "60" } as NodeJS.ProcessEnv).refreshIntervalMinutes).toBe(240);
    expect(loadTrackingConfig({} as NodeJS.ProcessEnv).refreshIntervalMinutes).toBe(720);
  });

  it("reads the budget, reserve, base URL and freshness threshold from the environment", () => {
    const config = loadTrackingConfig({ VESSELAPI_MONTHLY_BUDGET: "1500", VESSELAPI_RESERVE: "100", VESSELAPI_BASE_URL: "https://example.test/v1/", TRACKING_RECENT_MAX_AGE_SECONDS: "600" } as NodeJS.ProcessEnv);
    expect(config).toMatchObject({ monthlyBudget: 1500, reserve: 100, vesselApiBaseUrl: "https://example.test/v1", recentMaxAgeSeconds: 600 });
  });

  it("redact removes a secret wherever it appears, and ignores empty or tiny ones", () => {
    expect(redact(`x ${FAKE_KEY} y ${FAKE_KEY}`, [FAKE_KEY])).toBe("x [redacted] y [redacted]");
    expect(redact("hello", [null, undefined, "", "ab"])).toBe("hello");
  });
});

describe("planning requests", () => {
  it("puts vessels in batches up to the batch size, keeping MMSI and IMO requests apart (one call carries one kind)", () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "2" });
    const plan = runtime.provider.planRequests([{ mmsi: "111111111" }, { mmsi: "222222222" }, { mmsi: "333333333" }, { imo: "9074729" }, { imo: "9319466" }, { imo: "9811000" }]);
    expect(plan).toEqual([[{ mmsi: "111111111" }, { mmsi: "222222222" }], [{ mmsi: "333333333" }], [{ imo: "9074729" }, { imo: "9319466" }], [{ imo: "9811000" }]]);
  });

  it("uses the MMSI when a vessel has both, and drops duplicates and malformed identifiers", () => {
    const runtime = liveRuntime(NOW);
    const plan = runtime.provider.planRequests([{ mmsi: "111111111", imo: "9074729" }, { mmsi: "111111111" }, { mmsi: "12" }, { imo: "9074728" }, {}]);
    expect(plan).toEqual([[{ mmsi: "111111111" }]]);
    expect(runtime.provider.planRequests([])).toEqual([]);
  });

  it("chooses the MMSI for a vessel that has both, and its IMO only when it has no MMSI", () => {
    const runtime = liveRuntime(NOW);
    expect(runtime.provider.planRequests([{ mmsi: "222222222", imo: "9074729" }])).toEqual([[{ mmsi: "222222222" }]]);
    expect(runtime.provider.planRequests([{ imo: "9074729" }])).toEqual([[{ imo: "9074729" }]]);
    // A malformed MMSI is not swapped for the IMO: the vessel is left out rather than asked about under another number.
    expect(runtime.provider.planRequests([{ mmsi: "22", imo: "9074729" }])).toEqual([]);
  });

  it("asks for one vessel per call in single mode", () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_LOOKUP: "single" });
    expect(runtime.provider.planRequests([{ mmsi: "111111111" }, { mmsi: "222222222" }])).toEqual([[{ mmsi: "111111111" }], [{ mmsi: "222222222" }]]);
  });
});

describe("the batch request, as VesselAPI documents it", () => {
  it("is a GET to /vessels/positions with the ids, their type, a time window and a page size, and the key in a Bearer header only", async () => {
    const runtime = liveRuntime(NOW);
    await runtime.provider.fetchPositions([{ mmsi: "111111111" }, { mmsi: "222222222" }], ctx);
    expect(runtime.requests).toHaveLength(1);
    const { url, headers, method } = runtime.requests[0]!;
    expect(method).toBe("GET");
    expect(`${url.origin}${url.pathname}`).toBe("https://api.vesselapi.com/v1/vessels/positions");
    expect(url.searchParams.get("filter.ids")).toBe("111111111,222222222");
    expect(url.searchParams.get("filter.idType")).toBe("mmsi");
    expect(url.searchParams.get("time.from")).toBe("2026-09-09T12:00:00.000Z"); // 24 hours back by default
    expect(url.searchParams.get("time.to")).toBe(NOW.toISOString());
    expect(url.searchParams.get("pagination.limit")).toBe("50");
    expect(url.searchParams.has("filter.sat")).toBe(false); // satellite lookups cost separate credits and are never asked for
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(url.toString()).not.toContain(FAKE_KEY.slice(0, 12));
  });

  it("asks for IMO numbers with idType imo", async () => {
    const runtime = liveRuntime(NOW);
    await runtime.provider.fetchPositions([{ imo: "9074729" }], ctx);
    expect(runtime.requests[0]!.url.searchParams.get("filter.idType")).toBe("imo");
    expect(runtime.requests[0]!.url.searchParams.get("filter.ids")).toBe("9074729");
  });

  it("uses the configured window, base URL and batch size", async () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_WINDOW_HOURS: "6", VESSELAPI_BASE_URL: "https://example.test/api" });
    await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx);
    const { url } = runtime.requests[0]!;
    expect(url.origin + url.pathname).toBe("https://example.test/api/vessels/positions");
    expect(url.searchParams.get("time.from")).toBe("2026-09-10T06:00:00.000Z");
  });

  it("the single-vessel request is GET /vessel/{id}/position with the id type", async () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_LOOKUP: "single" });
    await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx);
    const { url } = runtime.requests[0]!;
    expect(url.pathname).toBe("/v1/vessel/111111111/position");
    expect(url.searchParams.get("filter.idType")).toBe("mmsi");
  });

  it("refuses, before any call, a group that is not one request: mixed types, too many, or nothing usable", async () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "2" });
    for (const group of [[{ mmsi: "111111111" }, { imo: "9074729" }], [{ mmsi: "111111111" }, { mmsi: "222222222" }, { mmsi: "333333333" }], [], [{ mmsi: "1" }]]) {
      await expect(runtime.provider.fetchPositions(group, ctx)).rejects.toBeInstanceOf(ProviderError);
    }
    expect(runtime.requests).toHaveLength(0);
    expect(await calls()).toHaveLength(0);
  });
});

describe("reading the response", () => {
  it("turns VesselAPI's fields into normalised positions", async () => {
    const at = new Date("2026-09-10T11:50:00Z");
    const runtime = liveRuntime(NOW, {}, () =>
      jsonResponse({ vesselPositions: [apiPosition("235012345", at, { imo: 9074729, latitude: 49.9, longitude: -4.2, sog: 14.2, heading: 251, nav_status: 0 })] }),
    );
    const [p] = await runtime.provider.fetchPositions([{ mmsi: "235012345" }], ctx);
    expect(p).toEqual({ mmsi: "235012345", imo: "9074729", lat: 49.9, lng: -4.2, speedKnots: 14.2, headingDeg: 251, navStatus: 0, positionTime: at, source: "vesselapi" });
  });

  it("pads identifiers that lost leading zeros as numbers, and leaves out null fields", async () => {
    const runtime = liveRuntime(NOW, {}, () => jsonResponse({ vesselPositions: [apiPosition("1", new Date(NOW.getTime() - 60_000), { mmsi: 12345678, imo: null, sog: null, heading: null, nav_status: null })] }));
    const [p] = await runtime.provider.fetchPositions([{ mmsi: "012345678" }], ctx);
    expect(p!.mmsi).toBe("012345678");
    expect(p).not.toHaveProperty("speedKnots");
    expect(p).not.toHaveProperty("headingDeg");
    expect(p).not.toHaveProperty("imo");
  });

  it("drops positions the API marks as suspected glitches, and ones that fail validation, and says how many", async () => {
    const t = new Date(NOW.getTime() - 60_000);
    const runtime = liveRuntime(NOW, {}, () =>
      jsonResponse({
        vesselPositions: [
          apiPosition("111111111", t),
          apiPosition("222222222", t, { suspected_glitch: true }),
          apiPosition("333333333", t, { latitude: 123 }),
          apiPosition("444444444", new Date(NOW.getTime() + 3_600_000)),
        ],
      }),
    );
    const positions = await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx);
    expect(positions.map((p) => p.mmsi)).toEqual(["111111111"]);
    expect(runtime.lines).toEqual(
      expect.arrayContaining(["vesselapi: dropped 1 positions the API marked as suspected glitches.", "vesselapi: dropped 2 of 3 positions that failed validation."]),
    );
  });

  it("reads the single-vessel answer whether it is wrapped or plain", async () => {
    const t = new Date(NOW.getTime() - 60_000);
    for (const body of [{ vesselPosition: apiPosition("111111111", t) }, apiPosition("111111111", t)]) {
      const runtime = liveRuntime(NOW, { VESSELAPI_LOOKUP: "single" }, () => jsonResponse(body));
      expect(await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx)).toHaveLength(1);
    }
  });

  it("reads only the first page and says so, because another page would be another call", async () => {
    const runtime = liveRuntime(NOW, {}, () => jsonResponse({ vesselPositions: [apiPosition("111111111", new Date(NOW.getTime() - 60_000))], nextToken: "more" }));
    await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.lines.join("\n")).toMatch(/only the first was read/);
  });

  it("yields nothing for an empty or unexpected body, without failing", async () => {
    for (const body of [{}, { vesselPositions: [] }, [], "text", null]) {
      const runtime = liveRuntime(NOW, {}, () => jsonResponse(body));
      expect(await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx), JSON.stringify(body)).toEqual([]);
    }
  });
});

describe("failures", () => {
  const status = (code: number, headers: Record<string, string> = {}) => () => new Response("{}", { status: code, headers });

  it("treats 401, 403 and 5xx as failures, makes exactly one request each, and does not retry", async () => {
    for (const code of [400, 401, 403, 500, 502, 503]) {
      const runtime = liveRuntime(NOW, {}, status(code));
      await expect(runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx), String(code)).rejects.toMatchObject({ name: "ProviderError", status: String(code) });
      expect(runtime.requests, String(code)).toHaveLength(1);
    }
  });

  it("says a rejected key was rejected, without saying what the key was", async () => {
    const runtime = liveRuntime(NOW, {}, status(401));
    const error = await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx).catch((e) => e);
    expect(error.message).toBe("VesselAPI answered 401: the key was rejected.");
  });

  it("counts every failed call in the ledger, with its outcome", async () => {
    const outcomes = [status(500), status(401), () => Promise.reject(new TypeError("fetch failed"))];
    for (const respond of outcomes) {
      const runtime = liveRuntime(NOW, {}, respond as never);
      await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx).catch(() => {});
    }
    expect((await calls()).map((c) => c.status).sort()).toEqual(["401", "500", "network_error"]);
  });

  it("records a call as timeout when it takes too long, and gives up", async () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_TIMEOUT_MS: "1000" }, (_req) => new Promise<Response>(() => {}));
    // The fake never answers; the abort signal is what ends the wait, via a fetch that honours it.
    const hanging = (async (_url: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))))) as unknown as typeof fetch;
    const provider = new VesselApiProvider({ config: { ...runtime.config, requestTimeoutMs: 1000 }, ledger: runtime.ledger, fetchImpl: hanging });
    await expect(provider.fetchPositions([{ mmsi: "111111111" }], ctx)).rejects.toMatchObject({ status: "timeout" });
    expect((await calls()).map((c) => c.status)).toEqual(["timeout"]);
  }, 15_000);

  it("a 404 from the single-vessel endpoint means no position, not a failure", async () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_LOOKUP: "single" }, status(404));
    expect(await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx)).toEqual([]);
    expect((await calls()).map((c) => c.status)).toEqual(["404"]); // still counted
  });

  it("a body that is not JSON is a failure", async () => {
    const runtime = liveRuntime(NOW, {}, () => new Response("<html>", { status: 200 }));
    await expect(runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx)).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("a 429", () => {
  it("is recorded, sets a back-off, and the next attempt makes no request at all", async () => {
    const runtime = liveRuntime(NOW, {}, () => new Response("{}", { status: 429, headers: { "retry-after": "1200" } }));
    await expect(runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx)).rejects.toMatchObject({ status: "429" });
    expect(runtime.requests).toHaveLength(1);

    const later = { purpose: "test", now: new Date(NOW.getTime() + 60_000) };
    await expect(runtime.provider.fetchPositions([{ mmsi: "111111111" }], later)).rejects.toMatchObject({ name: "CallRefusedError", reason: "backoff" });
    expect(runtime.requests).toHaveLength(1); // nothing was sent
    const [row] = await calls();
    expect(row).toMatchObject({ status: "429", retry_after_seconds: 1200 });
  });

  it("makes a request again once the wait has passed", async () => {
    let n = 0;
    const runtime = liveRuntime(NOW, {}, () => (++n === 1 ? new Response("{}", { status: 429 }) : jsonResponse({ vesselPositions: [apiPosition("111111111", new Date(NOW.getTime() + 3600_000 - 60_000))] })));
    await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx).catch(() => {});
    const after = { purpose: "test", now: new Date(NOW.getTime() + 3600_000) };
    expect(await runtime.provider.fetchPositions([{ mmsi: "111111111" }], after)).toHaveLength(1);
    expect(runtime.requests).toHaveLength(2);
  });
});

describe("the budget is enforced inside the provider", () => {
  it("makes no request when the month's allowance is used up, whoever asks", async () => {
    const runtime = liveRuntime(NOW, { VESSELAPI_MONTHLY_BUDGET: "20", VESSELAPI_RESERVE: "5" });
    await getDb().insert(provider_calls).values(Array.from({ length: 15 }, () => ({ provider: "vesselapi", called_at: NOW, purpose: "seed", status: "200", vessels_requested: 1 })));
    await expect(runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx)).rejects.toMatchObject({ name: "CallRefusedError", reason: "budget" });
    expect(runtime.requests).toHaveLength(0);
    // A manual call may use the reserve.
    await expect(runtime.provider.fetchPositions([{ mmsi: "111111111" }], { ...ctx, allowReserve: true })).resolves.toHaveLength(1);
    expect(runtime.requests).toHaveLength(1);
  });

  it("writes one ledger row per request, with how many vessels it asked about, and the outcome", async () => {
    const runtime = liveRuntime(NOW);
    await runtime.provider.fetchPositions([{ mmsi: "111111111" }, { mmsi: "222222222" }, { mmsi: "333333333" }], { purpose: "scheduled_refresh", now: NOW });
    const rows = await calls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "vesselapi", purpose: "scheduled_refresh", status: "200", vessels_requested: 3 });
  });
});

describe("no key ever leaves the provider", () => {
  it("is not in an error message, a log line, the ledger, or the request URL, whatever fails", async () => {
    const failing = [
      () => new Response(`{"message":"bad key ${FAKE_KEY}"}`, { status: 401 }),
      () => new Response("x", { status: 500 }),
      () => Promise.reject(new Error(`connect failed for Bearer ${FAKE_KEY}`)),
      () => new Response("not json", { status: 200 }),
    ];
    const seen: string[] = [];
    for (const respond of failing) {
      const runtime = liveRuntime(NOW, {}, respond as never);
      const error = await runtime.provider.fetchPositions([{ mmsi: "111111111" }], ctx).catch((e) => e);
      seen.push(String(error.message), ...runtime.lines, ...runtime.requests.map((r) => r.url.toString()));
    }
    seen.push(JSON.stringify(await calls()));
    expect(seen.join("\n")).not.toContain(FAKE_KEY);
    expect(seen.join("\n")).not.toMatch(/SECRET/);
  });

  it("is not in the configuration's printed form when a caller logs the runtime by mistake, apart from the one field that holds it", () => {
    const runtime = liveRuntime(NOW);
    expect(vesselApi(runtime).name).toBe("vesselapi");
    // The config object holds the key by necessity; this pins that nothing else does.
    const others = { ...runtime.config, vesselApiKey: null };
    expect(JSON.stringify(others)).not.toContain(FAKE_KEY);
  });
});
