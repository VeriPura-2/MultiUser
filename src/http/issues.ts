import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { ORG_TYPES, type OrgType } from "../db/schema.js";
import { ValidationError } from "../errors.js";
import { assertCanActOnIssue, assertCanRaiseIssueOn, getIssueDetail } from "../services/issueViews.js";
import { raiseIssue, requestCorrection, resolveIssue } from "../services/issues.js";
import { resolveActingUser, type ActorOptions } from "./actor.js";
import { ignoreEmptyJsonBody } from "./emptyBody.js";

const optionalText = (value: unknown, field: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  return value;
};

/**
 * The issue screen and its three actions. Every route first checks the viewer may see the issue's
 * parent document at full view (see services/issueViews.ts); anyone else gets a 404 that is
 * identical to an issue that does not exist. The actions are thin wrappers over the stage 2
 * service functions, and answer with the refreshed issue so the UI can update in place.
 */
export const issueRoutes: FastifyPluginAsync<ActorOptions> = async (app, options) => {
  ignoreEmptyJsonBody(app);
  const actorFor = (request: FastifyRequest) => resolveActingUser(request, options.allowDevActorHeader ?? false);
  const bodyOf = (request: FastifyRequest): Record<string, unknown> => {
    const body = request.body;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("Body must be a JSON object");
    return body as Record<string, unknown>;
  };

  app.get<{ Params: { issueId: string } }>("/issues/:issueId", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    return getIssueDetail(request.params.issueId, actingUser);
  });

  app.post<{ Params: { issueId: string } }>("/issues/:issueId/request-correction", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
    const message = bodyOf(request).message;
    if (typeof message !== "string" || !message.trim()) throw new ValidationError("message is required");

    await assertCanActOnIssue(request.params.issueId, actingUser);
    await requestCorrection({ issueId: request.params.issueId, message, actingUser });
    return getIssueDetail(request.params.issueId, actingUser);
  });

  app.post<{ Params: { issueId: string } }>("/issues/:issueId/resolve", async (request, reply) => {
    const actingUser = await actorFor(request);
    if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });

    await assertCanActOnIssue(request.params.issueId, actingUser);
    await resolveIssue({ issueId: request.params.issueId, actingUser });
    return getIssueDetail(request.params.issueId, actingUser);
  });

  app.post<{ Params: { consignmentId: string; itemId: string } }>(
    "/consignments/:consignmentId/checklist/:itemId/issues",
    async (request, reply) => {
      const actingUser = await actorFor(request);
      if (!actingUser) return reply.code(401).send({ error: "unauthenticated" });
      const { consignmentId, itemId } = request.params;
      const body = bodyOf(request);

      if (typeof body.problem !== "string" || !body.problem.trim()) throw new ValidationError("problem is required");
      if (!ORG_TYPES.includes(body.responsibleOrgType as OrgType)) {
        throw new ValidationError(`responsibleOrgType must be one of ${ORG_TYPES.join(", ")}`);
      }

      await assertCanRaiseIssueOn(consignmentId, itemId, actingUser);
      const issue = await raiseIssue({
        documentChecklistItemId: itemId,
        problem: body.problem,
        expectedValue: optionalText(body.expectedValue, "expectedValue"),
        foundValue: optionalText(body.foundValue, "foundValue"),
        sourceChecklistItemId: optionalText(body.sourceChecklistItemId, "sourceChecklistItemId"),
        responsibleOrgType: body.responsibleOrgType as OrgType,
        actingUser,
      });
      return reply.code(201).send(await getIssueDetail(issue.id, actingUser));
    },
  );
};
