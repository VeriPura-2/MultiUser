import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { provider_calls, tracking_runs } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { TRAIL_MAX_POINTS, ageInSeconds, classifyFreshness, listPositions, thinTrail } from "../src/services/positions.js";
import { ingestPositions } from "../src/tracking/ingest.js";
import type { VesselPositionReport } from "../src/tracking/provider.js";
import { createTrackingRuntime } from "../src/tracking/runtime.js";
import { createActiveOrg, createSuperadmin, createTradeParties, multipartForm, scenario, submitTestPO, type TradeParties } from "./helpers.js";
import { FAKE_KEY, liveRuntime } from "./trackingHelpers.js";

const MIN = 60_000;
const ago = (minutes: number, from = Date.now()) => new Date(from - minutes * MIN);
const position = (over: Partial<VesselPositionReport> & { minutesAgo?: number } = {}): VesselPositionReport => {
  const { minutesAgo = 5, ...rest } = over;
  return { mmsi: "100000001", lat: 50.1, lng: -2.2, speedKnots: 12.5, headingDeg: 88, positionTime: ago(minutesAgo), source: "vesselapi", ...rest };
};

const makeApp = (runtime = createTrackingRuntime({} as NodeJS.ProcessEnv)) => buildApp({ actor: { allowDevActorHeader: true }, tracking: runtime });
const get = (app: ReturnType<typeof makeApp>, url: string, actorId?: string) => app.inject({ method: "GET", url, headers: actorId ? { "x-dev-user": actorId } : {} });
const positionsOf = async (app: ReturnType<typeof makeApp>, actorId: string, query = "") => (await get(app, `/positions${query}`, actorId)).json().positions as Array<Record<string, any>>;
const forConsignment = (list: Array<Record<string, any>>, id: string) => list.find((p) => p.consignmentId === id)!;

async function consignmentWith(parties: TradeParties, vessel: { mmsi?: string; imo?: string }) {
  return submitTestPO(parties, { vesselMmsi: vessel.mmsi, vesselImo: vessel.imo });
}

describe("freshness", () => {
  it("is recent up to and including the threshold, stale beyond it, and unavailable with no position", () => {
    expect(classifyFreshness(null, 7200)).toBe("unavailable");
    expect(classifyFreshness(0, 7200)).toBe("recent");
    expect(classifyFreshness(7199, 7200)).toBe("recent");
    expect(classifyFreshness(7200, 7200)).toBe("recent"); // "at most 2 hours old"
    expect(classifyFreshness(7201, 7200)).toBe("stale");
    expect(classifyFreshness(86_400, 7200)).toBe("stale");
  });

  it("uses whatever threshold it is given, so the value is configuration and not a literal", () => {
    expect(classifyFreshness(700, 600)).toBe("stale");
    expect(classifyFreshness(600, 600)).toBe("recent");
    expect(classifyFreshness(700, 900)).toBe("recent");
  });

  it("ages a position in whole seconds, rounding down, and never negative", () => {
    const now = new Date("2026-09-10T12:00:00.000Z");
    expect(ageInSeconds(new Date("2026-09-10T11:59:00.900Z"), now)).toBe(59);
    expect(ageInSeconds(new Date("2026-09-10T11:59:00.400Z"), now)).toBe(59); // 59.6 seconds: rounded down, not up
    expect(ageInSeconds(new Date("2026-09-10T10:00:00.000Z"), now)).toBe(7200);
    expect(ageInSeconds(new Date("2026-09-10T12:00:30.000Z"), now)).toBe(0); // a moment ahead of our clock
  });
});

describe("thinning a trail", () => {
  const points = (n: number) => Array.from({ length: n }, (_, i) => i);

  it("leaves a short trail alone, and cuts a long one to at most 100 points", () => {
    expect(thinTrail(points(0))).toEqual([]);
    expect(thinTrail(points(1))).toEqual([0]);
    expect(thinTrail(points(100))).toHaveLength(100);
    expect(thinTrail(points(101))).toHaveLength(100);
    expect(thinTrail(points(1000))).toHaveLength(100);
    expect(TRAIL_MAX_POINTS).toBe(100);
  });

  it("keeps the first and the last, in order, without repeating a point", () => {
    const thinned = thinTrail(points(250));
    expect(thinned[0]).toBe(0);
    expect(thinned[thinned.length - 1]).toBe(249);
    expect([...thinned].sort((a, b) => a - b)).toEqual(thinned);
    expect(new Set(thinned).size).toBe(thinned.length);
  });

  it("spaces the points evenly", () => {
    const gaps = thinTrail(points(1000)).slice(1).map((v, i, all) => v - thinTrail(points(1000))[i]!);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  });

  it("respects another maximum", () => {
    expect(thinTrail(points(50), 2)).toEqual([0, 49]);
    expect(thinTrail(points(50), 5)).toHaveLength(5);
  });
});

describe("GET /positions", () => {
  it("gives a recent position with its age, speed and heading, and says whether it is sample data", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ minutesAgo: 10 })]);
    const item = forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id);
    expect(item).toMatchObject({ freshness: "recent", reason: null, lat: 50.1, lng: -2.2, speedKnots: 12.5, headingDeg: 88, isSample: false });
    expect(item.ageSeconds).toBeGreaterThanOrEqual(600);
    expect(item.ageSeconds).toBeLessThan(620);
    expect(new Date(item.positionTime).getTime()).toBeCloseTo(Date.now() - 600_000, -4);
  });

  it("is stale once the position is older than the threshold, and still gives it", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ minutesAgo: 3 * 60 })]);
    const item = forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id);
    expect(item).toMatchObject({ freshness: "stale", reason: null, lat: 50.1 });
    expect(item.ageSeconds).toBeGreaterThan(3 * 3600 - 5);
  });

  it("takes the recent-or-stale threshold from the configuration", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ minutesAgo: 20 })]);
    const short = makeApp(createTrackingRuntime({ TRACKING_RECENT_MAX_AGE_SECONDS: "600" } as NodeJS.ProcessEnv));
    expect(forConsignment(await positionsOf(short, s.importerAdmin.id), s.consignment.id).freshness).toBe("stale");
    expect(forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id).freshness).toBe("recent");
  });

  it("marks a sample position as sample, and only a sample position", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ source: "sample" })]);
    expect(forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id).isSample).toBe(true);
  });

  it("does not omit a consignment with no vessel identifier: it is unavailable, with the reason", async () => {
    const s = await scenario();
    const item = forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id);
    expect(item).toMatchObject({ freshness: "unavailable", reason: "no_vessel_identifier", lat: null, lng: null, speedKnots: null, headingDeg: null, positionTime: null, ageSeconds: null, isSample: false });
  });

  it("says no position has been received yet for a vessel that has an identifier but no position", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    const item = forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id);
    expect(item).toMatchObject({ freshness: "unavailable", reason: "no_position_received", lat: null, ageSeconds: null });
  });

  it("uses the latest position when there are several", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ minutesAgo: 300, lat: 1 }), position({ minutesAgo: 20, lat: 2 }), position({ minutesAgo: 90, lat: 3 })]);
    expect(forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id).lat).toBe(2);
  });

  it("finds a vessel by IMO when the consignment has only an IMO, and by MMSI when it has only an MMSI", async () => {
    const parties = await createTradeParties();
    const byImo = await consignmentWith(parties, { imo: "9074729" });
    const byMmsi = await consignmentWith(parties, { mmsi: "100000002" });
    await ingestPositions([position({ mmsi: undefined, imo: "9074729", lat: 11 }), position({ mmsi: "100000002", lat: 22 })]);
    const list = await positionsOf(makeApp(), parties.importer.admin.id);
    expect(forConsignment(list, byImo.id)).toMatchObject({ freshness: "recent", lat: 11 });
    expect(forConsignment(list, byMmsi.id)).toMatchObject({ freshness: "recent", lat: 22 });
  });

  it("finds a position stored under the MMSI for a consignment that has both numbers, and one stored under the IMO", async () => {
    const parties = await createTradeParties();
    const both = await consignmentWith(parties, { mmsi: "100000003", imo: "9074729" });
    await ingestPositions([position({ mmsi: undefined, imo: "9074729", minutesAgo: 30, lat: 5 }), position({ mmsi: "100000003", minutesAgo: 10, lat: 6 })]);
    expect(forConsignment(await positionsOf(makeApp(), parties.importer.admin.id), both.id).lat).toBe(6); // the later of the two
  });

  it("does not mix up two vessels", async () => {
    const parties = await createTradeParties();
    const a = await consignmentWith(parties, { mmsi: "100000001" });
    const b = await consignmentWith(parties, { mmsi: "100000002" });
    await ingestPositions([position({ mmsi: "100000001", lat: 10 }), position({ mmsi: "100000002", lat: 20 })]);
    const list = await positionsOf(makeApp(), parties.importer.admin.id);
    expect([forConsignment(list, a.id).lat, forConsignment(list, b.id).lat]).toEqual([10, 20]);
  });

  it("lists the newest consignment first, like GET /consignments", async () => {
    const parties = await createTradeParties();
    const first = await consignmentWith(parties, {});
    const second = await consignmentWith(parties, {});
    expect((await positionsOf(makeApp(), parties.importer.admin.id)).map((p) => p.consignmentId)).toEqual([second.id, first.id]);
  });

  it("returns an empty list, not an error, when the user has no consignments", async () => {
    const lonely = await createActiveOrg("importer");
    expect(await positionsOf(makeApp(), lonely.admin.id)).toEqual([]);
  });

  it("is a 401 without a user", async () => {
    expect((await get(makeApp(), "/positions")).statusCode).toBe(401);
  });

  it("stops showing a vessel once it has been cleared from the consignment", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position()]);
    const app = makeApp();
    await app.inject({ method: "PATCH", url: `/consignments/${s.consignment.id}/vessel`, headers: { "x-dev-user": s.importerAdmin.id, "content-type": "application/json" }, payload: { vesselMmsi: null } as object });
    expect(forConsignment(await positionsOf(app, s.importerAdmin.id), s.consignment.id)).toMatchObject({ freshness: "unavailable", reason: "no_vessel_identifier", lat: null });
  });
});

describe("the trail", () => {
  it("is the last 24 hours of positions, oldest first, and leaves older ones out", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([
      position({ minutesAgo: 25 * 60, lat: 1 }), // too old for the trail
      position({ minutesAgo: 23 * 60, lat: 2 }),
      position({ minutesAgo: 12 * 60, lat: 3 }),
      position({ minutesAgo: 5, lat: 4 }),
    ]);
    const item = forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id);
    expect(item.trail.map((p: { lat: number }) => p.lat)).toEqual([2, 3, 4]);
    expect(Object.keys(item.trail[0]).sort()).toEqual(["lat", "lng", "positionTime"]);
    expect(item.lat).toBe(4);
  });

  it("draws a moment stored under both the MMSI and the IMO once", async () => {
    const parties = await createTradeParties();
    const c = await consignmentWith(parties, { mmsi: "100000003", imo: "9074729" });
    const t = ago(30);
    await ingestPositions([position({ mmsi: "100000003", positionTime: t }), position({ mmsi: undefined, imo: "9074729", positionTime: t })]);
    expect(forConsignment(await positionsOf(makeApp(), parties.importer.admin.id), c.id).trail).toHaveLength(1);
  });

  it("is thinned to at most 100 points, keeping the newest and the oldest", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions(Array.from({ length: 150 }, (_, i) => position({ minutesAgo: 150 - i, lat: i / 10 })));
    const item = forConsignment(await positionsOf(makeApp(), s.importerAdmin.id), s.consignment.id);
    expect(item.trail).toHaveLength(100);
    expect(item.trail[0].lat).toBe(0);
    expect(item.trail[99].lat).toBe(14.9);
  });

  it("is left out with ?trail=false, and is an empty list, not missing, for a vessel with no positions", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position()]);
    const app = makeApp();
    expect(forConsignment(await positionsOf(app, s.importerAdmin.id, "?trail=false"), s.consignment.id)).not.toHaveProperty("trail");
    expect(forConsignment(await positionsOf(app, s.importerAdmin.id, "?trail=true"), s.consignment.id).trail).toHaveLength(1);
    const noVessel = await scenario();
    expect(forConsignment(await positionsOf(app, noVessel.importerAdmin.id), noVessel.consignment.id).trail).toEqual([]);
  });

  it("is left out with ?trail=false for a consignment with no position too, whatever the reason", async () => {
    const noVessel = await scenario();
    const noPosition = await scenario(undefined, { vesselMmsi: "100000001" });
    const app = makeApp();
    expect(forConsignment(await positionsOf(app, noVessel.importerAdmin.id, "?trail=false"), noVessel.consignment.id)).not.toHaveProperty("trail");
    expect(forConsignment(await positionsOf(app, noPosition.importerAdmin.id, "?trail=false"), noPosition.consignment.id)).not.toHaveProperty("trail");
    expect(forConsignment(await positionsOf(app, noPosition.importerAdmin.id), noPosition.consignment.id).trail).toEqual([]);
  });

  it("is a 422 for anything but true or false", async () => {
    const s = await scenario();
    expect((await get(makeApp(), "/positions?trail=maybe", s.importerAdmin.id)).statusCode).toBe(422);
    expect((await get(makeApp(), `/consignments/${s.consignment.id}/position?trail=1`, s.importerAdmin.id)).statusCode).toBe(422);
  });
});

describe("visibility: a consignment the user cannot see never leaks a position", () => {
  it("shows each party its own consignments, and the exporter the ones it exports", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ lat: 41.5 })]);
    const app = makeApp();
    for (const id of [s.importerAdmin.id, s.exporterAdmin.id]) {
      expect(forConsignment(await positionsOf(app, id), s.consignment.id)).toMatchObject({ freshness: "recent", lat: 41.5 });
    }
  });

  it("lists nothing, and reveals no coordinates, to an organization that is not a party", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ lat: 41.123456 })]);
    const stranger = await createActiveOrg("importer");
    const otherExporter = await createActiveOrg("exporter");
    const app = makeApp();
    for (const id of [stranger.admin.id, otherExporter.admin.id]) {
      const res = await get(app, "/positions", id);
      expect(res.json()).toEqual({ positions: [] });
      expect(res.body).not.toContain("41.123456");
      expect(res.body).not.toContain(s.consignment.id);
    }
  });

  it("gives each importer only its own, even when two consignments are on the same ship", async () => {
    const a = await createTradeParties();
    const b = await createTradeParties();
    const ca = await consignmentWith(a, { mmsi: "100000001" });
    const cb = await consignmentWith(b, { mmsi: "100000001" }); // the same vessel on another importer's consignment
    await ingestPositions([position({ lat: 33.3 })]);
    const app = makeApp();
    expect((await positionsOf(app, a.importer.admin.id)).map((p) => p.consignmentId)).toEqual([ca.id]);
    expect((await positionsOf(app, b.importer.admin.id)).map((p) => p.consignmentId)).toEqual([cb.id]);
    expect((await positionsOf(app, a.exporter.admin.id)).map((p) => p.consignmentId)).toEqual([ca.id]);
  });

  it("shows a superadmin everything", async () => {
    const a = await createTradeParties();
    const b = await createTradeParties();
    const ca = await consignmentWith(a, { mmsi: "100000001" });
    const cb = await consignmentWith(b, {});
    const superadmin = await createSuperadmin();
    expect((await positionsOf(makeApp(), superadmin.id)).map((p) => p.consignmentId).sort()).toEqual([ca.id, cb.id].sort());
  });

  it("answers the single-consignment endpoint with the same 404 for a stranger, a missing id and a malformed id", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ lat: 41.123456 })]);
    const stranger = await createActiveOrg("importer");
    const app = makeApp();
    const real = await get(app, `/consignments/${s.consignment.id}/position`, stranger.admin.id);
    const missing = await get(app, "/consignments/00000000-0000-4000-8000-000000000000/position", stranger.admin.id);
    const malformed = await get(app, "/consignments/not-a-uuid/position", stranger.admin.id);
    for (const res of [real, missing, malformed]) expect(res.statusCode).toBe(404);
    expect(real.json()).toEqual(missing.json());
    expect(real.body).not.toContain("41.123456");
  });

  it("gives a party the single-consignment position, with its trail, and a 401 without a user", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position({ minutesAgo: 30, lat: 7 }), position({ minutesAgo: 5, lat: 8 })]);
    const app = makeApp();
    const res = await get(app, `/consignments/${s.consignment.id}/position`, s.exporterAdmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ consignmentId: s.consignment.id, freshness: "recent", lat: 8 });
    expect(res.json().trail.map((p: { lat: number }) => p.lat)).toEqual([7, 8]);
    expect((await get(app, `/consignments/${s.consignment.id}/position`)).statusCode).toBe(401);
    expect((await get(app, `/consignments/${s.consignment.id}/position?trail=false`, s.importerAdmin.id)).json()).not.toHaveProperty("trail");
  });

  it("listPositions is scoped by the service itself, not only by the route", async () => {
    const a = await createTradeParties();
    const b = await createTradeParties();
    await consignmentWith(a, { mmsi: "100000001" });
    await ingestPositions([position()]);
    expect(await listPositions(b.importer.admin, { recentMaxAgeSeconds: 7200 })).toEqual([]);
    expect(await listPositions(a.importer.admin, { recentMaxAgeSeconds: 7200 })).toHaveLength(1);
  });
});

describe("reading positions never calls a provider", () => {
  it("makes no request and writes no ledger row for any read the dashboard makes, however often", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    await ingestPositions([position()]);
    const runtime = liveRuntime(new Date());
    const app = makeApp(runtime);
    const urls = ["/me", "/consignments", `/consignments/${s.consignment.id}`, `/consignments/${s.consignment.id}/checklist`, "/positions", "/positions?trail=false", `/consignments/${s.consignment.id}/position`, "/action-queue", "/parties/workload"];
    for (let round = 0; round < 3; round++) {
      for (const url of urls) expect((await get(app, url, s.importerAdmin.id)).statusCode, url).toBe(200);
    }
    expect(runtime.requests).toHaveLength(0);
    expect(await getDb().select().from(provider_calls)).toHaveLength(0);
    expect(await getDb().select().from(tracking_runs)).toHaveLength(0);
  });

  it("does not call one for the admin budget read either", async () => {
    const superadmin = await createSuperadmin();
    const runtime = liveRuntime(new Date());
    const app = makeApp(runtime);
    for (let i = 0; i < 3; i++) expect((await get(app, "/admin/tracking/budget", superadmin.id)).statusCode).toBe(200);
    expect(runtime.requests).toHaveLength(0);
  });

  it("a page with a vessel that has never been refreshed shows unavailable and still calls nothing", async () => {
    const s = await scenario(undefined, { vesselMmsi: "100000001" });
    const runtime = liveRuntime(new Date());
    const item = forConsignment(await positionsOf(makeApp(runtime), s.importerAdmin.id), s.consignment.id);
    expect(item.reason).toBe("no_position_received");
    expect(runtime.requests).toHaveLength(0);
  });
});

describe("GET /admin/tracking/budget", () => {
  it("is a 401 without a user and a 403 for anyone but a superadmin", async () => {
    const parties = await createTradeParties();
    const app = makeApp();
    expect((await get(app, "/admin/tracking/budget")).statusCode).toBe(401);
    expect((await get(app, "/admin/tracking/budget", parties.importer.admin.id)).statusCode).toBe(403);
    expect((await get(app, "/admin/tracking/budget", parties.exporter.admin.id)).statusCode).toBe(403);
  });

  it("reports the calls used this month, the budget, the reserve, and what is left, before anything has happened", async () => {
    const superadmin = await createSuperadmin();
    const res = await get(makeApp(liveRuntime(new Date())), "/admin/tracking/budget", superadmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      provider: "vesselapi",
      live: true,
      month: new Date().toISOString().slice(0, 7),
      callsUsed: 0,
      budget: 150,
      reserve: 15,
      remaining: 150,
      automaticRemaining: 135,
      percentUsed: 0,
      backoffUntil: null,
      lastRefreshAt: null,
      lastRefresh: null,
    });
  });

  it("counts this month's calls, failed ones included, and not last month's", async () => {
    const superadmin = await createSuperadmin();
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 86_400_000);
    await getDb().insert(provider_calls).values([
      { provider: "vesselapi", called_at: now, purpose: "x", status: "200", vessels_requested: 1 },
      { provider: "vesselapi", called_at: now, purpose: "x", status: "500", vessels_requested: 1 },
      { provider: "vesselapi", called_at: now, purpose: "x", status: "timeout", vessels_requested: 1 },
      { provider: "vesselapi", called_at: lastMonth, purpose: "x", status: "200", vessels_requested: 1 },
    ]);
    const body = (await get(makeApp(liveRuntime(now)), "/admin/tracking/budget", superadmin.id)).json();
    expect(body).toMatchObject({ callsUsed: 3, remaining: 147, automaticRemaining: 132, percentUsed: 2 });
  });

  it("follows the configured budget and reserve", async () => {
    const superadmin = await createSuperadmin();
    const body = (await get(makeApp(liveRuntime(new Date(), { VESSELAPI_MONTHLY_BUDGET: "1500", VESSELAPI_RESERVE: "100" })), "/admin/tracking/budget", superadmin.id)).json();
    expect(body).toMatchObject({ budget: 1500, reserve: 100, remaining: 1500, automaticRemaining: 1400 });
  });

  it("reports the date and outcome of the last refresh, after one has run", async () => {
    const parties = await createTradeParties();
    await consignmentWith(parties, { mmsi: "100000001" });
    const superadmin = await createSuperadmin();
    const runtime = liveRuntime(new Date());
    const app = makeApp(runtime);
    await app.inject({ method: "POST", url: "/admin/positions/refresh", headers: { "x-dev-user": superadmin.id } });
    const body = (await get(app, "/admin/tracking/budget", superadmin.id)).json();
    expect(body.callsUsed).toBe(1);
    expect(new Date(body.lastRefreshAt).getTime()).toBeCloseTo(Date.now(), -4);
    expect(body.lastRefresh).toMatchObject({ trigger: "manual", provider: "vesselapi", vesselsSelected: 1, callsMade: 1, positionsStored: 1, stoppedReason: null });
    expect(body.lastRefresh.finishedAt).not.toBeNull();
  });

  it("says when a 429 back-off is running, and until when", async () => {
    const superadmin = await createSuperadmin();
    const now = new Date();
    await getDb().insert(provider_calls).values({ provider: "vesselapi", called_at: now, purpose: "x", status: "429", vessels_requested: 1 });
    const body = (await get(makeApp(liveRuntime(now)), "/admin/tracking/budget", superadmin.id)).json();
    expect(new Date(body.backoffUntil).getTime()).toBeCloseTo(now.getTime() + 15 * MIN, -4);
  });

  it("reports the sample provider as not live", async () => {
    const superadmin = await createSuperadmin();
    const body = (await get(makeApp(), "/admin/tracking/budget", superadmin.id)).json();
    expect(body).toMatchObject({ provider: "sample", live: false, callsUsed: 0 });
  });
});

describe("no key in any response", () => {
  it("does not appear in the budget, refresh or position responses, or in the error for a refused request", async () => {
    const parties = await createTradeParties();
    await consignmentWith(parties, { mmsi: "100000001" });
    const superadmin = await createSuperadmin();
    const runtime = liveRuntime(new Date(), {}, () => new Response(`{"message":"bad ${FAKE_KEY}"}`, { status: 401 }));
    const app = makeApp(runtime);
    const bodies = [
      (await app.inject({ method: "POST", url: "/admin/positions/refresh", headers: { "x-dev-user": superadmin.id } })).body,
      (await get(app, "/admin/tracking/budget", superadmin.id)).body,
      (await get(app, "/positions", parties.importer.admin.id)).body,
      (await get(app, "/positions", superadmin.id)).body,
      (await get(app, "/admin/tracking/budget", parties.importer.admin.id)).body,
      (await get(app, "/admin/tracking/budget")).body,
    ];
    const everything = bodies.join("\n") + runtime.lines.join("\n") + JSON.stringify(await getDb().select().from(provider_calls)) + JSON.stringify(await getDb().select().from(tracking_runs));
    expect(everything).not.toContain(FAKE_KEY);
    expect(everything).not.toMatch(/SECRET|Bearer/);
  });

  it("does not appear on the consignment routes that now carry vessel fields", async () => {
    const parties = await createTradeParties();
    const c = await consignmentWith(parties, { mmsi: "100000001", imo: "9074729" });
    const runtime = liveRuntime(new Date());
    const app = makeApp(runtime);
    const { payload, contentType } = multipartForm({ exporterOrgId: parties.exporter.org.id, commodity: "x", originCountry: "BR", destinationCountry: "GB", vesselMmsi: "100000009" }, { name: "po.pdf", content: Buffer.from("po") });
    const created = await app.inject({ method: "POST", url: "/consignments", headers: { "content-type": contentType, "x-dev-user": parties.importer.admin.id }, payload });
    const all = [created.body, (await get(app, "/consignments", parties.importer.admin.id)).body, (await get(app, `/consignments/${c.id}`, parties.importer.admin.id)).body].join("\n");
    expect(all).not.toContain(FAKE_KEY);
  });
});
