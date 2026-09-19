import { ValidationError } from "../errors.js";

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trims and lowercases, so lookups and the case-insensitive unique index agree. */
export function normalizeEmail(email: string): string {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !EMAIL_FORMAT.test(normalized)) {
    throw new ValidationError(`"${email}" is not a valid email address`);
  }
  return normalized;
}

/** Postgres unique_violation (23505), which Drizzle may surface directly or as `cause`. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
