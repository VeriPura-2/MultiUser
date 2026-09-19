import { and, desc, eq, gte, sql } from "drizzle-orm";
import { getDb, type DbExecutor } from "../db/client.js";
import { provider_calls } from "../db/schema.js";
import { silentLogger, type Logger } from "./provider.js";

/**
 * The call budget for a provider with a monthly allowance (VesselAPI's free plan: 150 calls).
 *
 * The rule, checked from the provider_calls table before EVERY call, never from memory:
 *   a call may be made only if (calls used this calendar month, UTC) + 1 + reserve <= budget.
 * So with the defaults (150 and 15) at most 135 calls a month are made automatically. The reserve
 * is held back for people: a manual call may use it, but nothing may ever pass the budget itself.
 *
 * Every call is written to the table before it is sent and finished afterwards, and failed calls
 * count like any other, because the provider's own rule for failed calls is not certain (its
 * documentation says only 2xx responses count against the quota, and this is deliberately stricter).
 * A 429 also sets a back-off that survives a restart, because it is read from the same table.
 */

export type LedgerRefusal = "budget" | "backoff";

export class CallRefusedError extends Error {
  constructor(
    message: string,
    readonly reason: LedgerRefusal,
    readonly until?: Date,
  ) {
    super(message);
    this.name = "CallRefusedError";
  }
}

export interface LedgerConfig {
  provider: string;
  monthlyBudget: number;
  reserve: number;
}

/** 1st of the month, 00:00 UTC. */
export const monthStartUtc = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
export const dayStartUtc = (now: Date): Date => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Days left in the month counting today, so on the last day it is 1. */
export function daysLeftInMonth(now: Date): number {
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return daysInMonth - now.getUTCDate() + 1;
}

/** After a 429: wait at least this long, doubling for each 429 in a row, and never more than the cap. */
export const BACKOFF_BASE_SECONDS = 15 * 60;
export const BACKOFF_CAP_SECONDS = 6 * 60 * 60;

export interface BudgetStatus {
  provider: string;
  used: number;
  budget: number;
  reserve: number;
  /** Calls a scheduled run may still make this month: budget - reserve - used, never below zero. */
  automaticRemaining: number;
  /** Calls left at all, reserve included. */
  remaining: number;
  percentUsed: number;
}

export class CallLedger {
  constructor(
    private readonly config: LedgerConfig,
    private readonly log: Logger = silentLogger,
  ) {}

  async usedSince(since: Date, db: DbExecutor = getDb()): Promise<number> {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(provider_calls)
      .where(and(eq(provider_calls.provider, this.config.provider), gte(provider_calls.called_at, since)));
    return row?.n ?? 0;
  }

  usedThisMonth(now: Date): Promise<number> {
    return this.usedSince(monthStartUtc(now));
  }

  usedToday(now: Date): Promise<number> {
    return this.usedSince(dayStartUtc(now));
  }

  async status(now: Date): Promise<BudgetStatus> {
    const used = await this.usedThisMonth(now);
    const { monthlyBudget: budget, reserve } = this.config;
    return {
      provider: this.config.provider,
      used,
      budget,
      reserve,
      automaticRemaining: Math.max(0, budget - reserve - used),
      remaining: Math.max(0, budget - used),
      percentUsed: Math.round((used / budget) * 1000) / 10,
    };
  }

  /** When a 429 says to stop until, or null if no back-off is running. */
  async backoffUntil(now: Date, db: DbExecutor = getDb()): Promise<Date | null> {
    const recent = await db
      .select()
      .from(provider_calls)
      .where(eq(provider_calls.provider, this.config.provider))
      .orderBy(desc(provider_calls.called_at))
      .limit(12);
    let streak = 0;
    for (const call of recent) {
      if (call.status !== "429") break;
      streak++;
    }
    if (streak === 0) return null;
    const last = recent[0]!;
    const wait = Math.max(last.retry_after_seconds ?? 0, Math.min(BACKOFF_BASE_SECONDS * 2 ** (streak - 1), BACKOFF_CAP_SECONDS));
    const until = new Date(last.called_at.getTime() + wait * 1000);
    return until.getTime() > now.getTime() ? until : null;
  }

  /**
   * Reserves one call: checks the back-off and the budget, and writes the "started" row, all under
   * a lock so two callers at once cannot both take the last call. Throws CallRefusedError if the
   * call must not be made. The caller must finish() the returned id whatever happens.
   */
  async begin(input: { purpose: string; vesselsRequested: number; allowReserve?: boolean; now?: Date }): Promise<{ id: string }> {
    const now = input.now ?? new Date();
    const { provider, monthlyBudget, reserve } = this.config;
    const reserved = await getDb().transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`provider_calls:${provider}`}))`);

      const until = await this.backoffUntil(now, tx);
      if (until) {
        throw new CallRefusedError(`${provider}: backing off after a 429 until ${until.toISOString()}.`, "backoff", until);
      }

      const used = await this.usedSince(monthStartUtc(now), tx);
      const held = input.allowReserve ? 0 : reserve;
      if (used + 1 + held > monthlyBudget) {
        throw new CallRefusedError(
          `${provider}: call refused, ${used} of ${monthlyBudget} calls used this month${held ? ` with ${held} held in reserve` : ""}.`,
          "budget",
        );
      }

      const [row] = await tx
        .insert(provider_calls)
        .values({ provider, called_at: now, purpose: input.purpose, status: "started", vessels_requested: input.vesselsRequested })
        .returning({ id: provider_calls.id });
      return { id: row!.id, usedAfter: used + 1 };
    });

    if (reserved.usedAfter >= Math.ceil(monthlyBudget * 0.8)) {
      this.log.warn(`${provider}: ${reserved.usedAfter} of ${monthlyBudget} calls used this month (${Math.round((reserved.usedAfter / monthlyBudget) * 100)} percent).`);
    }
    return { id: reserved.id };
  }

  /** Records how the call ended: an HTTP status, "timeout" or "network_error". */
  async finish(id: string, status: string, retryAfterSeconds?: number): Promise<void> {
    await getDb()
      .update(provider_calls)
      .set({ status, retry_after_seconds: retryAfterSeconds ?? null })
      .where(eq(provider_calls.id, id));
  }
}
