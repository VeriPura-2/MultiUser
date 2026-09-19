import { describe, expect, it } from "vitest";
import {
  IMO_CHECK_DIGIT_MESSAGE,
  IMO_LENGTH_MESSAGE,
  MAX_VESSEL_NAME_LENGTH,
  MMSI_LENGTH_MESSAGE,
  VESSEL_NAME_LENGTH_MESSAGE,
  hasValidImoCheckDigit,
  imoProblem,
  mmsiProblem,
  vesselNameProblem,
} from "../src/vessel";

// Built from code points so this file contains no dash character itself.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

// The backend suite (tests/vesselIdentifierParity.test.ts) runs these same rules against the API's
// own copy over many inputs, so the two cannot drift apart. These tests pin the rules themselves.

describe("the form's vessel identifier rules", () => {
  it("accepts an IMO whose weighted digit sum ends in the seventh digit", () => {
    for (const imo of ["9074729", "9319466", "9811000"]) expect(imoProblem(imo), imo).toBeNull();
  });

  it("uses the weights 7 down to 2, and only the last digit of the sum", () => {
    expect(hasValidImoCheckDigit("1000007")).toBe(true);
    expect(hasValidImoCheckDigit("1000000")).toBe(false);
    expect(hasValidImoCheckDigit("0100006")).toBe(true);
    expect(hasValidImoCheckDigit("0000012")).toBe(true);
    expect(hasValidImoCheckDigit("9999993")).toBe(true); // 243
    expect(hasValidImoCheckDigit("9999994")).toBe(false);
  });

  it("names a wrong check digit and a wrong length differently", () => {
    expect(imoProblem("9074728")).toBe(IMO_CHECK_DIGIT_MESSAGE);
    for (const bad of ["", "907472", "90747290", "abcdefg", "9074 729"]) expect(imoProblem(bad), bad).toBe(IMO_LENGTH_MESSAGE);
  });

  it("wants exactly nine digits for an MMSI, and keeps a leading zero", () => {
    expect(mmsiProblem("235012345")).toBeNull();
    expect(mmsiProblem("012345678")).toBeNull();
    for (const bad of ["", "23501234", "2350123456", "23501234a"]) expect(mmsiProblem(bad), bad).toBe(MMSI_LENGTH_MESSAGE);
  });

  it("allows a name up to the limit and not a character more", () => {
    expect(vesselNameProblem("x".repeat(MAX_VESSEL_NAME_LENGTH))).toBeNull();
    expect(vesselNameProblem("x".repeat(MAX_VESSEL_NAME_LENGTH + 1))).toBe(VESSEL_NAME_LENGTH_MESSAGE);
    expect(MAX_VESSEL_NAME_LENGTH).toBe(100);
  });

  it("says its messages in plain words, with no dash character", () => {
    for (const m of [IMO_CHECK_DIGIT_MESSAGE, IMO_LENGTH_MESSAGE, MMSI_LENGTH_MESSAGE, VESSEL_NAME_LENGTH_MESSAGE]) {
      expect(m).toMatch(/^[A-Z].*\.$/);
      expect(m).not.toMatch(DASHES);
    }
  });
});
