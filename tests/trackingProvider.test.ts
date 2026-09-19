import { describe, expect, it } from "vitest";
import { pointAndBearingAlong, routeThrough, distance, bearing } from "../src/tracking/geo.js";
import { FUTURE_TOLERANCE_MS, normalisePositions, validatePosition, type Logger, type RawPosition } from "../src/tracking/provider.js";
import { SampleProvider } from "../src/tracking/sampleProvider.js";

const NOW = new Date("2026-09-10T12:00:00Z");
const good = (over: Partial<RawPosition> = {}): RawPosition => ({
  mmsi: "235012345",
  lat: 50,
  lng: -1,
  positionTime: new Date(NOW.getTime() - 5 * 60_000),
  source: "test",
  ...over,
});
const recorder = () => {
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
  return { lines, log };
};

describe("validatePosition", () => {
  it("keeps a good position and carries the fields through", () => {
    const p = validatePosition(good({ speedKnots: 12.5, headingDeg: 270, navStatus: 0, imo: "9074729" }), NOW)!;
    expect(p).toMatchObject({ mmsi: "235012345", imo: "9074729", lat: 50, lng: -1, speedKnots: 12.5, headingDeg: 270, navStatus: 0, source: "test" });
    expect(p.positionTime.toISOString()).toBe("2026-09-10T11:55:00.000Z");
  });

  it("accepts the edges of the latitude and longitude ranges and refuses anything past them", () => {
    for (const [lat, lng] of [[90, 180], [-90, -180], [0, 0]]) expect(validatePosition(good({ lat, lng }), NOW), `${lat},${lng}`).not.toBeNull();
    for (const [lat, lng] of [[90.0001, 0], [-90.0001, 0], [0, 180.0001], [0, -180.0001], [91, 0], [0, 181]]) {
      expect(validatePosition(good({ lat, lng }), NOW), `${lat},${lng}`).toBeNull();
    }
  });

  it("refuses a latitude or longitude that is missing, not a number, or not finite", () => {
    for (const bad of [undefined, null, "50", NaN, Infinity, -Infinity, {}]) {
      expect(validatePosition(good({ lat: bad }), NOW), `lat ${String(bad)}`).toBeNull();
      expect(validatePosition(good({ lng: bad }), NOW), `lng ${String(bad)}`).toBeNull();
    }
  });

  it("allows a time up to a minute ahead of now and refuses one more than a minute ahead", () => {
    expect(validatePosition(good({ positionTime: new Date(NOW.getTime() + FUTURE_TOLERANCE_MS) }), NOW)).not.toBeNull();
    expect(validatePosition(good({ positionTime: new Date(NOW.getTime() + FUTURE_TOLERANCE_MS + 1) }), NOW)).toBeNull();
    expect(validatePosition(good({ positionTime: new Date(NOW.getTime() + 3_600_000) }), NOW)).toBeNull();
    expect(FUTURE_TOLERANCE_MS).toBe(60_000);
  });

  it("reads the time from a Date, an ISO string or a number of milliseconds, and refuses anything unreadable", () => {
    const iso = "2026-09-10T11:00:00Z";
    expect(validatePosition(good({ positionTime: iso }), NOW)!.positionTime.toISOString()).toBe("2026-09-10T11:00:00.000Z");
    expect(validatePosition(good({ positionTime: Date.parse(iso) }), NOW)!.positionTime.toISOString()).toBe("2026-09-10T11:00:00.000Z");
    for (const bad of [undefined, null, "not a time", "", NaN, {}, new Date("nope")]) {
      expect(validatePosition(good({ positionTime: bad }), NOW), String(bad)).toBeNull();
    }
  });

  it("needs a usable vessel identifier, and drops a malformed one instead of storing it", () => {
    expect(validatePosition(good({ mmsi: undefined }), NOW)).toBeNull();
    expect(validatePosition(good({ mmsi: "12345" }), NOW)).toBeNull(); // wrong length, and nothing else to identify it
    expect(validatePosition(good({ mmsi: "12345", imo: "9074729" }), NOW)).toMatchObject({ imo: "9074729" });
    expect(validatePosition(good({ mmsi: "12345", imo: "9074729" }), NOW)!.mmsi).toBeUndefined();
    expect(validatePosition(good({ mmsi: undefined, imo: "9074728" }), NOW)).toBeNull(); // check digit wrong
    expect(validatePosition(good({ mmsi: 235012345 }), NOW)).toBeNull(); // must arrive as text
  });

  it("leaves out an optional field that is out of range but keeps the position", () => {
    const p = validatePosition(good({ speedKnots: -1, headingDeg: 511, navStatus: 1.5 }), NOW)!;
    expect(p).not.toBeNull();
    expect(p.speedKnots).toBeUndefined();
    expect(p.headingDeg).toBeUndefined(); // AIS uses 511 for "not available"
    expect(p.navStatus).toBeUndefined();
    expect(validatePosition(good({ headingDeg: 359.9, speedKnots: 0 }), NOW)).toMatchObject({ headingDeg: 359.9, speedKnots: 0 });
    expect(validatePosition(good({ headingDeg: 360 }), NOW)!.headingDeg).toBeUndefined();
  });
});

describe("normalisePositions", () => {
  it("drops the bad ones and logs how many, never what they contained", () => {
    const { lines, log } = recorder();
    const kept = normalisePositions([good(), good({ lat: 200, mmsi: "111111111" }), good({ mmsi: "222222222" }), good({ positionTime: "junk", mmsi: "333333333" })], NOW, log, "unit");
    expect(kept.map((p) => p.mmsi)).toEqual(["235012345", "222222222"]);
    expect(lines).toEqual(["warn unit: dropped 2 of 4 positions that failed validation."]);
    expect(lines.join(" ")).not.toMatch(/111111111|333333333/);
  });

  it("logs nothing when everything is good, and copes with an empty list", () => {
    const { lines, log } = recorder();
    expect(normalisePositions([good()], NOW, log, "unit")).toHaveLength(1);
    expect(normalisePositions([], NOW, log, "unit")).toEqual([]);
    expect(lines).toEqual([]);
  });
});

describe("SampleProvider", () => {
  const provider = new SampleProvider();
  const ids = [{ mmsi: "999000001" }, { mmsi: "999000002" }, { imo: "1000007" }, { mmsi: "999000004", imo: "1300005" }];

  it("is not live, and plans everything as one request (it calls nothing)", () => {
    expect(provider.live).toBe(false);
    expect(provider.planRequests(ids)).toEqual([ids]);
    expect(provider.planRequests([])).toEqual([]);
  });

  it("gives every vessel a valid position tagged sample, with speed and heading", async () => {
    const positions = await provider.fetchPositions(ids, { purpose: "test", now: NOW });
    expect(positions).toHaveLength(ids.length);
    for (const p of positions) {
      expect(p.source).toBe("sample");
      expect(validatePosition({ ...p }, NOW), JSON.stringify(p)).not.toBeNull();
      expect(p.speedKnots).toBeGreaterThan(10);
      expect(p.headingDeg).toBeGreaterThanOrEqual(0);
      expect(p.positionTime.getTime()).toBeLessThan(NOW.getTime());
    }
  });

  it("is deterministic: the same vessel at the same moment is always in the same place, and different vessels differ", async () => {
    const a = await provider.fetchPositions(ids, { purpose: "test", now: NOW });
    const b = await new SampleProvider().fetchPositions(ids, { purpose: "test", now: NOW });
    expect(b).toEqual(a);
    expect(new Set(a.map((p) => `${p.lat},${p.lng}`)).size).toBe(ids.length);
  });

  it("moves along its route as time passes", async () => {
    const [before] = await provider.fetchPositions([ids[0]!], { purpose: "test", now: NOW });
    const [after] = await provider.fetchPositions([ids[0]!], { purpose: "test", now: new Date(NOW.getTime() + 86_400_000) });
    expect(distance([before!.lat, before!.lng], [after!.lat, after!.lng])).toBeGreaterThan(0.001);
  });

  it("makes some vessels stale and most recent, so both states can be seen", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ mmsi: String(999100000 + i) }));
    const positions = await provider.fetchPositions(many, { purpose: "test", now: NOW });
    const ages = positions.map((p) => (NOW.getTime() - p.positionTime.getTime()) / 60_000);
    expect(ages.filter((a) => a < 120).length).toBeGreaterThan(20);
    expect(ages.filter((a) => a >= 120).length).toBeGreaterThan(3);
  });

  it("ignores an identifier with neither number", async () => {
    expect(await provider.fetchPositions([{}], { purpose: "test", now: NOW })).toEqual([]);
  });
});

describe("geo helpers", () => {
  it("routeThrough starts and ends on its waypoints, and pointAndBearingAlong stays between them", () => {
    const route = routeThrough([[0, 0], [0, 10], [10, 10]], 6);
    expect(route[0]).toEqual([0, 0]);
    expect(route[route.length - 1]![0]).toBeCloseTo(10, 6);
    const mid = pointAndBearingAlong(route, 0.25);
    expect(mid.point[1]).toBeGreaterThan(0);
    expect(mid.point[1]).toBeLessThan(10);
    expect(mid.bearing).toBeCloseTo(90, 0); // due east along the equator
  });

  it("bearing is a compass direction from 0 up to 360", () => {
    expect(bearing([0, 0], [1, 0])).toBeCloseTo(0, 5);
    expect(bearing([0, 0], [0, 1])).toBeCloseTo(90, 5);
    expect(bearing([0, 0], [-1, 0])).toBeCloseTo(180, 5);
    expect(bearing([0, 0], [0, -1])).toBeCloseTo(270, 5);
  });
});
