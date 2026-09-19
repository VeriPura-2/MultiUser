import { CallLedger } from "./budget.js";
import { LiveProviderNotAllowedError, loadTrackingConfig, type TrackingConfig } from "./config.js";
import { pruneOldPositions } from "./ingest.js";
import { silentLogger, type Logger, type VesselPositionProvider } from "./provider.js";
import { runRefresh, type RefreshSummary } from "./refresh.js";
import { SampleProvider } from "./sampleProvider.js";
import { VesselApiProvider } from "./vesselApiProvider.js";

/** Everything the tracking side needs, built once at start-up and handed to whatever uses it. */
export interface TrackingRuntime {
  config: TrackingConfig;
  provider: VesselPositionProvider;
  /** Always present: for a provider with no quota it simply reports zero use. */
  ledger: CallLedger;
  log: Logger;
}

/**
 * Builds the runtime from the environment. A live provider is refused unless AIS_LIVE_ALLOWED is
 * "true", and needs its key; either failure throws here, so the server does not start rather than
 * quietly running on sample data or spending calls nobody meant to spend.
 */
export function createTrackingRuntime(env: NodeJS.ProcessEnv = process.env, deps: { fetchImpl?: typeof fetch; log?: Logger } = {}): TrackingRuntime {
  const config = loadTrackingConfig(env);
  const log = deps.log ?? silentLogger;
  const ledger = new CallLedger({ provider: "vesselapi", monthlyBudget: config.monthlyBudget, reserve: config.reserve }, log);

  if (config.provider === "vesselapi") {
    if (!config.liveAllowed) throw new LiveProviderNotAllowedError("vesselapi");
    return { config, ledger, log, provider: new VesselApiProvider({ config, ledger, fetchImpl: deps.fetchImpl, log }) };
  }
  return { config, ledger, log, provider: new SampleProvider(log) };
}

/** The runtime used when none is given (tests, and any app built without one): sample positions, whatever the environment says. */
export function createSampleRuntime(log: Logger = silentLogger): TrackingRuntime {
  return createTrackingRuntime({ AIS_PROVIDER: "sample" }, { log });
}

/** Runs one refresh through the runtime's provider. */
export function refreshNow(runtime: TrackingRuntime, trigger: "scheduled" | "manual", now?: Date): Promise<RefreshSummary> {
  return runRefresh({ provider: runtime.provider, config: runtime.config, ledger: runtime.ledger, log: runtime.log, trigger, now });
}

/**
 * One tick of the scheduled job: prune old positions, then refresh. Errors are caught and logged,
 * because a failure here must never take the server down.
 */
export async function schedulerTick(runtime: TrackingRuntime, now?: Date): Promise<RefreshSummary | null> {
  try {
    await pruneOldPositions(now);
    return await refreshNow(runtime, "scheduled", now);
  } catch (error) {
    runtime.log.error(`tracking: scheduled tick failed: ${(error as Error).message}`);
    return null;
  }
}

/**
 * Starts the scheduled job. The interval is the configured one and never faster than the
 * configured floor. The first tick waits `initialDelayMs` so start-up is not held up; and a tick
 * that finds a run started less than the minimum interval ago does nothing (see runRefresh), so
 * restarting the server repeatedly cannot spend calls.
 */
export function startTrackingScheduler(runtime: TrackingRuntime, options: { initialDelayMs?: number } = {}): { stop: () => void } {
  if (!runtime.config.refreshEnabled) return { stop: () => {} };
  const intervalMs = Math.max(runtime.config.refreshIntervalMinutes, runtime.config.refreshMinIntervalMinutes) * 60_000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await schedulerTick(runtime);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, options.initialDelayMs ?? 60_000);
  const every = setInterval(tick, intervalMs);
  first.unref();
  every.unref();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
