import { CHECKLIST_REQUIRED_BY, type ChecklistRequiredBy } from "../db/schema.js";
import { ValidationError } from "../errors.js";
import type { CoreChecklistPayload, RequiredDocument } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_DOCUMENTS = 200;
const MAX_NAME = 200;

/**
 * Validates and normalizes an inbound checklist callback body. Throws ValidationError with a
 * message safe to return to the caller. Trims names, and collapses entries that repeat the same
 * (document type name, requiredBy) pair, ignoring case in the name.
 */
export function parseChecklistPayload(body: unknown): CoreChecklistPayload {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ValidationError("Body must be a JSON object");
  }
  const b = body as Record<string, unknown>;

  if (typeof b.consignmentId !== "string" || !UUID.test(b.consignmentId)) {
    throw new ValidationError("consignmentId must be a UUID string");
  }

  let externalCoreId: string | undefined;
  if (b.externalCoreId !== undefined && b.externalCoreId !== null) {
    if (typeof b.externalCoreId !== "string") throw new ValidationError("externalCoreId must be a string");
    const trimmed = b.externalCoreId.trim();
    if (trimmed.length > MAX_NAME) throw new ValidationError("externalCoreId is too long");
    externalCoreId = trimmed === "" ? undefined : trimmed;
  }

  if (!Array.isArray(b.requiredDocuments) || b.requiredDocuments.length === 0) {
    throw new ValidationError("requiredDocuments must be a non-empty array");
  }
  if (b.requiredDocuments.length > MAX_DOCUMENTS) {
    throw new ValidationError(`requiredDocuments may hold at most ${MAX_DOCUMENTS} entries`);
  }

  const seen = new Set<string>();
  const requiredDocuments: RequiredDocument[] = [];
  b.requiredDocuments.forEach((entry: unknown, i: number) => {
    if (typeof entry !== "object" || entry === null) {
      throw new ValidationError(`requiredDocuments[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const name = typeof e.documentTypeName === "string" ? e.documentTypeName.trim() : "";
    if (!name || name.length > MAX_NAME) {
      throw new ValidationError(`requiredDocuments[${i}].documentTypeName must be a non-empty string`);
    }
    if (!CHECKLIST_REQUIRED_BY.includes(e.requiredBy as ChecklistRequiredBy)) {
      throw new ValidationError(
        `requiredDocuments[${i}].requiredBy must be one of ${CHECKLIST_REQUIRED_BY.join(", ")}`,
      );
    }
    const requiredBy = e.requiredBy as ChecklistRequiredBy;
    const key = `${name.toLowerCase()}|${requiredBy}`;
    if (!seen.has(key)) {
      seen.add(key);
      requiredDocuments.push({ documentTypeName: name, requiredBy });
    }
  });

  return { consignmentId: b.consignmentId, externalCoreId, requiredDocuments };
}
