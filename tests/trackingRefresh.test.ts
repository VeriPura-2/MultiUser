import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { consignments, provider_calls, tracking_runs, vessel_positions } from "../src/db/schema.js";
import { SAMPLE_VESSELS } from "../src/dev/seedDev.js";
import { buildApp } from "../src/http/app.js";
import { raiseIssue } from "../src/services/issues.js";
import { ingestPositions, pruneOldPositions } from "../src/tracking/ingest.js";
import { hasValidImoCheckDigit } from "../src/tracking/identifiers.js";
import type { VesselPositionReport } from "../src/tracking/provider.js";
import { createSampleRuntime, refreshNow, schedulerTick, startTrackingScheduler } from "../src/tracking/runtime.js";
import { scheduledCallAllowance } from "../src/tracking/refresh.js";
import { checklistItemsOf, createSuperadmin, createTradeParties, submitTestPO, type TradeParties } from "./helpers.js";
import { jsonResponse, liveRuntime } from "./trackingHelpers.js";

const NOW = new Date("2026-09-10T12:00:00Z");
const at = (base: Date, minutes: number) => new Date(base.getTime() + minutes * 60_000);
const calls = () => getDb().select().from(provider_calls);
const runs = () => getDb().select().from(tracking_runs);
const positions = () => getDb().select().from(vessel_positions);

type Vessel = { mmsi?: string; imo?: string };
async function withVessels(parties: TradeParties, vessels: Vessel[]) {
  const made = [];
  for (const v of vessels) made.push(await submitTestPO(parties, { vesselMmsi: v.mmsi, vesselImo: v.imo }));
  return made;
}
const mmsis = (n: number, start = 100000001) => Array.from({ length: n }, (_, i) => ({ mmsi: String(start + i) }));
const requestedIds = (r: { requests: Array<{ url: URL }> }) => r.requests.flatMap((q) => q.url.searchParams.get("filter.ids")!.split(","));

describe("the refresh does nothing when there is nothing to track", () => {
  it("with no vessel identifiers on any consignment: no request, no ledger row, no run, no position", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, [{}, {}]);
    for (const trigger of ["scheduled", "manual"] as const) {
      const runtime = liveRuntime(NOW);
      const summary = await refreshNow(runtime, trigger, NOW);
      expect(summary).toMatchObject({ ran: false, stoppedReason: "no_vessels", callsMade: 0, vesselsWithIdentifiers: 0 });
      expect(runtime.requests).toHaveLength(0);
    }
    expect(await calls()).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
    expect(await positions()).toHaveLength(0);
  });

  it("with no consignments at all", async () => {
    const runtime = liveRuntime(NOW);
    expect((await refreshNow(runtime, "scheduled", NOW)).stoppedReason).toBe("no_vessels");
    expect(runtime.requests).toHaveLength(0);
  });

  it("ignores consignments that are completed or cancelled", async () => {
    const parties = await createTradeParties();
    const [a, b, c] = await withVessels(parties, mmsis(3));
    await getDb().update(consignments).set({ status: "completed" }).where(eq(consignments.id, a!.id));
    await getDb().update(consignments).set({ status: "cancelled" }).where(eq(consignments.id, b!.id));
    const runtime = liveRuntime(NOW);
    const summary = await refreshNow(runtime, "manual", NOW);
    expect(summary).toMatchObject({ ran: true, vesselsSelected: 1 });
    expect(requestedIds(runtime)).toEqual(["100000003"]);
    void c;
  });

  it("the sample provider also does nothing without vessels", async () => {
    const summary = await refreshNow(createSampleRuntime(), "scheduled", NOW);
    expect(summary).toMatchObject({ ran: false, stoppedReason: "no_vessels" });
    expect(await positions()).toHaveLength(0);
  });
});

describe("a refresh with vessels", () => {
  it("asks once for all the vessels of one kind, stores what comes back, and records the run and the call", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, [...mmsis(2), { imo: "9074729" }]);
    const runtime = liveRuntime(NOW);
    const summary = await refreshNow(runtime, "scheduled", NOW);

    expect(summary).toMatchObject({ ran: true, stoppedReason: null, vesselsWithIdentifiers: 3, vesselsDue: 3, vesselsSelected: 3, callsMade: 2, positionsStored: 3, duplicates: 0 });
    expect(runtime.requests).toHaveLength(2); // one call for the two MMSIs, one for the IMO
    expect((await calls()).map((c) => [c.purpose, c.status, c.vessels_requested]).sort()).toEqual([["scheduled_refresh", "200", 1], ["scheduled_refresh", "200", 2]]);
    const [run] = await runs();
    expect(run).toMatchObject({ trigger: "scheduled", provider: "vesselapi", vessels_selected: 3, calls_made: 2, positions_stored: 3, stopped_reason: null, error: null });
    expect(run!.finished_at).not.toBeNull();
    const stored = await positions();
    expect(stored).toHaveLength(3);
    expect(stored.every((p) => p.source === "vesselapi")).toBe(true);
  });

  it("stores the position of a vessel entered by IMO under that IMO, so the consignment can find it", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, [{ imo: "9074729" }]);
    await refreshNow(liveRuntime(NOW), "manual", NOW);
    const [p] = await positions();
    expect(p!.vessel_imo).toBe("9074729");
  });

  it("asks about a vessel on two consignments once", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, [{ mmsi: "100000001" }, { mmsi: "100000001" }, { mmsi: "100000002" }]);
    const runtime = liveRuntime(NOW);
    expect((await refreshNow(runtime, "manual", NOW)).vesselsSelected).toBe(2);
    expect(requestedIds(runtime).sort()).toEqual(["100000001", "100000002"]);
  });

  it("does not ask again about a vessel whose position is recent, and asks again once it is older than the minimum age", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(2));
    const runtime = liveRuntime(NOW); // minimum age 720 minutes (12 hours) by default
    await refreshNow(runtime, "manual", NOW);
    expect(runtime.requests).toHaveLength(1);

    const soon = await refreshNow(runtime, "manual", at(NOW, 60));
    expect(soon).toMatchObject({ ran: false, stoppedReason: "nothing_due", vesselsDue: 0 });
    expect(runtime.requests).toHaveLength(1);

    // Positions were reported 5 minutes before NOW; after 12 hours 5 minutes they are old enough.
    const later = at(NOW, 12 * 60 + 5);
    const runtime2 = liveRuntime(later);
    expect((await refreshNow(runtime2, "manual", later)).vesselsSelected).toBe(2);
  });

  it("puts vessels on consignments with an open issue first, then those with no position, then the oldest positions", async () => {
    const parties = await createTradeParties();
    // Ids chosen so that plain id order would give a different answer from the rule.
    const [oldest, older, none, withIssue] = await withVessels(parties, mmsis(4)); // 100000001 .. 100000004
    const [first] = await checklistItemsOf(withIssue!);
    await raiseIssue({ documentChecklistItemId: first!.id, problem: "Something is wrong", responsibleOrgType: "exporter", actingUser: parties.importer.admin });
    const old = (mmsi: string, hoursAgo: number): VesselPositionReport => ({ mmsi, lat: 1, lng: 1, positionTime: at(NOW, -hoursAgo * 60), source: "vesselapi" });
    await ingestPositions([old("100000001", 48), old("100000002", 24)], { now: NOW });

    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1" });
    await refreshNow(runtime, "manual", NOW);
    // 100000004 has an open issue; 100000003 has no position; then the older position (100000001), then the newer.
    expect(requestedIds(runtime)).toEqual(["100000004", "100000003", "100000001", "100000002"]);
    void oldest;
    void older;
    void none;
  });

  it("a vessel on two consignments counts as having an open issue if either has one, whichever is listed first", async () => {
    const parties = await createTradeParties();
    const [withIssue, plain] = await withVessels(parties, [{ mmsi: "100000009" }, { mmsi: "100000009" }]);
    const [other] = await withVessels(parties, [{ mmsi: "100000001" }]);
    const [item] = await checklistItemsOf(withIssue!);
    await raiseIssue({ documentChecklistItemId: item!.id, problem: "Something is wrong", responsibleOrgType: "exporter", actingUser: parties.importer.admin });
    // Make the shared vessel's issue consignment the older one, so it is met first, then the plain one is met second.
    await getDb().update(consignments).set({ created_at: at(NOW, -60) }).where(eq(consignments.id, withIssue!.id));
    void plain;
    void other;
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1" });
    await refreshNow(runtime, "manual", NOW);
    expect(requestedIds(runtime)).toEqual(["100000009", "100000001"]); // the shared vessel has an issue, so it goes before 100000001
  });

  it("records a manual run as manual and a scheduled one as scheduled", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    await refreshNow(liveRuntime(NOW), "manual", NOW);
    await refreshNow(liveRuntime(at(NOW, 24 * 60)), "scheduled", at(NOW, 24 * 60));
    expect((await calls()).map((c) => c.purpose).sort()).toEqual(["manual_refresh", "scheduled_refresh"]);
    expect((await runs()).map((r) => r.trigger).sort()).toEqual(["manual", "scheduled"]);
  });
});

describe("the daily allowance", () => {
  it("is the budget, less the reserve and what was used before today, over the days left, less what today already used", async () => {
    const runtime = liveRuntime(NOW); // 150 budget, 15 reserve; September 10 has 21 days left counting today
    expect(await scheduledCallAllowance(runtime.ledger, runtime.config, NOW)).toBe(6); // floor(135 / 21)
    await getDb().insert(provider_calls).values([
      { provider: "vesselapi", called_at: at(NOW, -24 * 60), purpose: "x", status: "200", vessels_requested: 1 },
      { provider: "vesselapi", called_at: at(NOW, -24 * 60), purpose: "x", status: "200", vessels_requested: 1 },
      { provider: "vesselapi", called_at: at(NOW, -1), purpose: "x", status: "200", vessels_requested: 1 },
    ]);
    // Before today: 2 used, so floor((135 - 2) / 21) = 6; today already used 1, so 5 remain.
    expect(await scheduledCallAllowance(runtime.ledger, runtime.config, NOW)).toBe(5);
  });

  it("does not count today's calls twice: late in the month, with calls already made today, the allowance is exact", async () => {
    const late = new Date("2026-09-29T12:00:00Z"); // 2 days left counting today
    const runtime = liveRuntime(late);
    await getDb().insert(provider_calls).values(Array.from({ length: 3 }, () => ({ provider: "vesselapi", called_at: at(late, -60), purpose: "x", status: "200", vessels_requested: 1 })));
    // Nothing was used before today, so today's share is floor(135 / 2) = 67, and 3 of it is spent: 64 remain.
    expect(await scheduledCallAllowance(runtime.ledger, runtime.config, late)).toBe(64);
  });

  it("is never below zero, even when the reserve has been spent", async () => {
    const runtime = liveRuntime(NOW);
    await getDb().insert(provider_calls).values(Array.from({ length: 149 }, () => ({ provider: "vesselapi", called_at: at(NOW, -48 * 60), purpose: "x", status: "200", vessels_requested: 1 })));
    expect(await scheduledCallAllowance(runtime.ledger, runtime.config, NOW)).toBe(0);
  });

  it("caps a scheduled run at today's allowance even with far more vessels than calls", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(40));
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0" }); // 40 vessels, 1 per call: 40 calls wanted
    const summary = await refreshNow(runtime, "scheduled", NOW);
    expect(summary).toMatchObject({ ran: true, allowanceCalls: 6, callsMade: 6, vesselsSelected: 6 });
    expect(runtime.requests).toHaveLength(6);

    // Later the same day: nothing is left of today's allowance, so nothing is sent.
    const again = liveRuntime(at(NOW, 120), { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
    expect(await refreshNow(again, "scheduled", at(NOW, 120))).toMatchObject({ ran: false, stoppedReason: "allowance", allowanceCalls: 0 });
    expect(again.requests).toHaveLength(0);
    expect((await calls()).length).toBe(6);
  });

  it("over a whole month, a scheduled run each day never exceeds a day's allowance or the budget less the reserve, and is spread across the days", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(300)); // always more due than can be afforded
    const perDay: number[] = [];
    for (let day = 1; day <= 30; day++) {
      const now = new Date(Date.UTC(2026, 8, day, 12, 0, 0));
      const runtime = liveRuntime(now, { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
      const allowance = await scheduledCallAllowance(runtime.ledger, runtime.config, now);
      const before = (await calls()).length;
      await refreshNow(runtime, "scheduled", now);
      const made = (await calls()).length - before;
      expect(made, `day ${day}`).toBeLessThanOrEqual(allowance);
      perDay.push(made);
    }
    const total = perDay.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(135);
    expect(total).toBeGreaterThan(100); // it does use the plan, it does not sit idle
    expect(Math.max(...perDay)).toBeLessThanOrEqual(5);
    expect(perDay[0]).toBeLessThanOrEqual(4); // floor(135 / 30) on the first day: it does not front-load
    expect(perDay.every((n) => n > 0)).toBe(true);
  }, 120_000);

  it("does not limit a manual run to the daily allowance, but it still obeys the budget", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(40));
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0", VESSELAPI_MONTHLY_BUDGET: "30", VESSELAPI_RESERVE: "5" });
    const summary = await refreshNow(runtime, "manual", NOW);
    expect(summary.callsMade).toBe(30); // all of the plan, the reserve included, and not one more
    expect(summary.stoppedReason).toBe("budget");
    expect(runtime.requests).toHaveLength(30);
  });

  it("does not limit the sample provider, which calls nothing", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(40));
    const summary = await refreshNow(createSampleRuntime(), "scheduled", NOW);
    expect(summary).toMatchObject({ ran: true, vesselsSelected: 40, positionsStored: 40, allowanceCalls: null });
    expect(await calls()).toHaveLength(0);
    expect((await positions()).every((p) => p.source === "sample")).toBe(true);
  });
});

describe("a scheduled run is never sooner than the minimum interval after the last, even across restarts", () => {
  it("skips a second scheduled run within the interval and allows one after it", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(2));
    const runtime = liveRuntime(NOW, { TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
    await refreshNow(runtime, "scheduled", NOW);
    const restarted = liveRuntime(at(NOW, 30), { TRACKING_MIN_POSITION_AGE_MINUTES: "0" }); // a new process; only the database remembers
    expect(await refreshNow(restarted, "scheduled", at(NOW, 30))).toMatchObject({ ran: false, stoppedReason: "too_soon" });
    expect(restarted.requests).toHaveLength(0);
    const later = liveRuntime(at(NOW, 61), { TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
    expect((await refreshNow(later, "scheduled", at(NOW, 61))).ran).toBe(true);
  });

  it("does not hold up a manual run", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    await refreshNow(liveRuntime(NOW, { TRACKING_MIN_POSITION_AGE_MINUTES: "0" }), "scheduled", NOW);
    const manual = liveRuntime(at(NOW, 5), { TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
    expect((await refreshNow(manual, "manual", at(NOW, 5))).ran).toBe(true);
  });
});

describe("when the provider or the budget stops a run", () => {
  it("stops at the first refused call, keeps what it already stored, and records why", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(5));
    await getDb().insert(provider_calls).values(Array.from({ length: 13 }, () => ({ provider: "vesselapi", called_at: NOW, purpose: "seed", status: "200", vessels_requested: 1 })));
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1", VESSELAPI_MONTHLY_BUDGET: "15", VESSELAPI_RESERVE: "0", TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
    const summary = await refreshNow(runtime, "manual", NOW);
    expect(summary).toMatchObject({ callsMade: 2, positionsStored: 2, stoppedReason: "budget" });
    expect(runtime.requests).toHaveLength(2);
    const [run] = await runs();
    expect(run).toMatchObject({ calls_made: 2, positions_stored: 2, stopped_reason: "budget" });
    expect(run!.error).toMatch(/13 of 15 calls used|15 of 15|call refused/);
  });

  it("on a 429 stops at once (no second request), and the next run backs off without a request", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(3));
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0" }, () => new Response("{}", { status: 429 }));
    expect(await refreshNow(runtime, "manual", NOW)).toMatchObject({ stoppedReason: "provider_error", callsMade: 1 });
    expect(runtime.requests).toHaveLength(1);

    const next = liveRuntime(at(NOW, 5), { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0" });
    expect(await refreshNow(next, "manual", at(NOW, 5))).toMatchObject({ stoppedReason: "backoff", callsMade: 0 });
    expect(next.requests).toHaveLength(0);
  });

  it("on a server error stops without hammering, and stores nothing", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(3));
    const runtime = liveRuntime(NOW, { VESSELAPI_BATCH_SIZE: "1", TRACKING_MIN_POSITION_AGE_MINUTES: "0" }, () => new Response("{}", { status: 503 }));
    expect(await refreshNow(runtime, "manual", NOW)).toMatchObject({ stoppedReason: "provider_error", positionsStored: 0 });
    expect(runtime.requests).toHaveLength(1);
    expect(await positions()).toHaveLength(0);
  });

  it("a failing provider never breaks the scheduled tick: it is caught, and the next tick still works", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    const runtime = liveRuntime(NOW, {}, () => Promise.reject(new Error("socket hang up")));
    await expect(schedulerTick(runtime, NOW)).resolves.toMatchObject({ stoppedReason: "provider_error" });
    const errors: string[] = [];
    const broken = { ...runtime, provider: { ...runtime.provider, planRequests: () => { throw new Error("boom"); } } as never, log: { info: () => {}, warn: () => {}, error: (m: string) => errors.push(m) } };
    await expect(schedulerTick(broken, at(NOW, 1440))).resolves.toBeNull();
    expect(errors.join()).toMatch(/scheduled tick failed: boom/);
  });
});

describe("storing positions", () => {
  const report = (over: Partial<VesselPositionReport> = {}): VesselPositionReport => ({ mmsi: "100000001", lat: 10, lng: 20, positionTime: new Date("2026-09-10T11:00:00Z"), source: "test", ...over });

  it("stores each position once: the same vessel and reported time twice is a duplicate, not a second row", async () => {
    expect(await ingestPositions([report()], { now: NOW })).toEqual({ inserted: 1, duplicates: 0 });
    expect(await ingestPositions([report({ lat: 11 })], { now: NOW })).toEqual({ inserted: 0, duplicates: 1 });
    expect(await positions()).toHaveLength(1);
    expect((await positions())[0]!.lat).toBe(10); // the first one stands
  });

  it("deduplicates within one batch, and across vessels, times and identifiers", async () => {
    const result = await ingestPositions([
      report(),
      report(),
      report({ positionTime: new Date("2026-09-10T11:01:00Z") }),
      report({ mmsi: "100000002" }),
      report({ mmsi: undefined, imo: "9074729" }),
      report({ mmsi: undefined, imo: "9074729" }),
    ], { now: NOW });
    expect(result).toEqual({ inserted: 4, duplicates: 2 });
  });

  it("keeps the speed, heading and status, and stamps when it was received", async () => {
    await ingestPositions([report({ speedKnots: 12, headingDeg: 90, navStatus: 5 })], { now: NOW });
    const [p] = await positions();
    expect(p).toMatchObject({ speed_knots: 12, heading_deg: 90, nav_status: 5, vessel_mmsi: "100000001", vessel_imo: null, source: "test" });
    expect(p!.received_at.toISOString()).toBe(NOW.toISOString());
  });

  it("handles an empty list", async () => {
    expect(await ingestPositions([], { now: NOW })).toEqual({ inserted: 0, duplicates: 0 });
  });

  it("runs the refresh twice with the same provider answer and stores each position once", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(2));
    const fixed = (mmsi: string) => ({ mmsi: Number(mmsi), imo: null, latitude: 50, longitude: -1, timestamp: "2026-09-10T11:55:00Z", sog: 10, heading: 10, nav_status: 0, suspected_glitch: false });
    const respond = (req: { url: URL }) => jsonResponse({ vesselPositions: req.url.searchParams.get("filter.ids")!.split(",").map(fixed) });
    await refreshNow(liveRuntime(NOW, { TRACKING_MIN_POSITION_AGE_MINUTES: "0" }, respond as never), "manual", NOW);
    const second = await refreshNow(liveRuntime(at(NOW, 5), { TRACKING_MIN_POSITION_AGE_MINUTES: "0" }, respond as never), "manual", at(NOW, 5));
    expect(second).toMatchObject({ positionsStored: 0, duplicates: 2 });
    expect(await positions()).toHaveLength(2);
  });
});

describe("keeping 72 hours of history", () => {
  const p = (mmsi: string, hoursAgo: number): VesselPositionReport => ({ mmsi, lat: 1, lng: 1, positionTime: new Date(NOW.getTime() - hoursAgo * 3_600_000), source: "test" });

  it("deletes positions older than 72 hours and keeps the rest, at the boundary", async () => {
    await ingestPositions([p("100000001", 73), p("100000002", 72.01), p("100000003", 72), p("100000004", 71.99), p("100000005", 1)], { now: NOW });
    expect(await pruneOldPositions(NOW)).toBe(2);
    expect((await positions()).map((r) => r.vessel_mmsi).sort()).toEqual(["100000003", "100000004", "100000005"]);
  });

  it("is done by every scheduled tick, before the refresh", async () => {
    await ingestPositions([p("100000001", 80)], { now: NOW });
    await schedulerTick(createSampleRuntime(), NOW);
    expect(await positions()).toHaveLength(0);
  });

  it("removes nothing when nothing is old", async () => {
    await ingestPositions([p("100000001", 1)], { now: NOW });
    expect(await pruneOldPositions(NOW)).toBe(0);
  });
});

describe("POST /admin/positions/refresh", () => {
  const app = (runtime = createSampleRuntime()) => buildApp({ actor: { allowDevActorHeader: true }, tracking: runtime });
  const post = (a: ReturnType<typeof app>, actorId?: string) => a.inject({ method: "POST", url: "/admin/positions/refresh", headers: actorId ? { "x-dev-user": actorId } : {} });

  it("is a 401 with no user, and a 403 for anyone who is not a superadmin, and asks nothing of the provider", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    const runtime = liveRuntime(NOW);
    const a = app(runtime);
    expect((await post(a)).statusCode).toBe(401);
    expect((await post(a, parties.importer.admin.id)).statusCode).toBe(403);
    expect((await post(a, parties.exporter.admin.id)).statusCode).toBe(403);
    expect(runtime.requests).toHaveLength(0);
    expect(await calls()).toHaveLength(0);
  });

  it("lets a superadmin run one refresh and says what it did", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(2));
    const superadmin = await createSuperadmin();
    const runtime = liveRuntime(NOW);
    const res = await post(app(runtime), superadmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ trigger: "manual", provider: "vesselapi", ran: true, vesselsSelected: 2, callsMade: 1, positionsStored: 2 });
    expect(runtime.requests).toHaveLength(1);
    // The response is a summary of counts: no key, no request, no raw provider data.
    expect(JSON.stringify(res.json())).not.toMatch(/SECRET|Bearer|latitude/);
  });

  it("still obeys the budget: with the month's allowance spent it answers 200 and sends nothing", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(2));
    const superadmin = await createSuperadmin();
    const runtime = liveRuntime(new Date(), { VESSELAPI_MONTHLY_BUDGET: "10", VESSELAPI_RESERVE: "2" });
    await getDb().insert(provider_calls).values(Array.from({ length: 10 }, () => ({ provider: "vesselapi", called_at: new Date(), purpose: "seed", status: "200", vessels_requested: 1 })));
    const res = await post(app(runtime), superadmin.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ stoppedReason: "budget", callsMade: 0 });
    expect(runtime.requests).toHaveLength(0);
  });

  it("presses twice and the second costs nothing, because the positions are already recent", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(2));
    const superadmin = await createSuperadmin();
    const runtime = liveRuntime(new Date());
    const a = app(runtime);
    await post(a, superadmin.id);
    const second = await post(a, superadmin.id);
    expect(second.json()).toMatchObject({ ran: false, stoppedReason: "nothing_due" });
    expect(runtime.requests).toHaveLength(1);
  });

  it("an app built with no runtime uses sample positions, whatever the environment says", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    const superadmin = await createSuperadmin();
    const res = await post(buildApp({ actor: { allowDevActorHeader: true } }), superadmin.id);
    expect(res.json()).toMatchObject({ provider: "sample", ran: true, positionsStored: 1 });
    expect((await positions())[0]!.source).toBe("sample");
    expect(await calls()).toHaveLength(0);
  });
});

describe("the scheduler", () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("runs a tick after its first delay when enabled: it prunes and refreshes", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    const runtime = createSampleRuntime();
    const handle = startTrackingScheduler(runtime, { initialDelayMs: 20 });
    await wait(600);
    handle.stop();
    expect(await positions()).toHaveLength(1);
    expect((await runs()).map((r) => r.trigger)).toEqual(["scheduled"]);
  });

  it("starts nothing at all when disabled, however long it waits", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    const off = createSampleRuntime();
    off.config.refreshEnabled = false;
    const handle = startTrackingScheduler(off, { initialDelayMs: 20 });
    await wait(600);
    handle.stop();
    expect(await positions()).toHaveLength(0);
    expect(await runs()).toHaveLength(0);
  });

  it("can be stopped before its first tick, and then never runs", async () => {
    const parties = await createTradeParties();
    await withVessels(parties, mmsis(1));
    const handle = startTrackingScheduler(createSampleRuntime(), { initialDelayMs: 200 });
    handle.stop();
    await wait(600);
    expect(await runs()).toHaveLength(0);
  });
});

describe("the seeded sample vessels", () => {
  it("are valid identifiers that cannot belong to a real ship", () => {
    expect(SAMPLE_VESSELS.length).toBeGreaterThanOrEqual(3);
    for (const v of SAMPLE_VESSELS) {
      expect(hasValidImoCheckDigit(v.vesselImo), v.vesselImo).toBe(true);
      expect(v.vesselImo.startsWith("1")).toBe(true); // IMO numbers this low have not been issued
      expect(v.vesselMmsi.startsWith("999")).toBe(true); // not an allocated MMSI prefix
    }
    expect(new Set(SAMPLE_VESSELS.map((v) => v.vesselMmsi)).size).toBe(SAMPLE_VESSELS.length);
  });
});
