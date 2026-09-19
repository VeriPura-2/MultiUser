import { eq } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { getDb } from "../db/client.js";
import { users } from "../db/schema.js";
import { ValidationError } from "../errors.js";
import { submitPurchaseOrder } from "../services/consignments.js";
import type { UserRef } from "../types.js";

export interface PurchaseOrderRouteOptions {
  /**
   * Sandbox stand-in for real authentication: trust an `X-Acting-User-Id` header and load that
   * user. Off unless explicitly enabled. Sign-in is a separate prompt; until it lands, real
   * middleware is expected to resolve the acting user upstream of this layer.
   */
  allowDevActorHeader?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** 15 MB of file becomes about 20 MB of base64 inside the JSON body. */
const BODY_LIMIT = 22 * 1024 * 1024;

/** Resolves the acting user for a request, or null if the request is not authenticated. */
async function resolveActingUser(request: FastifyRequest, allowDev: boolean): Promise<UserRef | null> {
  if (!allowDev) return null;
  const header = request.headers["x-acting-user-id"];
  const id = Array.isArray(header) ? header[0] : header;
  if (!id || !UUID.test(id)) return null;
  const [row] = await getDb().select({ id: users.id, organization_id: users.organization_id }).from(users).where(eq(users.id, id));
  return row ?? null;
}

/**
 * POST /purchase-orders. Thin wrapper over submitPurchaseOrder. The PO file travels as
 * base64 in a JSON body (`fileName`, `fileBase64`) to keep this layer free of multipart
 * handling; a multipart upload can replace it without touching the service.
 */
export const purchaseOrderRoutes: FastifyPluginAsync<PurchaseOrderRouteOptions> = async (app, options) => {
  app.post("/purchase-orders", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const actingUser = await resolveActingUser(request, options.allowDevActorHeader ?? false);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });

    const body = request.body as Record<string, unknown> | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new ValidationError("Body must be a JSON object");
    }
    const fileBase64 = typeof body.fileBase64 === "string" ? body.fileBase64 : "";
    if (!BASE64.test(fileBase64)) throw new ValidationError("fileBase64 must be a non-empty base64 string");

    const consignment = await submitPurchaseOrder({
      importerOrgId: String(body.importerOrgId ?? ""),
      exporterOrgId: String(body.exporterOrgId ?? ""),
      commodity: body.commodity as string,
      hsCode: typeof body.hsCode === "string" ? body.hsCode : null,
      originCountry: body.originCountry as string,
      destinationCountry: body.destinationCountry as string,
      fileName: body.fileName as string,
      fileBuffer: Buffer.from(fileBase64, "base64"),
      actingUser,
    });
    return reply.code(201).send({ consignment });
  });
};
