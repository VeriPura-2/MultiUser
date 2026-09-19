import type { FastifyInstance } from "fastify";

/**
 * Lets a POST that declares a JSON content type but sends no body through, for the endpoints that
 * need no body (resolve, approve, reject). Fastify otherwise answers 400 to that request, and a
 * plain `fetch(url, { method: "POST", headers: { "Content-Type": "application/json" } })` from a
 * UI is exactly that.
 *
 * It works by dropping the content type of a genuinely empty request, so Fastify skips body
 * parsing. Fastify's own JSON parser is left in place, because it protects against
 * prototype-poisoning payloads and a home-made replacement would lose that.
 */
export function ignoreEmptyJsonBody(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    const type = request.headers["content-type"];
    if (!type || !/^application\/json/i.test(type)) return;
    const length = request.headers["content-length"];
    const chunked = request.headers["transfer-encoding"] !== undefined;
    if (length === "0" || (length === undefined && !chunked)) delete request.headers["content-type"];
  });
}
