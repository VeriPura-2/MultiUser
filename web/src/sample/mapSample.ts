import { pointAlong, routeThrough, type LatLng } from "../map/geo";
import type { Vessel } from "../map/vessel";

/**
 * SAMPLE DATA. Nothing here is a real vessel or a real consignment: there is no tracking source in
 * the system yet, so the dashboard map shows these illustrative positions, and says so on screen
 * ("Sample positions"). Ids are deliberately unlike consignment references so nobody mistakes a
 * sample for a shipment they could open.
 *
 * When a real tracking source exists, replace this file's use in the dashboard with one that maps
 * that source to `Vessel`; nothing else about the map needs to change.
 */

const SANTOS: LatLng = [-24.0, -46.3];
const BUENOS_AIRES: LatLng = [-34.6, -58.4];
const DUBLIN: LatLng = [53.3, -6.3];
const SOUTHAMPTON: LatLng = [50.9, -1.4];

/** Open-water waypoints so the arcs stay at sea instead of cutting across land. */
const OFF_RECIFE: LatLng = [-5.5, -33.5];
const OFF_CAPE_VERDE: LatLng = [14.0, -24.0];
const OFF_PORTUGAL: LatLng = [38.0, -12.5];
const BAY_OF_BISCAY: LatLng = [47.0, -7.5];
const CHANNEL_APPROACH: LatLng = [49.6, -4.0];

const santosToSouthampton = routeThrough([SANTOS, OFF_RECIFE, OFF_CAPE_VERDE, OFF_PORTUGAL, BAY_OF_BISCAY, CHANNEL_APPROACH, SOUTHAMPTON]);
const buenosAiresToSouthampton = routeThrough([
  BUENOS_AIRES,
  [-36.0, -52.0],
  [-30.0, -43.0],
  OFF_RECIFE,
  OFF_CAPE_VERDE,
  OFF_PORTUGAL,
  BAY_OF_BISCAY,
  CHANNEL_APPROACH,
  SOUTHAMPTON,
]);
const dublinToSouthampton = routeThrough([DUBLIN, [52.0, -5.6], [50.1, -5.9], [50.3, -3.2], SOUTHAMPTON]);

function vessel(fields: Omit<Vessel, "position"> & { progress: number }): Vessel {
  const { progress, ...rest } = fields;
  return { ...rest, position: pointAlong(fields.path, progress) };
}

export const SAMPLE_VESSELS: Vessel[] = [
  vessel({
    id: "sample-a",
    label: "Sample A",
    commodity: "Frozen boneless beef",
    routeLabel: "Brazil to United Kingdom",
    state: "issue",
    statusText: "In transit, open issues",
    path: santosToSouthampton,
    progress: 0.62,
    positionAgeMinutes: 12,
  }),
  vessel({
    id: "sample-b",
    label: "Sample B",
    commodity: "Chilled ribeye primals",
    routeLabel: "Brazil to United Kingdom",
    state: "ok",
    statusText: "In transit, on track",
    path: santosToSouthampton,
    progress: 0.84,
    positionAgeMinutes: 7,
  }),
  vessel({
    id: "sample-c",
    label: "Sample C",
    commodity: "Frozen lamb legs",
    routeLabel: "Argentina to United Kingdom",
    state: "issue",
    statusText: "In transit, open issue",
    path: buenosAiresToSouthampton,
    progress: 0.4,
    positionAgeMinutes: 9 * 60,
  }),
  vessel({
    id: "sample-d",
    label: "Sample D",
    commodity: "Frozen beef trim",
    routeLabel: "Ireland to United Kingdom",
    state: "done",
    statusText: "Nearly arrived, cleared",
    path: dublinToSouthampton,
    progress: 0.85,
    positionAgeMinutes: 3,
  }),
];
