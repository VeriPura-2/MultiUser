import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { consignment, dashboardApi, exporterAdmin, importerAdmin, queueItem, workloadRow } from "./fixtures";
import { respond } from "./mockApi";
import { renderApp } from "./renderApp";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";

/** The four headline numbers as { label: value }. */
function stats(): Record<string, string> {
  return Object.fromEntries(
    [...document.querySelectorAll(".stat-card")].map((card) => [
      card.querySelector(".stat-l")!.textContent!,
      card.querySelector(".stat-value")!.textContent!,
    ]),
  );
}

describe("dashboard: headline numbers", () => {
  it("derives them from the consignment list and party workload, counting only live consignments", async () => {
    dashboardApi(importerAdmin, {
      consignments: [
        consignment({ id: A, openIssueCount: 2, checklistCompleteness: { verified: 1, total: 2 } }), // 50%
        consignment({ id: B, openIssueCount: 1, checklistCompleteness: { verified: 4, total: 4 } }), // 100%
        consignment({ id: C, status: "completed", openIssueCount: 9, checklistCompleteness: { verified: 0, total: 4 } }), // finished: ignored
        consignment({ id: D, status: "cancelled", openIssueCount: 9 }), // finished: ignored
      ],
      parties: [workloadRow("Sample Exporter Alpha"), workloadRow("Sample Exporter Beta"), workloadRow("Old Partner", 0)],
    });
    renderApp("/");

    await waitFor(() => expect(stats()["Active consignments"]).toBe("2"));
    expect(stats()).toEqual({
      "Active consignments": "2",
      "Open issues": "3",
      "Avg. completeness": "75%",
      "Exporter parties": "3",
    });
    expect(await screen.findByText("2 active consignments across 2 exporters")).toBeInTheDocument();
  });

  it("flags open issues in red, and shows n/a for completeness when nothing has a checklist yet", async () => {
    dashboardApi(importerAdmin, {
      consignments: [consignment({ status: "po_submitted", checklistCompleteness: { verified: 0, total: 0 } })],
      parties: [workloadRow("Sample Exporter Alpha")],
    });
    renderApp("/");
    await waitFor(() => expect(stats()["Avg. completeness"]).toBe("n/a"));
    expect(screen.getByText("Open issues").parentElement!.querySelector(".stat-value")).not.toHaveClass("red");
  });

  it("names the other side from the viewer's own organization type", async () => {
    dashboardApi(exporterAdmin, { consignments: [consignment()], parties: [workloadRow("Sample Importer Ltd")] });
    renderApp("/");
    await waitFor(() => expect(stats()["Importer parties"]).toBe("1"));
    expect(await screen.findByText("1 active consignment across 1 importer")).toBeInTheDocument();
  });
});

describe("dashboard: attention band", () => {
  it("appears when issues are open, counts consignments, and links to the first flagged issue", async () => {
    dashboardApi(importerAdmin, {
      consignments: [consignment({ id: A, openIssueCount: 2 }), consignment({ id: B, openIssueCount: 1 }), consignment({ id: C })],
      queue: [queueItem({ consignmentId: B, status: "flagged", issueId: "issue-1", responsibleOrgType: "lab_cert" })],
      parties: [workloadRow("Sample Exporter Alpha")],
    });
    renderApp("/");

    const band = await screen.findByRole("region", { name: "Needs attention" });
    expect(band).toHaveTextContent("2 consignments have open issues requiring action");
    await waitFor(() => expect(band).toHaveTextContent("including a flagged document on Consignment #BBBBBBBB"));
    expect(within(band).getByRole("link", { name: /review issues/i })).toHaveAttribute("href", "/issues/issue-1");
  });

  it("falls back to the first consignment with an issue when the queue names no issue", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment({ id: A, openIssueCount: 1 })] });
    renderApp("/");
    const band = await screen.findByRole("region", { name: "Needs attention" });
    expect(band).toHaveTextContent("1 consignment has open issues requiring action");
    expect(within(band).getByRole("link", { name: /review issues/i })).toHaveAttribute("href", `/consignments/${A}`);
  });

  it("is absent when nothing has an open issue", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment(), consignment()], parties: [workloadRow("X")] });
    renderApp("/");
    await screen.findByText("2 active consignments across 1 exporter");
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
  });

  it("ignores issues on finished consignments", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment({ status: "completed", openIssueCount: 3 })] });
    renderApp("/");
    await screen.findByText("Finished consignments");
    expect(screen.queryByRole("region", { name: "Needs attention" })).not.toBeInTheDocument();
  });
});

describe("dashboard: action queue", () => {
  const queue = [
    queueItem({ consignmentId: A, documentTypeName: "Flagged Sample Doc", status: "flagged", issueId: "issue-9", responsibleOrgType: "lab_cert", requiredBy: "exporter" }),
    queueItem({ consignmentId: A, documentTypeName: "Mine Sample Doc", requiredBy: "importer", actionableByMyOrg: true }),
    queueItem({ consignmentId: B, documentTypeName: "Theirs Sample Doc", requiredBy: "exporter", actionableByMyOrg: false }),
    queueItem({ consignmentId: B, documentTypeName: "Freight Sample Doc", requiredBy: "logistics", actionableByMyOrg: false }),
  ];
  const setup = () => {
    dashboardApi(importerAdmin, { consignments: [consignment({ id: A }), consignment({ id: B })], queue });
    renderApp("/");
  };
  const rows = () => within(screen.getByRole("region", { name: "Required documents action queue" })).queryAllByRole("listitem");

  it("lists every item with document names straight from the API, in the order the API gives", async () => {
    setup();
    await screen.findByText(/Flagged Sample Doc/);
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining("#AAAAAAAA"),
      expect.stringContaining("Mine Sample Doc"),
      expect.stringContaining("Theirs Sample Doc"),
      expect.stringContaining("Freight Sample Doc"),
    ]);
    expect(rows()[0]).toHaveTextContent("Flagged Sample Doc");
    expect(screen.getByText("4 items")).toBeInTheDocument();
  });

  it("shows who owns each item and its status", async () => {
    setup();
    await screen.findByText(/Flagged Sample Doc/);
    expect(within(rows()[0]!).getByText("Lab / Cert")).toHaveClass("tag");
    expect(within(rows()[0]!).getByText("Correction needed")).toHaveClass("badge", "red");
    expect(within(rows()[1]!).getByText("Importer")).toBeInTheDocument();
    expect(within(rows()[1]!).getByText("Awaiting upload")).toHaveClass("badge", "gray");
    expect(within(rows()[3]!).getByText("Logistics")).toBeInTheDocument();
  });

  it("filters to what needs my organization and to what waits on others, and updates the count", async () => {
    setup();
    await screen.findByText(/Flagged Sample Doc/);

    await userEvent.click(screen.getByRole("button", { name: "Needs my org" }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toHaveTextContent("Mine Sample Doc");
    expect(screen.getByText("1 item")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Needs my org" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "false");

    await userEvent.click(screen.getByRole("button", { name: "Waiting on others" }));
    expect(rows()).toHaveLength(3);
    expect(rows().some((r) => r.textContent!.includes("Mine Sample Doc"))).toBe(false);
    expect(screen.getByText("3 items")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(rows()).toHaveLength(4);
  });

  it("links a flagged item to its issue, and shows Upload and Nudge as disabled with a reason", async () => {
    setup();
    await screen.findByText(/Flagged Sample Doc/);

    expect(within(rows()[0]!).getByRole("link", { name: "View issue" })).toHaveAttribute("href", "/issues/issue-9");

    const upload = within(rows()[1]!).getByRole("button", { name: "Upload" });
    expect(upload).toBeDisabled();
    expect(upload.parentElement).toHaveAttribute("title", expect.stringMatching(/later stage/i));

    const nudge = within(rows()[2]!).getByRole("button", { name: "Nudge party" });
    expect(nudge).toBeDisabled();
    expect(nudge.parentElement).toHaveAttribute("title", expect.stringMatching(/later stage/i));
  });

  it("has no Upload or Nudge on a flagged row", async () => {
    setup();
    await screen.findByText(/Flagged Sample Doc/);
    expect(within(rows()[0]!).queryByRole("button")).not.toBeInTheDocument();
  });

  it("says when there is nothing to do, and when a filter matches nothing", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment()], queue: [queueItem({ actionableByMyOrg: false })] });
    renderApp("/");
    await screen.findByText(/Sample Certificate A/);
    await userEvent.click(screen.getByRole("button", { name: "Needs my org" }));
    expect(screen.getByText("Nothing in this view")).toBeInTheDocument();
  });

  it("shows an empty state for an empty queue", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment()] });
    renderApp("/");
    expect(await screen.findByText("Nothing needs action")).toBeInTheDocument();
    expect(screen.getByText("0 items")).toBeInTheDocument();
  });

  it("never shows placeholder text in place of a document name", async () => {
    setup();
    await screen.findByText(/Flagged Sample Doc/);
    expect(document.body.textContent).not.toMatch(/Document name TBC/i);
  });
});

describe("dashboard: consignment list", () => {
  it("shows a row per consignment linking to its roadmap, with route, progress and badges", async () => {
    dashboardApi(importerAdmin, {
      consignments: [
        consignment({
          id: A,
          commodity: "Frozen boneless beef",
          originCountry: "BR",
          destinationCountry: "GB",
          exporterOrgName: "Sample Exporter Alpha",
          importerOrgName: "Sample Importer Ltd",
          checklistCompleteness: { verified: 9, total: 20 },
          openIssueCount: 2,
        }),
        consignment({ id: B, commodity: "Frozen lamb legs", originCountry: "AR", checklistCompleteness: { verified: 4, total: 4 }, status: "active" }),
      ],
    });
    renderApp("/");

    const first = (await screen.findByText("#AAAAAAAA · Frozen boneless beef")).closest("a")!;
    expect(first).toHaveAttribute("href", `/consignments/${A}`);
    expect(first).toHaveClass("has-issues");
    expect(first).toHaveTextContent("Sample Exporter Alpha → Sample Importer Ltd");
    expect(first).toHaveTextContent("Brazil → United Kingdom");
    expect(first).toHaveTextContent("45% complete");
    expect(within(first).getByText("2 issues")).toHaveClass("badge", "red");
    expect(within(first).getByText("In review")).toHaveClass("badge", "blue");
    expect(first.querySelector(".bar-fill")).toHaveStyle({ width: "45%" });

    const second = screen.getByText("#BBBBBBBB · Frozen lamb legs").closest("a")!;
    expect(second).not.toHaveClass("has-issues");
    expect(second).toHaveTextContent("Argentina → United Kingdom");
    expect(second).toHaveTextContent("100% complete");
    expect(within(second).getByText("0 issues")).toHaveClass("badge", "gray");
    expect(within(second).getByText("Active")).toHaveClass("badge", "green");
    expect(second.querySelector(".bar-fill")).toHaveClass("ok");
  });

  it("says '1 issue', not '1 issues'", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment({ openIssueCount: 1 })] });
    renderApp("/");
    expect(await screen.findByText("1 issue")).toBeInTheDocument();
  });

  it("puts finished consignments under their own heading, after the live ones", async () => {
    dashboardApi(importerAdmin, {
      consignments: [consignment({ id: A, status: "completed", commodity: "Old Cargo" }), consignment({ id: B, commodity: "Live Cargo" })],
    });
    renderApp("/");
    await screen.findByRole("heading", { name: "Finished consignments" });
    const names = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(names.indexOf("Active consignments")).toBeLessThan(names.indexOf("Finished consignments"));
    const live = screen.getByText(/Live Cargo/).compareDocumentPosition(screen.getByText(/Old Cargo/));
    expect(live & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("shows an empty state when there are no consignments", async () => {
    dashboardApi(importerAdmin, { consignments: [] });
    renderApp("/");
    expect(await screen.findByText("No active consignments")).toBeInTheDocument();
    expect(screen.getByText("0 active consignments across 0 exporters")).toBeInTheDocument();
  });

  it("scrolls to the list when reached from the sidebar's Consignments link", async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    dashboardApi(importerAdmin, { consignments: [consignment()] });
    renderApp("/#consignments");
    await screen.findByText(/#0000/);
    await waitFor(() => expect(scroll).toHaveBeenCalled());
    expect(scroll.mock.contexts[0]).toBe(document.getElementById("consignments"));
    // @ts-expect-error restore jsdom's lack of it
    delete Element.prototype.scrollIntoView;
  });
});

describe("dashboard: loading and errors", () => {
  it("shows loading states while data is on its way, then content", async () => {
    let release: (v: unknown) => void = () => {};
    dashboardApi(importerAdmin, {}, { "GET /consignments": () => new Promise((r) => (release = r)) });
    renderApp("/");
    expect(await screen.findByText("Loading consignments")).toBeInTheDocument();
    expect(screen.getByText("Loading portfolio figures")).toBeInTheDocument();
    release({ consignments: [consignment({ commodity: "Arrived Cargo" })] });
    expect(await screen.findByText(/Arrived Cargo/)).toBeInTheDocument();
  });

  it("shows a plain error with a retry when the consignment list fails, and the retry works", async () => {
    let attempts = 0;
    dashboardApi(importerAdmin, {}, {
      "GET /consignments": () => (++attempts === 1 ? respond(500, { error: "database is down" }) : { consignments: [consignment({ commodity: "Recovered Cargo" })] }),
    });
    renderApp("/");
    await waitFor(() => expect(screen.getAllByRole("alert").length).toBeGreaterThan(0));
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByText(/Recovered Cargo/)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it("a failing queue does not take the rest of the page down", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment({ commodity: "Still Here" })], parties: [workloadRow("X")] }, {
      "GET /action-queue": respond(500, { error: "queue broke" }),
    });
    renderApp("/");
    const queueCard = await screen.findByRole("region", { name: "Required documents action queue" });
    expect(await within(queueCard).findByRole("alert")).toHaveTextContent(/something went wrong/i);
    expect(await screen.findByText(/Still Here/)).toBeInTheDocument();
    expect(stats()["Active consignments"]).toBe("1");
  });

  it("does not offer things the exclusions rule out", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment()] });
    renderApp("/");
    await screen.findByText(/#0000/);
    for (const text of [/wallet/i, /VERI token/i, /Guardian/i, /forensic/i, /passport/i]) {
      expect(document.body.textContent).not.toMatch(text);
    }
  });
});
