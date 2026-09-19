import { describe, expect, it } from "vitest";

describe("no test may touch the network", () => {
  it("the global fetch refuses unless a test installs its own fake", async () => {
    await expect(fetch("https://api.vesselapi.com/v1/vessels/positions")).rejects.toThrow(/Network access is not allowed in tests/);
    await expect(fetch("/api/positions")).rejects.toThrow(/Network access is not allowed in tests/);
  });
});
