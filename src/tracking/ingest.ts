import { lt } from "drizzle-orm";
import { getDb, type DbExecutor } from "../db/client.js";
import { vessel_positions } from "../db/schema.js";
import { HISTORY_HOURS } from "./config.js";
import type { VesselPositionReport } from "./provider.js";

/**
 * Writes validated positions to vessel_positions. Re-storing a position we already have (same
 * vessel, same reported time) is harmless: the unique indexes turn it into a no-op, and it is
 * counted as a duplicate rather than an insert. Callers pass positions that have already been
 * validated by the provider layer (see validatePosition).
 */
export async function ingestPositions(
  reports: VesselPositionReport[],
  options: { now?: Date; db?: DbExecutor } = {},
): Promise<{ inserted: number; duplicates: number }> {
  if (reports.length === 0) return { inserted: 0, duplicates: 0 };
  const db = options.db ?? getDb();
  const receivedAt = options.now ?? new Date();
  let inserted = 0;

  for (let i = 0; i < reports.length; i += 500) {
    const chunk = reports.slice(i, i + 500);
    const rows = await db
      .insert(vessel_positions)
      .values(
        chunk.map((r) => ({
          vessel_imo: r.imo ?? null,
          vessel_mmsi: r.mmsi ?? null,
          lat: r.lat,
          lng: r.lng,
          speed_knots: r.speedKnots ?? null,
          heading_deg: r.headingDeg ?? null,
          nav_status: r.navStatus ?? null,
          position_time: r.positionTime,
          received_at: receivedAt,
          source: r.source,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: vessel_positions.id });
    inserted += rows.length;
  }
  return { inserted, duplicates: reports.length - inserted };
}

/** Deletes positions reported more than 72 hours ago. Returns how many were removed. */
export async function pruneOldPositions(now: Date = new Date(), db: DbExecutor = getDb()): Promise<number> {
  const cutoff = new Date(now.getTime() - HISTORY_HOURS * 3_600_000);
  const removed = await db.delete(vessel_positions).where(lt(vessel_positions.position_time, cutoff)).returning({ id: vessel_positions.id });
  return removed.length;
}
