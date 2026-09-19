import type { Logger } from "../src/tracking/provider.js";
import { createTrackingRuntime, type TrackingRuntime } from "../src/tracking/runtime.js";

/** A fake key with a distinctive shape, so a test can search everything for it. Never a real key. */
export const FAKE_KEY = "vk_test_SECRET_do_not_leak_0123456789";

export interface RecordedRequest {
  url: URL;
  headers: Record<string, string>;
  method: string;
}

export type Responder = (request: RecordedRequest, index: number) => Response | Promise<Response>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export { json as jsonResponse };

/** One position row in VesselAPI's shape. */
export function apiPosition(mmsi: string, at: Date, over: Record<string, unknown> = {}) {
  return {
    mmsi: Number(mmsi),
    imo: null,
    vessel_name: "SAMPLE",
    latitude: 50.5,
    longitude: -2.5,
    timestamp: at.toISOString(),
    processed_timestamp: at.toISOString(),
    cog: 90,
    sog: 12.3,
    heading: 88,
    nav_status: 0,
    suspected_glitch: false,
    ...over,
  };
}

/**
 * A fake for the network. It never touches one: fetch is replaced by this. By default it answers a
 * batch request with one recent position per requested vessel (and a single-vessel request with
 * that vessel's position), and records every request so a test can count calls and read headers.
 */
export function fakeNetwork(now: Date, responder?: Responder) {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    const request: RecordedRequest = { url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), method: init?.method ?? "GET" };
    requests.push(request);
    if (responder) return responder(request, requests.length - 1);
    const idType = url.searchParams.get("filter.idType");
    if (url.pathname.endsWith("/vessels/positions")) {
      const ids = (url.searchParams.get("filter.ids") ?? "").split(",").filter(Boolean);
      return json({ vesselPositions: ids.map((id) => apiPosition(id, new Date(now.getTime() - 5 * 60_000), idType === "imo" ? { mmsi: 999000000 + Number(id.slice(-3)), imo: Number(id) } : {})) });
    }
    const id = decodeURIComponent(url.pathname.split("/")[2]!);
    return json({ vesselPosition: apiPosition(id, new Date(now.getTime() - 5 * 60_000)) });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

export function captureLog() {
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  return { lines, log };
}

/** A runtime on the live provider with a fake network. Extra env overrides the defaults. */
export function liveRuntime(now: Date, env: Record<string, string> = {}, responder?: Responder): TrackingRuntime & { requests: RecordedRequest[]; lines: string[] } {
  const net = fakeNetwork(now, responder);
  const logs = captureLog();
  const runtime = createTrackingRuntime(
    { AIS_PROVIDER: "vesselapi", AIS_LIVE_ALLOWED: "true", VESSELAPI_KEY: FAKE_KEY, ...env } as NodeJS.ProcessEnv,
    { fetchImpl: net.fetchImpl, log: logs.log },
  );
  return Object.assign(runtime, { requests: net.requests, lines: logs.lines });
}
