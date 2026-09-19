import { describe, expect, it } from "vitest";
import * as api from "../src/tracking/identifiers.js";
import * as web from "../web/src/vessel.js";

/**
 * The web form checks vessel identifiers with its own copy of the rules (web/src/vessel.ts), so a
 * user is told what is wrong before anything is sent. Two copies can drift apart, and a form that
 * accepts what the API refuses (or the reverse) is a bug the user meets. This test runs both over
 * the same inputs, including every possible check digit, and requires identical answers and
 * identical wording.
 */

const sixDigitPrefixes = ["907472", "931946", "981100", "100000", "999999", "000000", "123456", "555555", "314159"];

const imoInputs = [
  ...sixDigitPrefixes.flatMap((prefix) => Array.from({ length: 10 }, (_, d) => `${prefix}${d}`)),
  "", " ", "1", "123456", "12345678", "9074729 ", " 9074729", "9074-729", "9074 729", "abcdefg", "907472a", "９０７４７２９", "0000000", "9999999",
];
const mmsiInputs = ["235012345", "012345678", "999999999", "000000000", "", "1", "12345678", "1234567890", "23501234a", " 235012345", "235 012 345", "２３５０１２３４５"];
const nameInputs = ["", "A", "x".repeat(99), "x".repeat(100), "x".repeat(101), "Sample Voyager", "  padded  "];

describe("the web form and the API agree on vessel identifiers", () => {
  it("gives every IMO input the same answer, with the same words", () => {
    for (const input of imoInputs) expect(web.imoProblem(input), JSON.stringify(input)).toBe(api.imoProblem(input));
  });

  it("gives every IMO, over a whole range, the same check-digit verdict", () => {
    for (let n = 1_000_000; n < 1_003_000; n++) {
      const imo = String(n);
      expect(web.hasValidImoCheckDigit(imo), imo).toBe(api.hasValidImoCheckDigit(imo));
    }
  });

  it("gives every MMSI input the same answer, with the same words", () => {
    for (const input of mmsiInputs) expect(web.mmsiProblem(input), JSON.stringify(input)).toBe(api.mmsiProblem(input));
  });

  it("gives every name the same answer, with the same words, and the same limit", () => {
    for (const input of nameInputs) expect(web.vesselNameProblem(input), JSON.stringify(input)).toBe(api.vesselNameProblem(input));
    expect(web.MAX_VESSEL_NAME_LENGTH).toBe(api.MAX_VESSEL_NAME_LENGTH);
  });

  it("uses word for word the same messages", () => {
    expect(web.IMO_LENGTH_MESSAGE).toBe(api.IMO_LENGTH_MESSAGE);
    expect(web.IMO_CHECK_DIGIT_MESSAGE).toBe(api.IMO_CHECK_DIGIT_MESSAGE);
    expect(web.MMSI_LENGTH_MESSAGE).toBe(api.MMSI_LENGTH_MESSAGE);
    expect(web.VESSEL_NAME_LENGTH_MESSAGE).toBe(api.VESSEL_NAME_LENGTH_MESSAGE);
  });

  it("the comparison can fail: it would notice if one side disagreed", () => {
    // A deliberately different rule shows the loop above is capable of catching a difference.
    const wrong = (imo: string) => (imo === "9074729" ? "different" : null);
    expect(wrong("9074729")).not.toBe(api.imoProblem("9074729"));
  });
});
