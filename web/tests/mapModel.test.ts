import { describe, expect, it } from "vitest";
import { describePosition, describeUnavailable, isDrawn, mapFlag, type MapVessel } from "../src/map/vessel";
import { buildMapVessels, vesselState } from "../src/screens/dashboard/mapModel";
import { consignment, noPosition, positionItem } from "./fixtures";

const NOW = Date.parse("2026-09-19T12:00:00Z");
const vessel = (over: Partial<MapVessel> = {}): MapVessel => ({
  id: "v",
  label: "#V",
  commodity: "Beef",
  routeLabel: "Brazil to United Kingdom",
  state: "ok",
  statusText: "Active",
  freshness: "recent",
  reason: null,
  position: [50, -1],
  trail: [],
  positionTime: "2026-09-19T11:48:00Z",
  speedKnots: 12.5,
  headingDeg: 88,
  isSample: false,
  ...over,
});

describe("vesselState", () => {
  it("is red with an open issue, cleared when every document is verified, and on track otherwise", () => {
    expect(vesselState(consignment({ openIssueCount: 1, checklistCompleteness: { verified: 4, total: 4 } }))).toBe("issue");
    expect(vesselState(consignment({ checklistCompleteness: { verified: 4, total: 4 } }))).toBe("done");
    expect(vesselState(consignment({ checklistCompleteness: { verified: 3, total: 4 } }))).toBe("ok");
    expect(vesselState(consignment({ checklistCompleteness: { verified: 0, total: 0 } }))).toBe("ok"); // nothing to verify is not "cleared"
  });
});

describe("buildMapVessels", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const C = "cccccccc-0000-4000-8000-000000000003";

  it("makes one entry per live consignment, in the list's order, and leaves finished ones out", () => {
    const list = [consignment({ id: A }), consignment({ id: B, status: "completed" }), consignment({ id: C, status: "cancelled" }), consignment({ id: "dddddddd-0000-4000-8000-000000000004", status: "po_submitted" })];
    expect(buildMapVessels(list, []).map((v) => v.label)).toEqual(["#AAAAAAAA", "#DDDDDDDD"]);
  });

  it("draws a vessel only where the server gave a position, and never invents one", () => {
    const list = [consignment({ id: A }), consignment({ id: B }), consignment({ id: C })];
    const built = buildMapVessels(list, [positionItem(A, { lat: 10, lng: 20 }), noPosition(B, "no_vessel_identifier")]);
    expect(built[0]).toMatchObject({ freshness: "recent", position: [10, 20], reason: null });
    expect(built[1]).toMatchObject({ freshness: "unavailable", position: null, reason: "no_vessel_identifier", trail: [], isSample: false, speedKnots: null });
    // A consignment the server said nothing about is "no position received", not a made-up dot.
    expect(built[2]).toMatchObject({ freshness: "unavailable", position: null, reason: "no_position_received" });
  });

  it("carries the freshness, the sample flag, the speed and the heading through unchanged", () => {
    const [v] = buildMapVessels([consignment({ id: A })], [positionItem(A, { freshness: "stale", isSample: true, speedKnots: 9.4, headingDeg: 300 })]);
    expect(v).toMatchObject({ freshness: "stale", isSample: true, speedKnots: 9.4, headingDeg: 300 });
  });

  it("turns the trail into coordinates, oldest first, and has no route from origin to destination", () => {
    const trail = [{ lat: 1, lng: 2, positionTime: "2026-09-19T10:00:00Z" }, { lat: 3, lng: 4, positionTime: "2026-09-19T11:00:00Z" }];
    const [v] = buildMapVessels([consignment({ id: A, originCountry: "BR", destinationCountry: "GB" })], [positionItem(A, { lat: 3, lng: 4, trail })]);
    expect(v!.trail).toEqual([[1, 2], [3, 4]]);
    expect(v!.position).toEqual([3, 4]);
  });

  it("gives the label, commodity, route in words, and status with the number of open issues", () => {
    const [v] = buildMapVessels([consignment({ id: A, commodity: "Frozen beef", originCountry: "AR", destinationCountry: "GB", openIssueCount: 2, status: "checklist_received" })], []);
    expect(v).toMatchObject({ label: "#AAAAAAAA", commodity: "Frozen beef", routeLabel: "Argentina to United Kingdom", statusText: "In review, 2 open issues", state: "issue" });
    expect(buildMapVessels([consignment({ id: A, openIssueCount: 1 })], [])[0]!.statusText).toMatch(/1 open issue$/);
    expect(buildMapVessels([consignment({ id: A })], [])[0]!.statusText).toBe("In review");
  });
});

describe("describePosition", () => {
  it("gives the age, speed and heading, rounding speed to a tenth and heading to a degree", () => {
    expect(describePosition(vessel({ speedKnots: 12.54, headingDeg: 87.6 }), NOW)).toBe("Last position 12 minutes ago · 12.5 kn · heading 88°");
  });

  it("calls a stale position the last known one", () => {
    expect(describePosition(vessel({ freshness: "stale", positionTime: "2026-09-19T07:00:00Z" }), NOW)).toBe("Last known position 5 hours ago · 12.5 kn · heading 88°");
  });

  it("marks a sample position, and leaves out speed and heading that are not known", () => {
    expect(describePosition(vessel({ isSample: true, speedKnots: null, headingDeg: null }), NOW)).toBe("Last position 12 minutes ago (sample)");
  });

  it("keeps a speed of zero, which is a real reading (a ship at anchor)", () => {
    expect(describePosition(vessel({ speedKnots: 0, headingDeg: 0 }), NOW)).toBe("Last position 12 minutes ago · 0 kn · heading 0°");
  });

  it("says why there is no position for an unavailable vessel", () => {
    expect(describePosition(vessel({ freshness: "unavailable", reason: "no_vessel_identifier", position: null }), NOW)).toBe("No vessel identifier on this consignment");
    expect(describePosition(vessel({ freshness: "unavailable", reason: "no_position_received", position: null }), NOW)).toBe("No position received yet");
    expect(describeUnavailable(null)).toBe("No position received yet");
  });
});

describe("mapFlag", () => {
  it("is Sample positions if any drawn position is sample", () => {
    expect(mapFlag([vessel(), vessel({ isSample: true, freshness: "stale" })])).toEqual({ text: "Sample positions", tone: "sample" });
  });

  it("ignores a sample flag on a vessel that is not drawn", () => {
    expect(mapFlag([vessel(), vessel({ isSample: true, freshness: "unavailable", position: null })])).toEqual({ text: "Live AIS", tone: "live" });
  });

  it("is Live AIS only when a drawn real position is recent, and never for stale data", () => {
    expect(mapFlag([vessel()])).toEqual({ text: "Live AIS", tone: "live" });
    expect(mapFlag([vessel({ freshness: "stale" })])).toEqual({ text: "Last known positions", tone: "stale" });
    expect(mapFlag([vessel({ freshness: "stale" }), vessel()]).text).toBe("Live AIS");
  });

  it("says there is nothing to show when nothing is drawn", () => {
    expect(mapFlag([])).toEqual({ text: "No vessel positions", tone: "none" });
    expect(mapFlag([vessel({ freshness: "unavailable", position: null })])).toEqual({ text: "No vessel positions", tone: "none" });
  });

  it("isDrawn needs both a fresh-enough state and coordinates", () => {
    expect(isDrawn(vessel())).toBe(true);
    expect(isDrawn(vessel({ freshness: "unavailable" }))).toBe(false);
    expect(isDrawn(vessel({ position: null }))).toBe(false);
  });
});
