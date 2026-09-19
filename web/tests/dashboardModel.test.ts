import { describe, expect, it } from "vitest";
import { countryName, count } from "../src/format";
import { completenessPercent, counterpartyNoun, filterQueue, firstIssue, liveConsignments, portfolioStats } from "../src/screens/dashboard/model";
import { consignment, queueItem } from "./fixtures";

describe("portfolioStats", () => {
  it("is zero and n/a for an empty portfolio", () => {
    expect(portfolioStats([])).toEqual({ active: 0, openIssues: 0, averageCompleteness: null });
  });

  it("averages each consignment's own share, not pooled documents", () => {
    // Pooled it would be 5/104 = 5%; the mean of 100% and 0% is 50%.
    const stats = portfolioStats([
      consignment({ checklistCompleteness: { verified: 4, total: 4 } }),
      consignment({ checklistCompleteness: { verified: 0, total: 100 } }),
    ]);
    expect(stats.averageCompleteness).toBe(50);
  });

  it("leaves consignments without a checklist out of the average instead of counting them as 0%", () => {
    const stats = portfolioStats([
      consignment({ checklistCompleteness: { verified: 2, total: 4 } }),
      consignment({ status: "po_submitted", checklistCompleteness: { verified: 0, total: 0 } }),
    ]);
    expect(stats).toMatchObject({ active: 2, averageCompleteness: 50 });
  });

  it("rounds to a whole percent", () => {
    expect(portfolioStats([consignment({ checklistCompleteness: { verified: 1, total: 3 } })]).averageCompleteness).toBe(33);
    expect(portfolioStats([consignment({ checklistCompleteness: { verified: 2, total: 3 } })]).averageCompleteness).toBe(67);
  });

  it("leaves completed and cancelled consignments out of every figure", () => {
    const stats = portfolioStats([
      consignment({ openIssueCount: 1 }),
      consignment({ status: "completed", openIssueCount: 5 }),
      consignment({ status: "cancelled", openIssueCount: 5 }),
    ]);
    expect(stats).toMatchObject({ active: 1, openIssues: 1 });
    expect(liveConsignments([consignment({ status: "completed" }), consignment({ status: "po_submitted" })])).toHaveLength(1);
  });

  it("completenessPercent copes with an empty checklist", () => {
    expect(completenessPercent({ verified: 0, total: 0 })).toBe(0);
    expect(completenessPercent({ verified: 1, total: 8 })).toBe(13);
  });
});

describe("filterQueue", () => {
  const mine = queueItem({ documentTypeName: "Mine", actionableByMyOrg: true });
  const theirs = queueItem({ documentTypeName: "Theirs", actionableByMyOrg: false });
  const items = [mine, theirs];

  it("keeps everything for all, and splits the rest by who has to act", () => {
    expect(filterQueue(items, "all")).toEqual(items);
    expect(filterQueue(items, "mine")).toEqual([mine]);
    expect(filterQueue(items, "others")).toEqual([theirs]);
  });
});

describe("firstIssue", () => {
  const withIssue = consignment({ openIssueCount: 1 });

  it("prefers the first flagged queue item, and carries its issue id", () => {
    const queue = [queueItem({ status: "awaiting_upload" }), queueItem({ consignmentId: "c-2", status: "flagged", issueId: "i-2" }), queueItem({ consignmentId: "c-3", status: "flagged", issueId: "i-3" })];
    expect(firstIssue(queue, [withIssue])).toEqual({ consignmentId: "c-2", issueId: "i-2" });
  });

  it("falls back to a live consignment with an open issue, without an issue id", () => {
    expect(firstIssue([], [consignment(), withIssue])).toEqual({ consignmentId: withIssue.id, issueId: null });
    expect(firstIssue(undefined, [withIssue])).toEqual({ consignmentId: withIssue.id, issueId: null });
  });

  it("is null when there is nothing to review, and ignores a finished consignment's issues", () => {
    expect(firstIssue([], [consignment()])).toBeNull();
    expect(firstIssue([], [consignment({ status: "completed", openIssueCount: 2 })])).toBeNull();
  });
});

describe("wording", () => {
  it("names the counterparty by the viewer's organization type", () => {
    expect(counterpartyNoun("importer").plural).toBe("exporters");
    expect(counterpartyNoun("exporter").plural).toBe("importers");
    expect(counterpartyNoun(undefined).singular).toBe("partner");
  });

  it("turns country codes into names, and leaves anything else as entered", () => {
    expect(countryName("BR")).toBe("Brazil");
    expect(countryName("gb")).toBe("United Kingdom");
    expect(countryName("Brazil")).toBe("Brazil");
    expect(countryName("ZZZ9")).toBe("ZZZ9");
  });

  it("count pluralises", () => {
    expect(count(1, "issue")).toBe("1 issue");
    expect(count(0, "issue")).toBe("0 issues");
    expect(count(2, "exporter", "exporters")).toBe("2 exporters");
  });
});
