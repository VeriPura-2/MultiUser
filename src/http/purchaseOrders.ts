import type { FastifyPluginAsync } from "fastify";
import { ValidationError } from "../errors.js";
import { submitPurchaseOrder } from "../services/consignments.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";

export type PurchaseOrderRouteOptions = ActorOptions;

/** 15 MB of file becomes about 20 MB of base64 inside the JSON body. */
const BODY_LIMIT = 22 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

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
