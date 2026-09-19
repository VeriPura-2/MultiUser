import type { FastifyPluginAsync } from "fastify";
import { parseChecklistPayload } from "../core/validate.js";
import { SIGNATURE_HEADER, verifySignature } from "../core/signature.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { applyChecklist, logFailedInboundWebhook } from "../services/checklist.js";

export interface WebhookRouteOptions {
  /** Shared secret. Falls back to VERIPURA_CORE_WEBHOOK_SECRET. Never bypassed if unset. */
  secret?: string;
}

/**
 * POST /webhooks/veripura-core/checklist
 *
 * The body is read as raw bytes and its HMAC-SHA256 is verified before anything is parsed, so
 * an unsigned or wrongly signed request is rejected with 401 having touched nothing. If no
 * secret is configured the endpoint refuses every request (503) rather than skipping the check.
 *
 * Registered as an encapsulated plugin so the raw-bytes JSON parser applies only here.
 */
export const webhookRoutes: FastifyPluginAsync<WebhookRouteOptions> = async (app, options) => {
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/webhooks/veripura-core/checklist", async (request, reply) => {
    const secret = options.secret ?? process.env.VERIPURA_CORE_WEBHOOK_SECRET ?? "";
    if (!secret) {
      request.log.error("VERIPURA_CORE_WEBHOOK_SECRET is not configured; refusing webhook");
      return reply.code(503).send({ error: "webhook_secret_not_configured" });
    }

    const raw = request.body as Buffer;
    const signature = request.headers[SIGNATURE_HEADER];
    if (!verifySignature(raw, Array.isArray(signature) ? signature[0] : signature, secret)) {
      return reply.code(401).send({ error: "invalid_signature" });
    }

    // From here the caller is authenticated, so failures are worth logging for replay.
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      await logFailedInboundWebhook({ error: "invalid_json", raw: raw.toString("utf8").slice(0, 4000) });
      return reply.code(400).send({ error: "invalid_payload", message: "Body is not valid JSON" });
    }

    let payload;
    try {
      payload = parseChecklistPayload(body);
    } catch (err) {
      if (err instanceof ValidationError) {
        await logFailedInboundWebhook({ error: err.message, body: body as Record<string, unknown> });
        return reply.code(400).send({ error: "invalid_payload", message: err.message });
      }
      throw err;
    }

    try {
      const result = await applyChecklist(payload, null);
      return reply.code(200).send({
        ok: true,
        consignmentId: result.consignment.id,
        status: result.consignment.status,
        itemsCreated: result.itemsCreated,
        duplicate: result.duplicate,
      });
    } catch (err) {
      if (err instanceof NotFoundError) {
        await logFailedInboundWebhook({ error: err.message, body: payload as unknown as Record<string, unknown> });
        return reply.code(404).send({ error: "consignment_not_found" });
      }
      if (err instanceof ValidationError) {
        await logFailedInboundWebhook(
          { error: err.message, body: payload as unknown as Record<string, unknown> },
          payload.consignmentId,
        );
        return reply.code(409).send({ error: "consignment_state_conflict", message: err.message });
      }
      throw err;
    }
  });
};
