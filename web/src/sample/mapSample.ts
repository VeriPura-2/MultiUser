import { pointAlong, routeThrough, type LatLng } from "../map/geo";
import type { MapVessel } from "../map/vessel";

/**
 * A FIXTURE, not a data source. The dashboard no longer imports this file: its map is fed by
 * GET /positions (real positions, or the backend's sample provider, which flags them isSample).
 * It is kept for tests and for looking at the map in isolation, and every vessel here says it is
 * sample data. Nothing here is a real ship or a real consignment.
 */

const SANTOS: LatLng = [-24.0, -46.3];
const DUBLIN: LatLng = [53.3, -6.3];
const SOUTHAMPTON: LatLng = [50.9, -1.4];
const OFF_RECIFE: LatLng = [-5.5, -33.5];
const OFF_CAPE_VERDE: LatLng = [14.0, -24.0];
const OFF_PORTUGAL: LatLng = [38.0, -12.5];
const BAY_OF_BISCAY: LatLng = [47.0, -7.5];
const CHANNEL_APPROACH: LatLng = [49.6, -4.0];

const atlantic = routeThrough([SANTOS, OFF_RECIFE, OFF_CAPE_VERDE, OFF_PORTUGAL, BAY_OF_BISCAY, CHANNEL_APPROACH, SOUTHAMPTON]);
const irishSea = routeThrough([DUBLIN, [52.0, -5.6], [50.1, -5.9], [50.3, -3.2], SOUTHAMPTON]);

/** The route sailed so far: every point of the path up to a fraction of its length. */
function sailed(path: LatLng[], fraction: number): LatLng[] {
  const here = pointAlong(path, fraction);
  const behind = path.filter((_, i) => i / (path.length - 1) < fraction);
  return [...behind, here];
}

function vessel(fields: Omit<MapVessel, "position" | "trail" | "isSample" | "reason"> & { path: LatLng[]; progress: number; reason?: MapVessel["reason"] }): MapVessel {
  const { path, progress, reason, ...rest } = fields;
  const trail = sailed(path, progress);
  return { ...rest, reason: reason ?? null, position: trail[trail.length - 1]!, trail, isSample: true };
}

export const SAMPLE_VESSELS: MapVessel[] = [
  vessel({
    id: "sample-a",
    label: "Sample A",
    commodity: "Frozen boneless beef",
    routeLabel: "Brazil to United Kingdom",
    state: "issue",
    statusText: "In review, 2 open issues",
    freshness: "recent",
    positionTime: "2026-09-19T11:48:00.000Z",
    speedKnots: 14.2,
    headingDeg: 21,
    path: atlantic,
    progress: 0.62,
  }),
  vessel({
    id: "sample-b",
    label: "Sample B",
    commodity: "Chilled ribeye primals",
    routeLabel: "Brazil to United Kingdom",
    state: "ok",
    statusText: "Active",
    freshness: "recent",
    positionTime: "2026-09-19T11:53:00.000Z",
    speedKnots: 12.6,
    headingDeg: 18,
    path: atlantic,
    progress: 0.84,
  }),
  vessel({
    id: "sample-c",
    label: "Sample C",
    commodity: "Frozen lamb legs",
    routeLabel: "Argentina to United Kingdom",
    state: "issue",
    statusText: "In review, 1 open issue",
    freshness: "stale",
    positionTime: "2026-09-19T03:00:00.000Z",
    speedKnots: 11.1,
    headingDeg: 30,
    path: atlantic,
    progress: 0.4,
  }),
  vessel({
    id: "sample-d",
    label: "Sample D",
    commodity: "Frozen beef trim",
    routeLabel: "Ireland to United Kingdom",
    state: "done",
    statusText: "Active",
    freshness: "recent",
    positionTime: "2026-09-19T11:57:00.000Z",
    speedKnots: 9.8,
    headingDeg: 95,
    path: irishSea,
    progress: 0.85,
  }),
  // A consignment with no vessel identifier: no marker, and the info line says why.
  {
    id: "sample-e",
    label: "Sample E",
    commodity: "Frozen poultry",
    routeLabel: "Brazil to United Kingdom",
    state: "ok",
    statusText: "Awaiting checklist",
    freshness: "unavailable",
    reason: "no_vessel_identifier",
    position: null,
    trail: [],
    positionTime: null,
    speedKnots: null,
    headingDeg: null,
    isSample: false,
  },
];
