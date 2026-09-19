import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { provider_calls } from "../src/db/schema.js";
import { BACKOFF_BASE_SECONDS, BACKOFF_CAP_SECONDS, CallLedger, CallRefusedError, daysLeftInMonth, dayStartUtc, monthStartUtc } from "../src/tracking/budget.js";
import { captureLog } from "./trackingHelpers.js";

const NOW = new Date("2026-09-10T12:00:00Z");
const ledger = (over: Partial<{ monthlyBudget: number; reserve: number }> = {}, log = captureLog()) =>
  Object.assign(new CallLedger({ provider: "vesselapi", monthlyBudget: 150, reserve: 15, ...over }, log.log), { lines: log.lines });

/** Puts n completed calls at a time, as if they had been made. */
async function seedCalls(n: number, at: Date, status = "200", provider = "vesselapi") {
  if (n === 0) return;
  await getDb().insert(provider_calls).values(Array.from({ length: n }, () => ({ provider, called_at: at, purpose: "seed", status, vessels_requested: 1 })));
}
const begin = (l: CallLedger, over: Partial<Parameters<CallLedger["begin"]>[0]> = {}) => l.begin({ purpose: "test", vesselsRequested: 1, now: NOW, ...over });
const count = async () => (await getDb().select().from(provider_calls)).length;

describe("calendar helpers", () => {
  it("find the start of the UTC month and day, and the days left counting today", () => {
    expect(monthStartUtc(new Date("2026-09-30T23:59:59Z")).toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(dayStartUtc(new Date("2026-09-10T23:59:59Z")).toISOString()).toBe("2026-09-10T00:00:00.000Z");
    expect(daysLeftInMonth(new Date("2026-09-01T00:00:00Z"))).toBe(30);
    expect(daysLeftInMonth(new Date("2026-09-30T23:59:59Z"))).toBe(1);
    expect(daysLeftInMonth(new Date("2026-02-15T00:00:00Z"))).toBe(14); // February 2026 has 28 days
    expect(daysLeftInMonth(new Date("2028-02-15T00:00:00Z"))).toBe(15); // and a leap year 29
  });
});

describe("the call budget", () => {
  it("allows a call when used plus one plus the reserve fits in the budget, and refuses the next one", async () => {
    const l = ledger(); // 150 budget, 15 reserve: at most 135 automatic calls
    await seedCalls(134, NOW);
    await expect(begin(l)).resolves.toBeDefined(); // the 135th: 134 + 1 + 15 = 150, not over
    await expect(begin(l)).rejects.toMatchObject({ name: "CallRefusedError", reason: "budget" }); // 135 + 1 + 15 = 151 > 150
  });

  it("counts only this provider's calls", async () => {
    await seedCalls(500, NOW, "200", "someone_else");
    await expect(begin(ledger())).resolves.toBeDefined();
  });

  it("writes the call before it is sent, as started, and finishes it with the outcome", async () => {
    const l = ledger();
    const { id } = await begin(l, { purpose: "scheduled_refresh", vesselsRequested: 7 });
    let [row] = await getDb().select().from(provider_calls).where(eq(provider_calls.id, id));
    expect(row).toMatchObject({ provider: "vesselapi", purpose: "scheduled_refresh", status: "started", vessels_requested: 7 });
    expect(row!.called_at.toISOString()).toBe(NOW.toISOString());
    await l.finish(id, "200");
    [row] = await getDb().select().from(provider_calls).where(eq(provider_calls.id, id));
    expect(row!.status).toBe("200");
  });

  it("counts failed calls and calls that never got an answer", async () => {
    const l = ledger();
    await seedCalls(100, NOW, "500");
    await seedCalls(20, NOW, "timeout");
    await seedCalls(14, NOW, "network_error");
    await seedCalls(0, NOW);
    await expect(begin(l)).resolves.toBeDefined(); // 134 used, this is the 135th
    await expect(begin(l)).rejects.toBeInstanceOf(CallRefusedError);
    expect((await l.status(NOW)).used).toBe(135);
  });

  it("counts a call that was started and never finished (a crash), so it cannot be forgotten", async () => {
    const l = ledger();
    await begin(l); // never finished
    expect((await l.status(NOW)).used).toBe(1);
  });

  it("starts again on a new calendar month, in UTC, and not before", async () => {
    const l = ledger();
    await seedCalls(135, new Date("2026-08-31T23:59:59Z"));
    await expect(begin(l, { now: new Date("2026-08-31T23:59:59Z") })).rejects.toBeInstanceOf(CallRefusedError);
    await expect(begin(l, { now: new Date("2026-09-01T00:00:00Z") })).resolves.toBeDefined(); // a new month: nothing used yet
    // Calls from late last month do not count against this one.
    expect((await l.status(new Date("2026-09-01T00:00:01Z"))).used).toBe(1);
  });

  it("holds the reserve back from an automatic call, but a manual call may use it, and nothing may pass the budget", async () => {
    const l = ledger();
    await seedCalls(135, NOW);
    await expect(begin(l)).rejects.toMatchObject({ reason: "budget" });
    for (let i = 0; i < 15; i++) await expect(begin(l, { allowReserve: true })).resolves.toBeDefined(); // calls 136 to 150
    await expect(begin(l, { allowReserve: true })).rejects.toMatchObject({ reason: "budget" }); // 151 would pass the budget
    expect((await l.status(NOW)).used).toBe(150);
  });

  it("refuses without writing a row", async () => {
    const l = ledger();
    await seedCalls(135, NOW);
    await expect(begin(l)).rejects.toThrow();
    expect(await count()).toBe(135);
  });

  it("cannot be overspent by callers at the same moment", async () => {
    const l = ledger({ monthlyBudget: 20, reserve: 0 });
    await seedCalls(10, NOW);
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => begin(l)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(10); // exactly the 10 that were left
    expect(await count()).toBe(20);
  });

  it("reports its status, with the reserve held back from what a scheduled run may still use", async () => {
    const l = ledger();
    await seedCalls(40, NOW);
    expect(await l.status(NOW)).toEqual({ provider: "vesselapi", used: 40, budget: 150, reserve: 15, automaticRemaining: 95, remaining: 110, percentUsed: 26.7 });
    await seedCalls(120, NOW);
    expect(await l.status(NOW)).toMatchObject({ used: 160, automaticRemaining: 0, remaining: 0 }); // never negative
  });

  it("warns at 80 percent, and not before", async () => {
    const l = ledger({ monthlyBudget: 100, reserve: 0 });
    await seedCalls(78, NOW);
    await begin(l); // 79
    expect(l.lines).toEqual([]);
    await begin(l); // 80
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0]).toMatch(/80 of 100 calls used this month \(80 percent\)/);
    await begin(l); // 81
    expect(l.lines).toHaveLength(2);
  });
});

describe("back-off after a 429", () => {
  it("refuses every call, without spending one, until the wait is over", async () => {
    const l = ledger();
    const { id } = await begin(l);
    await l.finish(id, "429");
    const soon = new Date(NOW.getTime() + 60_000);
    const refused = await begin(l, { now: soon }).catch((e) => e);
    expect(refused).toBeInstanceOf(CallRefusedError);
    expect(refused).toMatchObject({ reason: "backoff" });
    expect(refused.until.toISOString()).toBe(new Date(NOW.getTime() + BACKOFF_BASE_SECONDS * 1000).toISOString());
    expect(await count()).toBe(1);
    await expect(begin(l, { now: new Date(NOW.getTime() + BACKOFF_BASE_SECONDS * 1000 + 1) })).resolves.toBeDefined();
  });

  it("waits longer for each 429 in a row, up to a cap", async () => {
    const l = ledger();
    let t = NOW;
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const { id } = await begin(l, { now: t });
      await l.finish(id, "429");
      const until = await l.backoffUntil(t);
      waits.push((until!.getTime() - t.getTime()) / 1000);
      t = new Date(until!.getTime() + 1000);
    }
    expect(waits).toEqual([900, 1800, 3600, 7200, 14400, BACKOFF_CAP_SECONDS]);
  });

  it("honours a longer Retry-After than its own schedule, and remembers it across a restart", async () => {
    const first = ledger();
    const { id } = await begin(first);
    await first.finish(id, "429", 3 * 3600);
    const afterRestart = ledger(); // a new instance, as after a restart: only the database remembers
    const until = await afterRestart.backoffUntil(new Date(NOW.getTime() + 60_000));
    expect(until!.toISOString()).toBe(new Date(NOW.getTime() + 3 * 3600 * 1000).toISOString());
    await expect(begin(afterRestart, { now: new Date(NOW.getTime() + 3600_000) })).rejects.toMatchObject({ reason: "backoff" });
  });

  it("ends the moment a call succeeds, so the next 429 starts again from the shortest wait", async () => {
    const l = ledger();
    const a = await begin(l);
    await l.finish(a.id, "429");
    const t = new Date(NOW.getTime() + BACKOFF_BASE_SECONDS * 1000 + 1000);
    const b = await begin(l, { now: t });
    await l.finish(b.id, "200");
    expect(await l.backoffUntil(t)).toBeNull();
    const t2 = new Date(t.getTime() + 1000); // a later moment, so the order of the rows is unambiguous
    const c = await begin(l, { now: t2 });
    await l.finish(c.id, "429");
    expect(((await l.backoffUntil(t2))!.getTime() - t2.getTime()) / 1000).toBe(BACKOFF_BASE_SECONDS);
  });

  it("is not triggered by other failures", async () => {
    const l = ledger();
    for (const status of ["500", "401", "timeout", "network_error", "404"]) {
      const { id } = await begin(l);
      await l.finish(id, status);
      expect(await l.backoffUntil(NOW), status).toBeNull();
    }
  });
});
