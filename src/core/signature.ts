import { createHmac, timingSafeEqual } from "node:crypto";

/** Header carrying the HMAC-SHA256 (hex) of the raw request body, in both directions. */
export const SIGNATURE_HEADER = "x-veripura-signature";

export function signBody(rawBody: Buffer | string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time check of a signature header against the raw body. Accepts the bare hex digest
 * or one prefixed with "sha256=". Returns false for a missing, malformed, or wrong signature.
 * There is no bypass: an empty secret never verifies anything.
 */
export function verifySignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const provided = header.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  const expected = Buffer.from(signBody(rawBody, secret), "hex");
  const actual = Buffer.from(provided, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
