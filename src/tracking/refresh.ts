import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { consignments, issues, tracking_runs, vessel_positions } from "../db/schema.js";
import { CallRefusedError, daysLeftInMonth, type CallLedger } from "./budget.js";
import type { TrackingConfig } from "./config.js";
import { redact } from "./config.js";
import { ingestPositions } from "./ingest.js";
import { ProviderError, silentLogger, type Logger, type VesselIdentifier, type VesselPositionProvider } from "./provider.js";

/**
 * The refresh job: decides which vessels are worth asking the provider about, asks in as few calls
 * as the provider allows, and stores what comes back. It is the ONLY code that calls a provider.
 * Nothing that serves a request (the dashboard, GET /positions, a page reload) ever reaches it.
 *
 * Which vessels: those on live consignments (not completed or cancelled) that have an MMSI or IMO,
 * and whose latest stored position is older than the per-vessel minimum age (or that have none).
 * Ordered so vessels on consignments with an open issue come first, then those with no position,
 * then the oldest positions.
 *
 * How many calls: a scheduled run on a provider with a quota may spend at most today's allowance,
 * which is (budget, minus the reserve, minus what was used before today) divided by the days left
 * in the month counting today, less what today has already used. The ledger then enforces the
 * budget itself on every call. A manual run skips the daily allowance (it is a person's decision)
 * but not the per-vessel minimum age, and may use the reserve; it still cannot pass the budget.
 */

export type RefreshTrigger = "scheduled" | "manual";

export type StoppedReason =
  | "no_vessels" // no live consignment has a vessel identifier: nothing was done
  | "nothing_due" // vessels exist but all have a recent enough position
  | "too_soon" // a scheduled run happened less than the minimum interval ago
  | "allowance" // today's allowance is spent
  | "budget" // the ledger refused a call
  | "backoff" // a 429 back-off is running
  | "provider_error" // the provider failed
  | "error"; // something unexpected

export interface RefreshSummary {
  trigger: RefreshTrigger;
  provider: string;
  ran: boolean;
  stoppedReason: StoppedReason | null;
  vesselsWithIdentifiers: number;
  vesselsDue: number;
  vesselsSelected: number;
  callsMade: number;
  positionsStored: number;
  duplicates: number;
  /** Calls that today's allowance permitted at the start of a scheduled run on a live provider. */
  allowanceCalls: number | null;
}

export interface RefreshDeps {
  provider: VesselPositionProvider;
  config: TrackingConfig;
  ledger: CallLedger;
  log?: Logger;
  now?: Date;
  trigger: RefreshTrigger;
}

interface Candidate {
  id: VesselIdentifier;
  imo: string | null;
  mmsi: string | null;
  hasOpenIssue: boolean;
  latest: Date | null;
}

const LIVE_STATUSES_EXCLUDED = ["completed", "cancelled"] as const;

async function candidates(): Promise<Candidate[]> {
  const db = getDb();
  const rows = await db
    .select({ id: consignments.id, imo: consignments.vessel_imo, mmsi: consignments.vessel_mmsi })
    .from(consignments)
    .where(
      and(
        notInArray(consignments.status, [...LIVE_STATUSES_EXCLUDED]),
        or(sql`${consignments.vessel_imo} IS NOT NULL`, sql`${consignments.vessel_mmsi} IS NOT NULL`),
      ),
    )
    // A fixed order, so which consignment is met first (and so how a shared vessel is merged) never depends on how rows sit on disk.
    .orderBy(asc(consignments.created_at), asc(consignments.id));
  if (rows.length === 0) return [];

  const withIssue = new Set(
    (
      await db
        .select({ consignmentId: issues.consignment_id })
        .from(issues)
        .where(and(inArray(issues.consignment_id, rows.map((r) => r.id)), sql`${issues.status} <> 'resolved'`))
    ).map((r) => r.consignmentId),
  );

  // One entry per vessel, however many consignments it carries.
  const byVessel = new Map<string, Candidate>();
  for (const r of rows) {
    const key = r.mmsi ? `m:${r.mmsi}` : `i:${r.imo}`;
    const existing = byVessel.get(key);
    const hasOpenIssue = withIssue.has(r.id);
    if (existing) {
      existing.hasOpenIssue ||= hasOpenIssue;
      continue;
    }
    byVessel.set(key, { id: r.mmsi ? { mmsi: r.mmsi } : { imo: r.imo! }, imo: r.imo, mmsi: r.mmsi, hasOpenIssue, latest: null });
  }

  for (const c of byVessel.values()) {
    const conditions = [c.mmsi ? eq(vessel_positions.vessel_mmsi, c.mmsi) : undefined, c.imo ? eq(vessel_positions.vessel_imo, c.imo) : undefined].filter(
      (x): x is NonNullable<typeof x> => x !== undefined,
    );
    const [latest] = await db
      .select({ t: vessel_positions.position_time })
      .from(vessel_positions)
      .where(or(...conditions))
      .orderBy(desc(vessel_positions.position_time))
      .limit(1);
    c.latest = latest?.t ?? null;
  }
  return [...byVessel.values()];
}

/** How many calls a scheduled run may make now, by the daily allowance rule. */
export async function scheduledCallAllowance(ledger: CallLedger, config: TrackingConfig, now: Date): Promise<number> {
  const usedMonth = await ledger.usedThisMonth(now);
  const usedToday = await ledger.usedToday(now);
  const availableAtStartOfToday = config.monthlyBudget - config.reserve - (usedMonth - usedToday);
  const dailyAllowance = Math.max(0, Math.floor(availableAtStartOfToday / daysLeftInMonth(now)));
  return Math.max(0, dailyAllowance - usedToday);
}

export async function runRefresh(deps: RefreshDeps): Promise<RefreshSummary> {
  const { provider, config, ledger, trigger } = deps;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? new Date();
  const summary: RefreshSummary = {
    trigger,
    provider: provider.name,
    ran: false,
    stoppedReason: null,
    vesselsWithIdentifiers: 0,
    vesselsDue: 0,
    vesselsSelected: 0,
    callsMade: 0,
    positionsStored: 0,
    duplicates: 0,
    allowanceCalls: null,
  };

  // A scheduled run never comes sooner than the minimum interval after the last one, even across restarts.
  if (trigger === "scheduled") {
    const [last] = await getDb().select().from(tracking_runs).where(eq(tracking_runs.trigger, "scheduled")).orderBy(desc(tracking_runs.started_at)).limit(1);
    if (last && now.getTime() - last.started_at.getTime() < config.refreshMinIntervalMinutes * 60_000) {
      return { ...summary, stoppedReason: "too_soon" };
    }
  }

  const all = await candidates();
  summary.vesselsWithIdentifiers = all.length;
  if (all.length === 0) return { ...summary, stoppedReason: "no_vessels" };

  const minAgeMs = config.minPositionAgeMinutes * 60_000;
  const due = all.filter((c) => c.latest === null || now.getTime() - c.latest.getTime() >= minAgeMs);
  summary.vesselsDue = due.length;
  if (due.length === 0) return { ...summary, stoppedReason: "nothing_due" };

  due.sort((a, b) => {
    if (a.hasOpenIssue !== b.hasOpenIssue) return a.hasOpenIssue ? -1 : 1;
    if ((a.latest === null) !== (b.latest === null)) return a.latest === null ? -1 : 1;
    if (a.latest && b.latest && a.latest.getTime() !== b.latest.getTime()) return a.latest.getTime() - b.latest.getTime();
    return JSON.stringify(a.id).localeCompare(JSON.stringify(b.id));
  });

  let groups = provider.planRequests(due.map((c) => c.id));
  if (provider.live && trigger === "scheduled") {
    const allowed = await scheduledCallAllowance(ledger, config, now);
    summary.allowanceCalls = allowed;
    groups = groups.slice(0, allowed);
    if (groups.length === 0) return { ...summary, stoppedReason: "allowance" };
  }
  summary.vesselsSelected = groups.reduce((n, g) => n + g.length, 0);

  const [run] = await getDb()
    .insert(tracking_runs)
    .values({ trigger, provider: provider.name, started_at: now, vessels_selected: summary.vesselsSelected })
    .returning({ id: tracking_runs.id });
  summary.ran = true;

  let error: string | null = null;
  for (const group of groups) {
    try {
      const positions = await provider.fetchPositions(group, {
        purpose: trigger === "manual" ? "manual_refresh" : "scheduled_refresh",
        allowReserve: trigger === "manual",
        now,
      });
      summary.callsMade++;
      const stored = await ingestPositions(positions, { now });
      summary.positionsStored += stored.inserted;
      summary.duplicates += stored.duplicates;
    } catch (e) {
      if (e instanceof CallRefusedError) {
        summary.stoppedReason = e.reason;
        error = e.message;
      } else if (e instanceof ProviderError) {
        summary.callsMade++; // a request was made, even though it failed
        summary.stoppedReason = "provider_error";
        error = e.message;
      } else {
        summary.stoppedReason = "error";
        error = redact((e as Error).message ?? "unknown error", [config.vesselApiKey]);
      }
      log.warn(`tracking: stopped the ${trigger} refresh: ${error}`);
      break;
    }
  }

  await getDb()
    .update(tracking_runs)
    .set({
      finished_at: new Date(),
      calls_made: summary.callsMade,
      positions_stored: summary.positionsStored,
      stopped_reason: summary.stoppedReason,
      error,
    })
    .where(eq(tracking_runs.id, run!.id));
  return summary;
}
