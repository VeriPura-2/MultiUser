import type { LatLng } from "./geo";

/**
 * What the map needs to know about a vessel. There is no tracking source yet (that is a later
 * stage), so the only producer of these today is web/src/sample/mapSample.ts. When a real source
 * exists it should produce this same shape.
 */

export type VesselState = "issue" | "ok" | "done";

export interface Vessel {
  id: string;
  /** What the chip and the label under the marker say. */
  label: string;
  commodity: string;
  routeLabel: string;
  state: VesselState;
  /** Short status text for the info line, for example "In transit, on track". */
  statusText: string;
  position: LatLng;
  /** The whole route, port to port, as points to draw. */
  path: LatLng[];
  /** How long ago the position was reported. */
  positionAgeMinutes: number;
}

/** A position older than this is drawn as a hollow marker and worded as "no recent position". */
export const STALE_AFTER_MINUTES = 180;

export const isStale = (vessel: Pick<Vessel, "positionAgeMinutes">): boolean =>
  vessel.positionAgeMinutes >= STALE_AFTER_MINUTES;

/** "Last position 12 min ago", or, when the position is old, that there is none recent. */
export function describePosition(vessel: Pick<Vessel, "positionAgeMinutes">): string {
  const minutes = vessel.positionAgeMinutes;
  if (isStale(vessel)) {
    const hours = Math.floor(minutes / 60);
    return `No position for ${hours} h, showing last known`;
  }
  return `Last position ${minutes} min ago`;
}

export const STATE_LABEL: Record<VesselState, string> = {
  issue: "Open issue",
  ok: "On track",
  done: "Cleared",
};
