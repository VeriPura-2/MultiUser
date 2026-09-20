import multipart from "@fastify/multipart";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { getDb } from "../db/client.js";
import { organizations } from "../db/schema.js";
import { PermissionDeniedError, ValidationError } from "../errors.js";
import { loadActiveActor } from "../services/actors.js";
import { getConsignmentDetail } from "../services/consignmentViews.js";
import { submitPurchaseOrder } from "../services/consignments.js";
import { updateConsignmentVessel } from "../services/vessel.js";
import { isSuperadmin } from "../types.js";
import { UUID, resolveActingUser, type ActorOptions } from "./actor.js";

/** The largest purchase order file accepted. */
export const MAX_PO_FILE_BYTES = 15 * 1024 * 1024;

const TEXT_FIELDS = ["commodity", "originCountry", "destinationCountry"] as const;

/**
 * POST /consignments (multipart/form-data): the UI's purchase order form.
 *
 * Fields: exporterOrgId, commodity, originCountry, destinationCountry, optional hsCode, optional
 * vesselImo, vesselMmsi and vesselName (422 if malformed), and one `file`. The importer is derived from the acting user's organization, so a client cannot submit
 * on another importer's behalf; a submitted `importerOrgId` is ignored for ordinary users.
 * Superadmin has no organization and must name the importer with `importerOrgId`.
 *
 * Only a user of an importer organization (or superadmin) may submit. Every id is validated up
 * front, so a malformed one is a 400, never a database error. A thin wrapper over
 * submitPurchaseOrder, which owns the rest (org types and status, the file upload, the audit).
 * Answers 201 with the new consignment's detail so the UI can go straight to its roadmap.
 */
export const consignmentRoutes: FastifyPluginAsync<ActorOptions> = async (app, options) => {
  await app.register(multipart, { limits: { fileSize: MAX_PO_FILE_BYTES, files: 1, fields: 10, parts: 12 } });

  app.post("/consignments", { bodyLimit: MAX_PO_FILE_BYTES + 1024 * 1024 }, async (request, reply) => {
    const actingUser = await resolveActingUser(request, options.allowDevActorHeader ?? false);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const actor = await loadActiveActor(actingUser);

    if (!request.isMultipart()) throw new ValidationError("Send the purchase order as multipart/form-data");

    const fields: Record<string, string> = {};
    let file: { name: string; buffer: Buffer } | null = null;
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "file") throw new ValidationError('The purchase order must be sent in a field named "file"');
        file = { name: part.filename, buffer: await part.toBuffer() }; // throws 413 past the size limit
      } else if (typeof part.value === "string") {
        fields[part.fieldname] = part.value;
      }
    }

    // Who is submitting for which importer.
    let importerOrgId: string;
    if (isSuperadmin(actor)) {
      if (!fields.importerOrgId || !UUID.test(fields.importerOrgId)) {
        throw new ValidationError("importerOrgId is required, as a valid id, when submitting as superadmin");
      }
      importerOrgId = fields.importerOrgId;
    } else {
      const [own] = await getDb().select({ orgType: organizations.org_type }).from(organizations).where(eq(organizations.id, actor.organization_id!));
      if (own?.orgType !== "importer") throw new PermissionDeniedError("Only importer organizations can submit purchase orders");
      importerOrgId = actor.organization_id!;
    }

    const exporterOrgId = fields.exporterOrgId ?? "";
    if (!UUID.test(exporterOrgId)) throw new ValidationError("exporterOrgId is required, as a valid id");
    for (const name of TEXT_FIELDS) {
      if (!fields[name]?.trim()) throw new ValidationError(`${name} is required`);
    }
    if (!file || file.buffer.length === 0) throw new ValidationError("A non-empty purchase order file is required");

    const consignment = await submitPurchaseOrder({
      importerOrgId,
      exporterOrgId,
      commodity: fields.commodity!,
      hsCode: fields.hsCode ?? null,
      originCountry: fields.originCountry!,
      destinationCountry: fields.destinationCountry!,
      vesselImo: fields.vesselImo,
      vesselMmsi: fields.vesselMmsi,
      vesselName: fields.vesselName,
      fileBuffer: file.buffer,
      fileName: file.name || "purchase-order",
      actingUser: actor,
    });
    return reply.code(201).send({ consignment: await getConsignmentDetail(consignment.id, actor) });
  });

  /**
   * PATCH /consignments/:id/vessel (JSON): set or clear the vessel identifiers. Send any of
   * vesselImo, vesselMmsi, vesselName; a field that is absent is left alone, and null or blank
   * clears it. Either party (importing or exporting organization) or superadmin may. 422 for a
   * malformed value, 404 for anyone who is not a party (a freight forwarder is not one yet). Answers with the consignment's detail.
   */
  app.patch<{ Params: { consignmentId: string } }>("/consignments/:consignmentId/vessel", async (request, reply) => {
    const actingUser = await resolveActingUser(request, options.allowDevActorHeader ?? false);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("Body must be a JSON object");
    return updateConsignmentVessel({ consignmentId: request.params.consignmentId, actingUser, changes: body as Record<string, unknown> });
  });
};
