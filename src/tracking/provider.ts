import { imoProblem, mmsiProblem } from "./identifiers.js";

/**
 * The seam between VeriPura and any source of vessel positions. A provider is given identifiers
 * and yields normalised positions; everything provider-specific (URLs, field names, keys, quotas)
 * stays behind it. Only the backend ever holds a provider: the browser never calls one.
 *
 * Other sources can be added later (a WebSocket stream such as AISStream, or a licensed provider
 * such as Datalastic or VesselFinder) by implementing this interface. None is built yet.
 */

export interface VesselIdentifier {
  imo?: string;
  mmsi?: string;
}

/** A position as VeriPura stores and serves it, whatever the source called its fields. */
export interface VesselPositionReport {
  imo?: string;
  mmsi?: string;
  lat: number;
  lng: number;
  speedKnots?: number;
  headingDeg?: number;
  navStatus?: number;
  /** When the source says the position was reported. */
  positionTime: Date;
  /** Where it came from: "sample", "vesselapi", and so on. */
  source: string;
}

export interface FetchContext {
  /** Why the call is made, recorded with it (for example "scheduled_refresh"). */
  purpose: string;
  /** A manual call may dip into the reserve; a scheduled one may not. Ignored by providers with no allowance. */
  allowReserve?: boolean;
  now?: Date;
}

export interface VesselPositionProvider {
  readonly name: string;
  /** True for a provider that calls an outside service (and so needs AIS_LIVE_ALLOWED and has a quota). */
  readonly live: boolean;
  /**
   * Splits identifiers into the requests this provider would make. Each inner list is exactly one
   * billable call, so the caller can count calls before spending any.
   */
  planRequests(ids: VesselIdentifier[]): VesselIdentifier[][];
  /**
   * Makes ONE request, for a group from planRequests, and yields validated positions. Throws if
   * the group is not one that planRequests could have produced, so it can never spend more than a call.
   */
  fetchPositions(ids: VesselIdentifier[], context: FetchContext): Promise<VesselPositionReport[]>;
}

/** A call to a live provider failed. The message is safe to log: it never contains a key or a response body. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** How far in the future a position's time may be before it is rejected. Clocks differ a little. */
export const FUTURE_TOLERANCE_MS = 60_000;

/** What a source handed us before validation. Everything is unknown until checked. */
export interface RawPosition {
  imo?: unknown;
  mmsi?: unknown;
  lat?: unknown;
  lng?: unknown;
  speedKnots?: unknown;
  headingDeg?: unknown;
  navStatus?: unknown;
  positionTime?: unknown;
  source: string;
}

const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Checks one position and returns it cleaned, or null if it must be dropped. A position is dropped
 * for a latitude outside -90..90, a longitude outside -180..180, a missing or unreadable time, a
 * time more than a minute in the future, or no usable vessel identifier. The optional fields are
 * softer: a speed below zero or a heading outside 0 to 359.9 (AIS uses 511 for "not available") is
 * left out, and the position is kept without it, since the position itself is still true.
 */
export function validatePosition(raw: RawPosition, now: Date): VesselPositionReport | null {
  if (!isNumber(raw.lat) || raw.lat < -90 || raw.lat > 90) return null;
  if (!isNumber(raw.lng) || raw.lng < -180 || raw.lng > 180) return null;

  const time = raw.positionTime instanceof Date ? raw.positionTime : typeof raw.positionTime === "string" || isNumber(raw.positionTime) ? new Date(raw.positionTime) : null;
  if (!time || Number.isNaN(time.getTime())) return null;
  if (time.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return null;

  const imo = typeof raw.imo === "string" && imoProblem(raw.imo) === null ? raw.imo : undefined;
  const mmsi = typeof raw.mmsi === "string" && mmsiProblem(raw.mmsi) === null ? raw.mmsi : undefined;
  if (!imo && !mmsi) return null;

  const report: VesselPositionReport = { lat: raw.lat, lng: raw.lng, positionTime: time, source: raw.source };
  if (imo) report.imo = imo;
  if (mmsi) report.mmsi = mmsi;
  if (isNumber(raw.speedKnots) && raw.speedKnots >= 0) report.speedKnots = raw.speedKnots;
  if (isNumber(raw.headingDeg) && raw.headingDeg >= 0 && raw.headingDeg < 360) report.headingDeg = raw.headingDeg;
  if (isNumber(raw.navStatus) && Number.isInteger(raw.navStatus)) report.navStatus = raw.navStatus;
  return report;
}

export interface Logger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Validates a batch, keeps the good ones, and logs how many were dropped (never their contents). */
export function normalisePositions(raws: RawPosition[], now: Date, log: Logger, providerName: string): VesselPositionReport[] {
  const good: VesselPositionReport[] = [];
  for (const raw of raws) {
    const checked = validatePosition(raw, now);
    if (checked) good.push(checked);
  }
  const dropped = raws.length - good.length;
  if (dropped > 0) log.warn(`${providerName}: dropped ${dropped} of ${raws.length} positions that failed validation.`);
  return good;
}
