import { createHash } from "node:crypto";
import { pointAndBearingAlong, routeThrough, type LatLng } from "./geo.js";
import {
  normalisePositions,
  silentLogger,
  type FetchContext,
  type Logger,
  type VesselIdentifier,
  type VesselPositionProvider,
  type VesselPositionReport,
} from "./provider.js";

/**
 * Made-up positions for demos and tests. Nothing here is a real vessel: every position is tagged
 * source "sample", and the map says so. It calls nothing, costs nothing, and is the default
 * provider everywhere (development, tests, and any machine where live data is not switched on).
 *
 * Deterministic: the same vessel identifier at the same moment always gets the same position, so
 * tests are exact. A vessel is placed on one of a few routes (great circles through open-water
 * waypoints, ending in the English Channel) and moves along it as time passes, finishing a
 * crossing in about two weeks. The age of the position also depends on the identifier: most
 * report a few minutes ago, and one in four last reported hours ago, so the "stale" state can be
 * seen without waiting for real coverage gaps.
 */

const SOURCE = "sample";
const CROSSING_DAYS = 14;

const ROUTES: LatLng[][] = [
  // Brazil to the United Kingdom
  routeThrough([[-24.0, -46.3], [-5.5, -33.5], [14.0, -24.0], [38.0, -12.5], [47.0, -7.5], [49.6, -4.0], [50.9, -1.4]]),
  // Argentina to the United Kingdom
  routeThrough([[-34.6, -58.4], [-36.0, -52.0], [-30.0, -43.0], [-5.5, -33.5], [14.0, -24.0], [38.0, -12.5], [47.0, -7.5], [49.6, -4.0], [50.9, -1.4]]),
  // Ireland to the United Kingdom
  routeThrough([[53.3, -6.3], [52.0, -5.6], [50.1, -5.9], [50.3, -3.2], [50.9, -1.4]]),
];

/** A stable number from an identifier, so the same vessel is always placed the same way. */
function seedFor(id: VesselIdentifier): number {
  const digest = createHash("sha256").update(`${id.mmsi ?? ""}|${id.imo ?? ""}`).digest();
  return digest.readUInt32BE(0);
}

export class SampleProvider implements VesselPositionProvider {
  readonly name = "sample";
  readonly live = false;

  constructor(private readonly log: Logger = silentLogger) {}

  planRequests(ids: VesselIdentifier[]): VesselIdentifier[][] {
    return ids.length === 0 ? [] : [ids];
  }

  async fetchPositions(ids: VesselIdentifier[], context: FetchContext): Promise<VesselPositionReport[]> {
    const now = context.now ?? new Date();
    const raws = ids
      .filter((id) => id.imo || id.mmsi)
      .map((id) => {
        const seed = seedFor(id);
        const route = ROUTES[seed % ROUTES.length]!;
        const start = ((seed >>> 8) % 1000) / 1000;
        const elapsedDays = now.getTime() / 86_400_000;
        const progress = (start + elapsedDays / CROSSING_DAYS) % 1;
        const { point, bearing } = pointAndBearingAlong(route, progress);
        // One vessel in four last reported hours ago; the rest a few minutes ago.
        const stale = (seed >>> 20) % 4 === 3;
        const ageMinutes = stale ? 240 + ((seed >>> 4) % 300) : 3 + ((seed >>> 4) % 25);
        return {
          imo: id.imo,
          mmsi: id.mmsi,
          lat: point[0],
          lng: point[1],
          speedKnots: 11 + ((seed >>> 12) % 70) / 10,
          headingDeg: Math.round(bearing * 10) / 10,
          navStatus: 0,
          positionTime: new Date(now.getTime() - ageMinutes * 60_000),
          source: SOURCE,
        };
      });
    return normalisePositions(raws, now, this.log, this.name);
  }
}
