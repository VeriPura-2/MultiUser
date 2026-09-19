/**
 * Vessel identifier rules, the same as the API's (src/tracking/identifiers.ts), so the form can say
 * what the API would say before it sends anything. tests/vesselIdentifierParity.test.ts, in the
 * backend suite, runs both over the same inputs and fails if they ever differ.
 */

export const MAX_VESSEL_NAME_LENGTH = 100;

export const IMO_LENGTH_MESSAGE = "IMO number must be exactly 7 digits.";
export const IMO_CHECK_DIGIT_MESSAGE = "IMO number is not valid: its check digit does not match.";
export const MMSI_LENGTH_MESSAGE = "MMSI must be exactly 9 digits.";
export const VESSEL_NAME_LENGTH_MESSAGE = `Vessel name must be ${MAX_VESSEL_NAME_LENGTH} characters or fewer.`;

/** First six digits times 7, 6, 5, 4, 3, 2, added up: the last digit of the sum must equal the seventh digit. */
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
