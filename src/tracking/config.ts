/**
 * Tracking configuration, read from the environment. Nothing here is a secret except the
 * VesselAPI key, which is held in `vesselApiKey` and must never be logged, returned in a response,
 * or put in an error message (see redact()). Every knob has a default that is safe and cheap.
 */

export type ProviderName = "sample" | "vesselapi";

export interface TrackingConfig {
  /** Which source feeds positions. `sample` (the default) makes up demo positions and costs nothing. */
  provider: ProviderName;
  /** A live provider refuses to start unless this is true, so live data cannot be turned on by accident. */
  liveAllowed: boolean;
  /** SECRET. Only ever sent as a Bearer token to the provider. */
  vesselApiKey: string | null;
  vesselApiBaseUrl: string;
  /** "batch" asks for many vessels in one call; "single" asks for one vessel per call. */
  vesselApiLookup: "batch" | "single";
  /** Most vessels sent in one batch call (the API's page size is 50). */
  vesselApiBatchSize: number;
  /** How far back a batch call looks for positions, in hours. */
  vesselApiWindowHours: number;
  requestTimeoutMs: number;
  /** Calls allowed per calendar month (UTC) on the provider's plan. */
  monthlyBudget: number;
  /** Calls held back so a person can use them by hand. Scheduled runs never spend them. */
  reserve: number;
  /** How often the refresh job runs, and the floor under it: it is never run faster than the floor. */
  refreshIntervalMinutes: number;
  refreshMinIntervalMinutes: number;
  /** A vessel whose latest position is younger than this is not asked about again. */
  minPositionAgeMinutes: number;
  /** A position this old or younger is "recent"; older is "stale". */
  recentMaxAgeSeconds: number;
  /** Whether the server starts the scheduled job at all. */
  refreshEnabled: boolean;
}

/** Stored history per vessel. Fixed by the design, not configurable. */
export const HISTORY_HOURS = 72;

export class TrackingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrackingConfigError";
  }
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TrackingConfigError(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function flag(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new TrackingConfigError(`${name} must be true or false.`);
}

export function loadTrackingConfig(env: NodeJS.ProcessEnv = process.env): TrackingConfig {
  const provider = (env.AIS_PROVIDER?.trim().toLowerCase() || "sample") as string;
  if (provider !== "sample" && provider !== "vesselapi") {
    throw new TrackingConfigError('AIS_PROVIDER must be "sample" or "vesselapi".');
  }
  const lookup = (env.VESSELAPI_LOOKUP?.trim().toLowerCase() || "batch") as string;
  if (lookup !== "batch" && lookup !== "single") throw new TrackingConfigError('VESSELAPI_LOOKUP must be "batch" or "single".');

  const monthlyBudget = integer(env, "VESSELAPI_MONTHLY_BUDGET", 150, 1);
  const reserve = integer(env, "VESSELAPI_RESERVE", 15, 0);
  if (reserve >= monthlyBudget) throw new TrackingConfigError("VESSELAPI_RESERVE must be smaller than VESSELAPI_MONTHLY_BUDGET.");

  const refreshMinIntervalMinutes = integer(env, "TRACKING_REFRESH_MIN_INTERVAL_MINUTES", 60, 1);
  const configuredInterval = integer(env, "TRACKING_REFRESH_INTERVAL_MINUTES", 720, 1);

  return {
    provider,
    liveAllowed: flag(env, "AIS_LIVE_ALLOWED", false),
    vesselApiKey: env.VESSELAPI_KEY?.trim() || null,
    vesselApiBaseUrl: (env.VESSELAPI_BASE_URL?.trim() || "https://api.vesselapi.com/v1").replace(/\/+$/, ""),
    vesselApiLookup: lookup,
    vesselApiBatchSize: integer(env, "VESSELAPI_BATCH_SIZE", 20, 1, 50),
    vesselApiWindowHours: integer(env, "VESSELAPI_WINDOW_HOURS", 24, 1, HISTORY_HOURS),
    requestTimeoutMs: integer(env, "VESSELAPI_TIMEOUT_MS", 10_000, 1000, 120_000),
    monthlyBudget,
    reserve,
    refreshIntervalMinutes: Math.max(configuredInterval, refreshMinIntervalMinutes),
    refreshMinIntervalMinutes,
    minPositionAgeMinutes: integer(env, "TRACKING_MIN_POSITION_AGE_MINUTES", 720, 0),
    recentMaxAgeSeconds: integer(env, "TRACKING_RECENT_MAX_AGE_SECONDS", 7200, 1),
    refreshEnabled: flag(env, "TRACKING_REFRESH_ENABLED", true),
  };
}

/** Thrown at start-up when a live provider is configured without permission. */
export class LiveProviderNotAllowedError extends Error {
  constructor(provider: string) {
    super(
      `Refusing to start: AIS_PROVIDER=${provider} would call a live position provider, and AIS_LIVE_ALLOWED is not "true". ` +
        "The free plan is for evaluation only; set AIS_LIVE_ALLOWED=true deliberately, on a machine that is meant to make live calls.",
    );
    this.name = "LiveProviderNotAllowedError";
  }
}

/** Removes every occurrence of a secret from text. Applied to anything that could reach a log, an error or a response. */
export function redact(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[redacted]");
  }
  return out;
}
