import { UnprocessableEntityError } from "../errors.js";

/**
 * Vessel identifiers, entered by hand in this stage. Pure functions, no database.
 *
 * The web app has a copy of these rules (web/src/vessel.ts) so the form can say the same things
 * before it sends anything; tests/vesselIdentifierParity.test.ts keeps the two identical.
 */

export const MAX_VESSEL_NAME_LENGTH = 100;

export const IMO_LENGTH_MESSAGE = "IMO number must be exactly 7 digits.";
export const IMO_CHECK_DIGIT_MESSAGE = "IMO number is not valid: its check digit does not match.";
export const MMSI_LENGTH_MESSAGE = "MMSI must be exactly 9 digits.";
export const VESSEL_NAME_LENGTH_MESSAGE = `Vessel name must be ${MAX_VESSEL_NAME_LENGTH} characters or fewer.`;

/**
 * The IMO check digit: multiply the first six digits by 7, 6, 5, 4, 3, 2, add them up, and the last
 * digit of the sum must equal the seventh digit. Assumes seven digits (see imoProblem).
 */
export function hasValidImoCheckDigit(imo: string): boolean {
  const sum = [...imo.slice(0, 6)].reduce((total, digit, i) => total + Number(digit) * (7 - i), 0);
  return sum % 10 === Number(imo[6]);
}

/** What is wrong with an IMO number, or null if it is valid. */
export function imoProblem(imo: string): string | null {
  if (!/^[0-9]{7}$/.test(imo)) return IMO_LENGTH_MESSAGE;
  return hasValidImoCheckDigit(imo) ? null : IMO_CHECK_DIGIT_MESSAGE;
}

/** What is wrong with an MMSI, or null if it is valid. */
export function mmsiProblem(mmsi: string): string | null {
  return /^[0-9]{9}$/.test(mmsi) ? null : MMSI_LENGTH_MESSAGE;
}

export function vesselNameProblem(name: string): string | null {
  return name.length > MAX_VESSEL_NAME_LENGTH ? VESSEL_NAME_LENGTH_MESSAGE : null;
}

export interface VesselFields {
  vesselImo: string | null;
  vesselMmsi: string | null;
  vesselName: string | null;
}

export interface VesselFieldsInput {
  vesselImo?: unknown;
  vesselMmsi?: unknown;
  vesselName?: unknown;
}

/** Text, trimmed; an absent value, null or blank text means "no value". Anything else is not text. */
function textOrNull(value: unknown, label: string, problems: string[]): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    problems.push(`${label} must be sent as text.`);
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Checks the vessel fields of a request and returns the ones it named, normalised: text is trimmed
 * and blank or null means "clear it". A field that is not in the input is not in the result, so a
 * PATCH can leave it alone. Throws UnprocessableEntityError (422) listing every problem found.
 */
export function parseVesselFields(input: VesselFieldsInput): Partial<VesselFields> {
  const problems: string[] = [];
  const result: Partial<VesselFields> = {};

  const imo = textOrNull(input.vesselImo, "IMO number", problems);
  if (imo !== undefined) {
    const problem = imo === null ? null : imoProblem(imo);
    if (problem) problems.push(problem);
    else result.vesselImo = imo;
  }

  const mmsi = textOrNull(input.vesselMmsi, "MMSI", problems);
  if (mmsi !== undefined) {
    const problem = mmsi === null ? null : mmsiProblem(mmsi);
    if (problem) problems.push(problem);
    else result.vesselMmsi = mmsi;
  }

  const name = textOrNull(input.vesselName, "Vessel name", problems);
  if (name !== undefined) {
    const problem = name === null ? null : vesselNameProblem(name);
    if (problem) problems.push(problem);
    else result.vesselName = name;
  }

  if (problems.length > 0) throw new UnprocessableEntityError(problems.join(" "));
  return result;
}

/** The fields for a new consignment: whatever was not given is null. */
export function vesselFieldsForCreate(input: VesselFieldsInput): VesselFields {
  const parsed = parseVesselFields(input);
  return { vesselImo: parsed.vesselImo ?? null, vesselMmsi: parsed.vesselMmsi ?? null, vesselName: parsed.vesselName ?? null };
}
