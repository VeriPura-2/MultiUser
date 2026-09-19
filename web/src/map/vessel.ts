import type { PositionFreshness, PositionUnavailableReason } from "../api/types";
import { timeAgo } from "../format";
import type { LatLng } from "./geo";

/**
 * What the map needs to know about a consignment's vessel. The dashboard builds these from
 * GET /positions and the consignment list (see screens/dashboard/mapModel.ts). The sample file
 * web/src/sample/mapSample.ts builds the same shape for tests.
 */

/** The colour of a marker and its trail: from the consignment, not from how fresh the position is. */
export type VesselState = "issue" | "ok" | "done";

export interface MapVessel {
  id: string;
  label: string;
  commodity: string;
  routeLabel: string;
  state: VesselState;
  statusText: string;
  freshness: PositionFreshness;
  reason: PositionUnavailableReason | null;
  position: LatLng | null;
  /** The recent positions, oldest first. Drawn as a thin line. There is no planned route: the backend has none. */
  trail: LatLng[];
  positionTime: string | null;
  speedKnots: number | null;
  headingDeg: number | null;
  /** True when the position is made-up demo data. */
  isSample: boolean;
}

export const STATE_LABEL: Record<VesselState, string> = {
  issue: "Open issue",
  ok: "On track",
  done: "Cleared",
};

/** Has a position that can be drawn. An unavailable vessel has no marker. */
export const isDrawn = (v: MapVessel): boolean => v.freshness !== "unavailable" && v.position !== null;

export const isStale = (v: MapVessel): boolean => v.freshness === "stale";

/** Why there is no dot, in words. */
export function describeUnavailable(reason: PositionUnavailableReason | null): string {
  return reason === "no_vessel_identifier" ? "No vessel identifier on this consignment" : "No position received yet";
}

/**
 * The info line for a vessel: how old its last position is, and its speed and heading when known.
 * A stale position says "last known", so it is never worded as if it were live, and a sample one
 * says so.
 */
export function describePosition(v: MapVessel, now: number = Date.now()): string {
  if (!isDrawn(v)) return describeUnavailable(v.reason);
  const ago = v.positionTime ? timeAgo(v.positionTime, now) : "";
  const parts = [`${v.freshness === "stale" ? "Last known position" : "Last position"} ${ago}`.trim()];
  if (v.speedKnots !== null) parts.push(`${Math.round(v.speedKnots * 10) / 10} kn`);
  if (v.headingDeg !== null) parts.push(`heading ${Math.round(v.headingDeg)}°`);
  return parts.join(" · ") + (v.isSample ? " (sample)" : "");
}

export type FlagTone = "sample" | "live" | "stale" | "none";

/**
 * The flag on the map card. "Sample positions" whenever any position shown is made-up. Otherwise
 * "Live AIS", but only if at least one shown position is recent: stale positions are never called
 * live. All stale means "Last known positions", and nothing shown means there is nothing to flag.
 */
export function mapFlag(vessels: MapVessel[]): { text: string; tone: FlagTone } {
  const drawn = vessels.filter(isDrawn);
  if (drawn.some((v) => v.isSample)) return { text: "Sample positions", tone: "sample" };
  if (drawn.some((v) => v.freshness === "recent")) return { text: "Live AIS", tone: "live" };
  if (drawn.length > 0) return { text: "Last known positions", tone: "stale" };
  return { text: "No vessel positions", tone: "none" };
}
