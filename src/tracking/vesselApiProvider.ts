import { CallRefusedError, type CallLedger } from "./budget.js";
import { redact, type TrackingConfig } from "./config.js";
import { imoProblem, mmsiProblem } from "./identifiers.js";
import {
  ProviderError,
  normalisePositions,
  silentLogger,
  type FetchContext,
  type Logger,
  type RawPosition,
  type VesselIdentifier,
  type VesselPositionProvider,
  type VesselPositionReport,
} from "./provider.js";

/**
 * VesselAPI (https://vesselapi.com), a REST service for AIS positions. Built from its published
 * documentation (see docs/build-log.md, UI-3 step 2, for exactly what was relied on):
 *
 *   base URL      https://api.vesselapi.com/v1
 *   auth          Authorization: Bearer <key>          (the key is never put in a URL)
 *   batch         GET /vessels/positions?filter.ids=a,b,c&filter.idType=mmsi|imo
 *                     &time.from=<RFC3339>&time.to=<RFC3339>&pagination.limit=50
 *   single        GET /vessel/{id}/position?filter.idType=mmsi|imo   (the latest position, up to 80 hours back)
 *
 * Both endpoints identify vessels by MMSI or IMO, chosen with filter.idType, and one call may
 * carry only one kind. Satellite lookups (filter.sat) are never requested: they spend separate,
 * paid credits.
 *
 * Budget: every request goes through the CallLedger, which refuses it when the month's allowance
 * is used up, and which also records failures. This class never retries a failed request and never
 * sleeps: a 429 sets a back-off (kept in the database) and the next scheduled run tries again.
 */

interface ApiPosition {
  mmsi?: unknown;
  imo?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timestamp?: unknown;
  sog?: unknown;
  heading?: unknown;
  nav_status?: unknown;
  suspected_glitch?: unknown;
}

export interface VesselApiDeps {
  config: TrackingConfig;
  ledger: CallLedger;
  fetchImpl?: typeof fetch;
  log?: Logger;
}

type IdType = "mmsi" | "imo";

/** The identifier a request would use for a vessel: its MMSI when it has one (positions always carry an MMSI), else its IMO. */
function choose(id: VesselIdentifier): { type: IdType; value: string } | null {
  if (id.mmsi) return { type: "mmsi", value: id.mmsi };
  if (id.imo) return { type: "imo", value: id.imo };
  return null;
}
const idTypeOf = (id: VesselIdentifier): IdType | null => choose(id)?.type ?? null;
const valueOf = (id: VesselIdentifier): string => choose(id)!.value;

/** A number the API returns for an identifier, as the fixed-width text this app stores. */
function idText(value: unknown, width: number): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) return String(value).padStart(width, "0");
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value.padStart(width, "0");
  return undefined;
}

export class VesselApiProvider implements VesselPositionProvider {
  readonly name = "vesselapi";
  readonly live = true;
  private readonly config: TrackingConfig;
  private readonly ledger: CallLedger;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly key: string;

  constructor(deps: VesselApiDeps) {
    if (!deps.config.vesselApiKey) throw new ProviderError("VESSELAPI_KEY is not set.", "misconfigured");
    this.key = deps.config.vesselApiKey;
    this.config = deps.config;
    this.ledger = deps.ledger;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? silentLogger;
  }

  /** Identifiers that are usable at all: a well-formed MMSI (preferred, since positions always carry one) or IMO. */
  private usable(ids: VesselIdentifier[]): VesselIdentifier[] {
    const seen = new Set<string>();
    const out: VesselIdentifier[] = [];
    for (const id of ids) {
      const chosen = choose(id);
      if (!chosen) continue;
      const { type, value } = chosen;
      if ((type === "mmsi" ? mmsiProblem(value) : imoProblem(value)) !== null) continue;
      if (seen.has(`${type}:${value}`)) continue;
      seen.add(`${type}:${value}`);
      out.push(type === "mmsi" ? { mmsi: value } : { imo: value });
    }
    return out;
  }

  planRequests(ids: VesselIdentifier[]): VesselIdentifier[][] {
    const usable = this.usable(ids);
    const size = this.config.vesselApiLookup === "single" ? 1 : this.config.vesselApiBatchSize;
    const groups: VesselIdentifier[][] = [];
    for (const type of ["mmsi", "imo"] as const) {
      const ofType = usable.filter((id) => idTypeOf(id) === type);
      for (let i = 0; i < ofType.length; i += size) groups.push(ofType.slice(i, i + size));
    }
    return groups;
  }

  async fetchPositions(ids: VesselIdentifier[], context: FetchContext): Promise<VesselPositionReport[]> {
    const now = context.now ?? new Date();
    const group = this.usable(ids);
    if (group.length === 0) throw new ProviderError("No usable vessel identifiers in this request.", "bad_request");
    const plan = this.planRequests(group);
    if (plan.length !== 1 || plan[0]!.length !== group.length) {
      throw new ProviderError("A request may hold only vessels of one identifier type, within the size limit.", "bad_request");
    }
    const type = idTypeOf(group[0]!)!;

    // Reserve the call first. A refusal means nothing was sent.
    const call = await this.ledger.begin({ purpose: context.purpose, vesselsRequested: group.length, allowReserve: context.allowReserve, now });

    let status = "network_error";
    let retryAfter: number | undefined;
    try {
      const url = this.urlFor(group, type, now);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${this.key}`, Accept: "application/json" }, signal: controller.signal });
      } catch (error) {
        status = (error as { name?: string })?.name === "AbortError" ? "timeout" : "network_error";
        throw new ProviderError(`VesselAPI request failed (${status}).`, status);
      } finally {
        clearTimeout(timer);
      }

      status = String(response.status);
      if (response.status === 429) {
        const header = Number(response.headers.get("retry-after"));
        retryAfter = Number.isFinite(header) && header > 0 ? Math.floor(header) : undefined;
        throw new ProviderError("VesselAPI answered 429 (rate limited); backing off.", "429");
      }
      if (response.status === 404 && this.config.vesselApiLookup === "single") return []; // no position within the freshness window
      if (!response.ok) {
        const meaning = response.status === 401 || response.status === 403 ? "the key was rejected" : "the request failed";
        throw new ProviderError(`VesselAPI answered ${response.status}: ${meaning}.`, status);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ProviderError("VesselAPI answered with something that is not JSON.", status);
      }
      return normalisePositions(this.rawPositions(body), now, this.log, this.name);
    } catch (error) {
      // Whatever went wrong, the message that leaves here cannot contain the key.
      if (error instanceof ProviderError) throw new ProviderError(redact(error.message, [this.key]), error.status);
      throw new ProviderError(redact(`VesselAPI request failed: ${(error as Error).message}`, [this.key]), "error");
    } finally {
      await this.ledger.finish(call.id, status, retryAfter).catch((e) => this.log.error(redact(`Could not record the call: ${(e as Error).message}`, [this.key])));
    }
  }

  private urlFor(group: VesselIdentifier[], type: IdType, now: Date): string {
    const base = this.config.vesselApiBaseUrl;
    if (this.config.vesselApiLookup === "single") {
      return `${base}/vessel/${encodeURIComponent(valueOf(group[0]!))}/position?filter.idType=${type}`;
    }
    const from = new Date(now.getTime() - this.config.vesselApiWindowHours * 3_600_000);
    const params = new URLSearchParams({
      "filter.ids": group.map(valueOf).join(","),
      "filter.idType": type,
      "time.from": from.toISOString(),
      "time.to": now.toISOString(),
      "pagination.limit": "50",
    });
    return `${base}/vessels/positions?${params.toString()}`;
  }

  /**
   * Reads positions out of a response. The batch answer carries `vesselPositions`, a list; the
   * single-vessel answer carries `vesselPosition`, one object (the documentation shows both a
   * wrapped and an unwrapped form for it, so both are accepted). A row the API marks as a suspected
   * glitch is dropped: it is exactly the kind of position that must not be drawn.
   * Only the first page is read: another page would be another billable call.
   */
  private rawPositions(body: unknown): RawPosition[] {
    if (typeof body !== "object" || body === null) return [];
    const record = body as Record<string, unknown>;
    let rows: unknown[] = [];
    if (Array.isArray(record.vesselPositions)) rows = record.vesselPositions;
    else if (record.vesselPosition && typeof record.vesselPosition === "object") rows = [record.vesselPosition];
    else if ("latitude" in record) rows = [record];

    if (typeof record.nextToken === "string" && record.nextToken) {
      this.log.warn("vesselapi: the response has more pages; only the first was read, to protect the call budget.");
    }

    const out: RawPosition[] = [];
    let glitches = 0;
    for (const row of rows) {
      if (typeof row !== "object" || row === null) continue;
      const p = row as ApiPosition;
      if (p.suspected_glitch === true) {
        glitches++;
        continue;
      }
      out.push({
        mmsi: idText(p.mmsi, 9),
        imo: idText(p.imo, 7),
        lat: p.latitude,
        lng: p.longitude,
        speedKnots: p.sog,
        headingDeg: p.heading,
        navStatus: p.nav_status,
        positionTime: p.timestamp,
        source: this.name,
      });
    }
    if (glitches > 0) this.log.warn(`vesselapi: dropped ${glitches} positions the API marked as suspected glitches.`);
    return out;
  }
}

/** True when an error means "the ledger said no", so nothing was sent. */
export const isRefusal = (error: unknown): error is CallRefusedError => error instanceof CallRefusedError;
