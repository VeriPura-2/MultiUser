import { and, asc, desc, eq, gte, or, type SQL } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { consignments, vessel_positions, type Consignment } from "../db/schema.js";
import { UnprocessableEntityError } from "../errors.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";
import { UUID_PATTERN, consignmentNotFound, isPartyTo } from "./consignmentViews.js";

/**
 * Where each consignment's vessel is, read from our own database. Nothing here can reach a
 * position provider: it imports no provider code, so opening the dashboard, refetching, or
 * reloading the page cannot cost a provider call. Positions get into the database only through the
 * refresh job (src/tracking/refresh.ts).
 *
 * Visibility is exactly that of GET /consignments: a party to a consignment sees its position,
 * superadmin sees all, and a consignment the user cannot see is never mentioned (the single
 * endpoint answers 404, the list simply does not contain it).
 */

export type Freshness = "recent" | "stale" | "unavailable";
export type UnavailableReason = "no_vessel_identifier" | "no_position_received";

export interface TrailPoint {
  lat: number;
  lng: number;
  positionTime: Date;
}

export interface ConsignmentPosition {
  consignmentId: string;
  freshness: Freshness;
  /** Why there is no position, when freshness is "unavailable". Null otherwise. */
  reason: UnavailableReason | null;
  lat: number | null;
  lng: number | null;
  speedKnots: number | null;
  headingDeg: number | null;
  /** When the source says the position was reported. */
  positionTime: Date | null;
  /** How old the position is now, in whole seconds. Null when there is no position. */
  ageSeconds: number | null;
  /** True when the position is made-up demo data. It is never true for a real position. */
  isSample: boolean;
  /** The last 24 hours of positions, oldest first, at most 100 points. Left out when not asked for. */
  trail?: TrailPoint[];
}

export const TRAIL_HOURS = 24;
export const TRAIL_MAX_POINTS = 100;

/**
 * "recent" if the position is at most `recentMaxAgeSeconds` old (exactly that old still counts as
 * recent), "stale" if older, "unavailable" if there is no position at all.
 */
export function classifyFreshness(ageSeconds: number | null, recentMaxAgeSeconds: number): Freshness {
  if (ageSeconds === null) return "unavailable";
  return ageSeconds <= recentMaxAgeSeconds ? "recent" : "stale";
}

/** Whole seconds between a position and now. A position a moment ahead of our clock is treated as brand new, never negative. */
export function ageInSeconds(positionTime: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - positionTime.getTime()) / 1000));
}

/**
 * Thins a chronological list to at most `max` points by taking evenly spaced ones, always keeping
 * the first and the last so the line starts and ends where the vessel did.
 */
export function thinTrail<T>(points: T[], max: number = TRAIL_MAX_POINTS): T[] {
  if (points.length <= max) return points;
  if (max < 2) return points.slice(-max);
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round((i * (points.length - 1)) / (max - 1))]!);
  return out;
}

const NO_POSITION = { lat: null, lng: null, speedKnots: null, headingDeg: null, positionTime: null, ageSeconds: null, isSample: false } as const;

/** The condition that finds a vessel's positions: its MMSI, or its IMO, whichever the consignment has. */
function vesselMatch(c: Pick<Consignment, "vessel_imo" | "vessel_mmsi">): SQL | undefined {
  const parts = [c.vessel_mmsi ? eq(vessel_positions.vessel_mmsi, c.vessel_mmsi) : undefined, c.vessel_imo ? eq(vessel_positions.vessel_imo, c.vessel_imo) : undefined].filter(
    (x): x is SQL => x !== undefined,
  );
  return parts.length === 0 ? undefined : or(...parts);
}

async function positionFor(c: Consignment, now: Date, recentMaxAgeSeconds: number, withTrail: boolean): Promise<ConsignmentPosition> {
  const match = vesselMatch(c);
  if (!match) {
    return { consignmentId: c.id, freshness: "unavailable", reason: "no_vessel_identifier", ...NO_POSITION, ...(withTrail ? { trail: [] } : {}) };
  }
  const db = getDb();
  const [latest] = await db.select().from(vessel_positions).where(match).orderBy(desc(vessel_positions.position_time)).limit(1);
  if (!latest) {
    return { consignmentId: c.id, freshness: "unavailable", reason: "no_position_received", ...NO_POSITION, ...(withTrail ? { trail: [] } : {}) };
  }

  const ageSeconds = ageInSeconds(latest.position_time, now);
  const item: ConsignmentPosition = {
    consignmentId: c.id,
    freshness: classifyFreshness(ageSeconds, recentMaxAgeSeconds),
    reason: null,
    lat: latest.lat,
    lng: latest.lng,
    speedKnots: latest.speed_knots,
    headingDeg: latest.heading_deg,
    positionTime: latest.position_time,
    ageSeconds,
    isSample: latest.source === "sample",
  };

  if (withTrail) {
    const since = new Date(now.getTime() - TRAIL_HOURS * 3_600_000);
    const rows = await db
      .select({ lat: vessel_positions.lat, lng: vessel_positions.lng, positionTime: vessel_positions.position_time })
      .from(vessel_positions)
      .where(and(match, gte(vessel_positions.position_time, since)))
      .orderBy(asc(vessel_positions.position_time));
    // The same moment can be stored under the MMSI and under the IMO; draw it once.
    const seen = new Set<number>();
    const distinct = rows.filter((r) => {
      const t = r.positionTime.getTime();
      if (seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    item.trail = thinTrail(distinct);
  }
  return item;
}

export interface PositionOptions {
  /** From the tracking configuration. */
  recentMaxAgeSeconds: number;
  /** Include the last 24 hours of positions. Default true. */
  trail?: boolean;
  now?: Date;
}

/** Every consignment the user can see, each with its position or the reason it has none. Newest consignment first, as GET /consignments. */
export async function listPositions(actingUser: UserRef, options: PositionOptions): Promise<ConsignmentPosition[]> {
  const now = options.now ?? new Date();
  const actor = await loadActiveActor(actingUser);
  const rows = await getDb()
    .select()
    .from(consignments)
    .where(isSuperadmin(actor) ? undefined : or(eq(consignments.importer_org_id, actor.organization_id!), eq(consignments.exporter_org_id, actor.organization_id!)))
    .orderBy(desc(consignments.created_at), asc(consignments.id));
  const out: ConsignmentPosition[] = [];
  for (const c of rows) out.push(await positionFor(c, now, options.recentMaxAgeSeconds, options.trail ?? true));
  return out;
}

/** One consignment's position. A consignment the user cannot see, or that does not exist, is the same 404. */
export async function getPosition(consignmentId: string, actingUser: UserRef, options: PositionOptions): Promise<ConsignmentPosition> {
  const now = options.now ?? new Date();
  const actor = await loadActiveActor(actingUser);
  if (!UUID_PATTERN.test(consignmentId)) throw consignmentNotFound();
  const [c] = await getDb().select().from(consignments).where(eq(consignments.id, consignmentId));
  if (!c || !isPartyTo(actor, c)) throw consignmentNotFound();
  return positionFor(c, now, options.recentMaxAgeSeconds, options.trail ?? true);
}

/** Reads the `trail` query parameter: absent or "true" means yes, "false" means no, anything else is a 422. */
export function parseTrailParam(value: unknown): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new UnprocessableEntityError('trail must be "true" or "false".');
}

