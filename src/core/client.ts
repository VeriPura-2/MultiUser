import { VeriPuraCoreError } from "../errors.js";
import { SIGNATURE_HEADER, signBody } from "./signature.js";
import type {
  CoreChecklistPayload,
  CoreConsignmentPayload,
  CoreSubmitResult,
  RequiredDocument,
  VeriPuraCoreClient,
} from "./types.js";

/**
 * The stub's example checklist. These are placeholder documents, not the authoritative list,
 * which has not been confirmed. Exported so the dev seed uses exactly the same names.
 */
export const STUB_CHECKLIST_DOCUMENTS: readonly RequiredDocument[] = [
  { documentTypeName: "Commercial Invoice", requiredBy: "exporter" },
  { documentTypeName: "Packing List", requiredBy: "exporter" },
  { documentTypeName: "Bill of Lading", requiredBy: "logistics" },
  { documentTypeName: "Export Health Certificate", requiredBy: "exporter" },
];

/**
 * Stand-in for core until the real contract is confirmed. After a simulated delay it returns a
 * hardcoded, plausible checklist in the response, which the submit flow applies exactly as it
 * would apply the real callback. It never reports an externalCoreId.
 */
export class StubVeriPuraCoreClient implements VeriPuraCoreClient {
  constructor(private readonly delayMs: number = 250) {}

  async submitConsignment(payload: CoreConsignmentPayload): Promise<CoreSubmitResult> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    const checklist: CoreChecklistPayload = {
      consignmentId: payload.consignmentId,
      requiredDocuments: STUB_CHECKLIST_DOCUMENTS.map((d) => ({ ...d })),
    };
    return { checklist };
  }
}

export interface LiveClientOptions {
  url: string;
  /** Shared secret used to sign the body, so core can verify who is calling. */
  secret: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Real HTTP client. POSTs the consignment payload as JSON and treats any 2xx as "accepted".
 * Core replies later by calling POST /webhooks/veripura-core/checklist, so no checklist is
 * returned here. The body is signed with the same header and scheme core uses to sign its
 * callbacks. That outbound signing is our proposal, to be confirmed with core's team.
 */
export class HttpVeriPuraCoreClient implements VeriPuraCoreClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: LiveClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async submitConsignment(payload: CoreConsignmentPayload): Promise<CoreSubmitResult> {
    const body = JSON.stringify(payload);
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [SIGNATURE_HEADER]: signBody(body, this.options.secret),
        },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new VeriPuraCoreError(`Request to VeriPura core failed: ${(err as Error).message}`);
    }
    if (!response.ok) {
      throw new VeriPuraCoreError(`VeriPura core responded with HTTP ${response.status}`);
    }
    return {};
  }
}

// ---------------------------------------------------------------------------
// Selection: VERIPURA_CORE_MODE=stub|live, overridable in tests.
// ---------------------------------------------------------------------------

let override: VeriPuraCoreClient | undefined;
let cached: VeriPuraCoreClient | undefined;

export function createCoreClientFromEnv(env: NodeJS.ProcessEnv = process.env): VeriPuraCoreClient {
  const mode = env.VERIPURA_CORE_MODE ?? "stub";
  if (mode === "stub") {
    const raw = env.VERIPURA_CORE_STUB_DELAY_MS;
    const delay = raw === undefined || raw === "" ? undefined : Number(raw);
    if (delay !== undefined && (!Number.isFinite(delay) || delay < 0)) {
      throw new Error(`VERIPURA_CORE_STUB_DELAY_MS must be a non-negative number, got "${raw}"`);
    }
    return new StubVeriPuraCoreClient(delay);
  }
  if (mode === "live") {
    const url = env.VERIPURA_CORE_WEBHOOK_URL;
    const secret = env.VERIPURA_CORE_WEBHOOK_SECRET;
    if (!url) throw new Error("VERIPURA_CORE_MODE=live requires VERIPURA_CORE_WEBHOOK_URL");
    if (!secret) throw new Error("VERIPURA_CORE_MODE=live requires VERIPURA_CORE_WEBHOOK_SECRET");
    return new HttpVeriPuraCoreClient({ url, secret });
  }
  throw new Error(`VERIPURA_CORE_MODE must be "stub" or "live", got "${mode}"`);
}

export function getCoreClient(): VeriPuraCoreClient {
  if (override) return override;
  cached ??= createCoreClientFromEnv();
  return cached;
}

/** Test hook. Pass undefined to return to the env-configured client. */
export function setCoreClient(client: VeriPuraCoreClient | undefined): void {
  override = client;
  cached = undefined;
}
