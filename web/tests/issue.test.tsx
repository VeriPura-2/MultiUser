import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { describeAction, stepsFor } from "../src/screens/issue/model";
import { importerAdmin, issueApi, issueDetail } from "./fixtures";
import { respond } from "./mockApi";
import { renderApp } from "./renderApp";

const open = () => renderApp("/issues/issue-1");
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("issue: reading it", () => {
  it("shows the document, the status, and where to go back to", async () => {
    issueApi(importerAdmin, issueDetail({ status: "correction_requested", checklistItem: { id: "i", documentTypeName: "Sample Certificate", category: "Cat", requiredBy: "exporter" } }));
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "Issue: Sample Certificate" })).toBeInTheDocument();
    expect(document.querySelector(".is-status")).toHaveTextContent("Correction requested");
    expect(document.querySelector(".is-status")).not.toHaveClass("resolved");
    expect(screen.getByRole("link", { name: /back to compliance roadmap/i })).toHaveAttribute("href", "/consignments/a1b2c3d4-0000-4000-8000-000000000000");
    expect(screen.getByRole("link", { name: /back to compliance roadmap/i })).toHaveTextContent("#A1B2C3D4");
    expect(screen.getByText(/opened 2026-09-16/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle dark mode/i })).toBeInTheDocument();
  });

  it("shows the problem with the expected and found values, and the source document", async () => {
    issueApi(importerAdmin);
    open();
    await screen.findByRole("heading", { name: "Problem" });
    expect(screen.getByText("A reference number does not match the source document")).toBeInTheDocument();
    expect(document.querySelector(".is-expected")).toHaveTextContent("ExpectedRVX-2287");
    expect(document.querySelector(".is-found")).toHaveTextContent("FoundRVX-2291");
    expect(screen.getByText("Source document: Sample Invoice")).toBeInTheDocument();
  });

  it("leaves out the value boxes when there are none, and the source line when there is no source", async () => {
    issueApi(importerAdmin, issueDetail({ expectedValue: null, foundValue: null, sourceDocumentTypeName: null }));
    open();
    await screen.findByRole("heading", { name: "Problem" });
    expect(document.querySelector(".is-values")).toBeNull();
    expect(screen.queryByText(/Source document/)).not.toBeInTheDocument();
  });

  it("says 'Not stated' for a missing half rather than showing an empty box", async () => {
    issueApi(importerAdmin, issueDetail({ expectedValue: null, foundValue: "460" }));
    open();
    await screen.findByRole("heading", { name: "Problem" });
    expect(document.querySelector(".is-expected")).toHaveTextContent("ExpectedNot stated");
    expect(document.querySelector(".is-found")).toHaveTextContent("Found460");
  });

  it("shows the responsible party and the checklist item", async () => {
    issueApi(importerAdmin, issueDetail({ responsibleOrgType: "exporter", responsibleOrgName: "Sample Exporter Alpha" }));
    open();
    const party = (await screen.findByText("Responsible party")).parentElement!;
    expect(party).toHaveTextContent("Sample Exporter Alpha");
    expect(party).toHaveTextContent("Exporter");
    const item = screen.getByText("Checklist item").parentElement!;
    expect(item).toHaveTextContent("Sample Certificate");
    expect(item).toHaveTextContent("Sample Category");
    expect(item).toHaveTextContent("Required from Exporter");
  });

  it("names the type when the responsible party is not one of the two trading parties, and calls a missing category Uncategorised", async () => {
    issueApi(importerAdmin, issueDetail({ responsibleOrgType: "lab_cert", responsibleOrgName: null, checklistItem: { id: "i", documentTypeName: "X", category: null, requiredBy: "importer" } }));
    open();
    const party = (await screen.findByText("Responsible party")).parentElement!;
    expect(party).toHaveTextContent("Lab / Cert");
    expect(party).toHaveTextContent("Not one of the two trading parties");
    expect(screen.getByText("Checklist item").parentElement).toHaveTextContent("Uncategorised");
  });

  it("never renders the parts that are out of scope", async () => {
    issueApi(importerAdmin, issueDetail({ activity: [{ action: "issue.raised", actor: "Ivy Importer", createdAt: ago(1000) }] }));
    open();
    await screen.findByRole("heading", { name: "Activity" });
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument(); // no comment box
    expect(screen.queryByText(/add a comment/i)).not.toBeInTheDocument();
    for (const text of [/guardian/i, /VeriPura AI/i, /Document name TBC/i, /placeholder/i, /Mandatory/]) {
      expect(document.body.textContent).not.toMatch(text);
    }
  });
});

describe("issue: stepper", () => {
  const states = () => [...document.querySelectorAll(".is-step")].map((el) => [el.textContent!.replace(/[✓\d]/g, "").trim(), ["done", "current", "todo"].find((c) => el.classList.contains(c))]);

  it("marks the current stage and the ones before and after it", async () => {
    issueApi(importerAdmin, issueDetail({ status: "open" }));
    open();
    await screen.findByRole("list", { name: "Issue progress" });
    expect(states()).toEqual([["Open", "current"], ["Correction requested", "todo"], ["Resolved", "todo"]]);
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("Open");
  });

  it("shows the second stage current once a correction is requested", async () => {
    issueApi(importerAdmin, issueDetail({ status: "correction_requested" }));
    open();
    await screen.findByRole("list", { name: "Issue progress" });
    expect(states()).toEqual([["Open", "done"], ["Correction requested", "current"], ["Resolved", "todo"]]);
  });

  it("shows every earlier stage done, and the last one in green, once resolved", async () => {
    issueApi(importerAdmin, issueDetail({ status: "resolved", resolvedAt: "2026-09-18T10:00:00.000Z", availableActions: { requestCorrection: false, resolve: false } }));
    open();
    await screen.findByRole("list", { name: "Issue progress" });
    expect(states()).toEqual([["Open", "done"], ["Correction requested", "done"], ["Resolved", "current"]]);
    expect(document.querySelector(".is-step.current")).toHaveClass("resolved");
    expect(document.querySelector(".is-status")).toHaveClass("resolved");
    expect(screen.getByText(/resolved 2026-09-18/)).toBeInTheDocument();
  });

  it("stepsFor numbers the steps and never runs out of range", () => {
    expect(stepsFor("open").map((s) => s.number)).toEqual([1, 2, 3]);
    expect(stepsFor("resolved").filter((s) => s.state === "done")).toHaveLength(2);
  });
});

describe("issue: activity", () => {
  it("lists what happened, in the order given, with who, when, and any message", async () => {
    issueApi(importerAdmin, issueDetail({
      activity: [
        { action: "issue.raised", actor: "Ivy Importer", createdAt: ago(2 * 24 * 3600 * 1000) },
        { action: "issue.correction_requested", actor: "A user at Sample Exporter Alpha", createdAt: ago(3 * 3600 * 1000), message: "Please reissue with the right reference" },
      ],
    }));
    open();
    await screen.findByRole("region", { name: "Activity" });
    const items = within(screen.getByRole("region", { name: "Activity" })).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("Ivy Importer");
    expect(items[0]).toHaveTextContent("2 days ago");
    expect(items[0]).toHaveTextContent("Raised the issue");
    expect(items[1]).toHaveTextContent("A user at Sample Exporter Alpha");
    expect(items[1]).toHaveTextContent("Requested a correction");
    expect(items[1]).toHaveTextContent("Please reissue with the right reference");
    expect(items[0]!.querySelector(".is-message")).toBeNull();
    expect(items[0]!.querySelector(".is-avatar")).toHaveTextContent("II");
  });

  it("says so when there is no activity", async () => {
    issueApi(importerAdmin, issueDetail({ activity: [] }));
    open();
    expect(await screen.findByText("Nothing has happened on this issue yet.")).toBeInTheDocument();
  });

  it("describeAction words known actions and makes unknown ones readable", () => {
    expect(describeAction("issue.resolved")).toBe("Marked the issue resolved");
    expect(describeAction("issue.something_new")).toBe("Something new");
    expect(describeAction("")).toBe("Updated the issue");
  });
});

describe("issue: which buttons are offered", () => {
  it("offers both actions when the API says the viewer may", async () => {
    issueApi(importerAdmin, issueDetail({ availableActions: { requestCorrection: true, resolve: true } }));
    open();
    expect(await screen.findByRole("button", { name: "Request Correction" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark Resolved" })).toBeInTheDocument();
  });

  it("offers only what is allowed", async () => {
    issueApi(importerAdmin, issueDetail({ availableActions: { requestCorrection: true, resolve: false } }));
    open();
    expect(await screen.findByRole("button", { name: "Request Correction" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark Resolved" })).not.toBeInTheDocument();
  });

  it("offers Mark Resolved alone when only that is allowed", async () => {
    issueApi(importerAdmin, issueDetail({ availableActions: { requestCorrection: false, resolve: true } }));
    open();
    expect(await screen.findByRole("button", { name: "Mark Resolved" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request Correction" })).not.toBeInTheDocument();
  });

  it("offers nothing when the viewer may do nothing, and says a resolved issue is resolved", async () => {
    issueApi(importerAdmin, issueDetail({ status: "resolved", availableActions: { requestCorrection: false, resolve: false } }));
    open();
    expect(await screen.findByText("This issue is resolved.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request Correction|Mark Resolved/ })).not.toBeInTheDocument();
  });

  it("offers nothing, and says nothing more, for an unresolved issue the viewer may not act on", async () => {
    issueApi(importerAdmin, issueDetail({ availableActions: { requestCorrection: false, resolve: false } }));
    open();
    await screen.findByRole("heading", { name: "Problem" });
    expect(screen.queryByRole("button", { name: /Request Correction|Mark Resolved/ })).not.toBeInTheDocument();
    expect(screen.queryByText("This issue is resolved.")).not.toBeInTheDocument();
  });
});

describe("issue: requesting a correction", () => {
  const corrected = () =>
    issueDetail({
      status: "correction_requested",
      availableActions: { requestCorrection: true, resolve: true },
      activity: [{ action: "issue.correction_requested", actor: "Ivy Importer", createdAt: ago(1000), message: "Please reissue" }],
    });

  it("opens a dialog, and will not send an empty message", async () => {
    // The route is mocked so that a stray call would be recorded, not just answered with a 404.
    const api = issueApi(importerAdmin, issueDetail(), { "POST /issues/:id/request-correction": () => corrected() });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Request Correction" }));
    const dialog = screen.getByRole("dialog", { name: "Request correction" });
    expect(within(dialog).getByRole("textbox", { name: /message/i })).toHaveFocus();

    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(within(dialog).getByText("Enter a message for the responsible party.")).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole("textbox"), "   ");
    await userEvent.click(within(dialog).getByRole("button", { name: "Send request" }));
    expect(api.callsTo("POST /issues/:id/request-correction")).toHaveLength(0);
    expect(within(dialog).getByRole("textbox")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("sends the message, closes, and shows the issue as it now stands, then refreshes what depends on it", async () => {
    let current = issueDetail();
    const api = issueApi(importerAdmin, () => current, {
      "POST /issues/:id/request-correction": () => (current = corrected()),
      "GET /consignments/:id/checklist": { checklist: [] },
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Request Correction" }));
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "  Please reissue  ");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const posted = api.callsTo("POST /issues/:id/request-correction");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.params.id).toBe("issue-1");
    expect(posted[0]!.json).toEqual({ message: "Please reissue" });

    expect(document.querySelector(".is-status")).toHaveTextContent("Correction requested");
    expect(document.querySelector(".is-step.current")).toHaveTextContent("Correction requested");
    expect(within(screen.getByRole("region", { name: "Activity" })).getByText("Please reissue")).toBeInTheDocument();
  });

  it("keeps the dialog open with the message and shows why when the server refuses", async () => {
    issueApi(importerAdmin, issueDetail(), { "POST /issues/:id/request-correction": respond(404, { error: "not_found" }) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Request Correction" }));
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "Please reissue");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));

    const alert = await within(screen.getByRole("dialog")).findByRole("alert");
    expect(alert).toHaveTextContent(/not found/i);
    expect(screen.getByRole("textbox", { name: /message/i })).toHaveValue("Please reissue");
    expect(screen.getByRole("button", { name: "Send request" })).toBeEnabled();
  });

  it("does not send twice while the first request is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const api = issueApi(importerAdmin, issueDetail(), { "POST /issues/:id/request-correction": () => new Promise((r) => (release = r)) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Request Correction" }));
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "Please reissue");
    await userEvent.click(screen.getByRole("button", { name: "Send request" }));
    const sending = await screen.findByRole("button", { name: "Sending" });
    expect(sending).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument(); // cannot be dismissed mid-request
    release(corrected());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("POST /issues/:id/request-correction")).toHaveLength(1);
  });

  it("cancelling sends nothing and forgets the draft", async () => {
    const api = issueApi(importerAdmin, issueDetail(), { "POST /issues/:id/request-correction": () => corrected() });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Request Correction" }));
    await userEvent.type(screen.getByRole("textbox", { name: /message/i }), "Draft text");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.callsTo("POST /issues/:id/request-correction")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Request Correction" }));
    expect(screen.getByRole("textbox", { name: /message/i })).toHaveValue("");
  });
});

describe("issue: marking it resolved", () => {
  const done = () => issueDetail({ status: "resolved", resolvedAt: "2026-09-19T10:00:00.000Z", availableActions: { requestCorrection: false, resolve: false } });

  it("asks first, then resolves, and the screen follows", async () => {
    let current = issueDetail();
    const api = issueApi(importerAdmin, () => current, { "POST /issues/:id/resolve": () => (current = done()) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Mark Resolved" }));
    const dialog = screen.getByRole("dialog", { name: "Mark issue resolved" });
    expect(api.callsTo("POST /issues/:id/resolve")).toHaveLength(0); // nothing yet
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark resolved" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("POST /issues/:id/resolve")).toHaveLength(1);
    expect(document.querySelector(".is-status")).toHaveTextContent("Resolved");
    expect(screen.getByText("This issue is resolved.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Request Correction|Mark Resolved/ })).not.toBeInTheDocument();
  });

  it("cancelling changes nothing", async () => {
    const api = issueApi(importerAdmin);
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Mark Resolved" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.callsTo("POST /issues/:id/resolve")).toHaveLength(0);
    expect(document.querySelector(".is-status")).toHaveTextContent("Open");
  });

  it("shows why and stays open when the server refuses", async () => {
    issueApi(importerAdmin, issueDetail(), { "POST /issues/:id/resolve": respond(403, { error: "forbidden" }) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Mark Resolved" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/do not have access/i);
    expect(document.querySelector(".is-status")).toHaveTextContent("Open");
  });
});

describe("issue: after an action, the rest of the app follows", () => {
  it("marks everything that depends on the issue as stale, so the dashboard and roadmap read fresh data next time", async () => {
    let current = issueDetail();
    issueApi(importerAdmin, () => current, {
      "POST /issues/:id/resolve": () => (current = issueDetail({ status: "resolved", availableActions: { requestCorrection: false, resolve: false } })),
      "GET /consignments/:id/checklist": { checklist: [] },
      "GET /consignments": { consignments: [] },
      "GET /action-queue": { orgId: "o", items: [] },
      "GET /parties/workload": { orgId: "o", counterparties: [] },
    });
    const { client } = open();
    // These screens have been read already, as if the user had come from the dashboard or roadmap.
    const cached = [
      ["consignments"],
      ["action-queue"],
      ["parties-workload"],
      ["checklist", current.consignmentId],
    ];
    for (const key of cached) client.setQueryData(key, {});
    for (const key of cached) expect(client.getQueryState(key)!.isInvalidated, key.join("/")).toBe(false);

    await userEvent.click(await screen.findByRole("button", { name: "Mark Resolved" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    for (const key of cached) expect(client.getQueryState(key)!.isInvalidated, key.join("/")).toBe(true);
  });

  it("does not mark unrelated consignments' checklists as stale", async () => {
    let current = issueDetail();
    issueApi(importerAdmin, () => current, {
      "POST /issues/:id/resolve": () => (current = issueDetail({ status: "resolved", availableActions: { requestCorrection: false, resolve: false } })),
    });
    const { client } = open();
    client.setQueryData(["checklist", "some-other-consignment"], {});
    await userEvent.click(await screen.findByRole("button", { name: "Mark Resolved" }));
    await userEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(client.getQueryState(["checklist", "some-other-consignment"])!.isInvalidated).toBe(false);
  });
});

describe("issue: loading and errors", () => {
  it("shows a loading state first", async () => {
    issueApi(importerAdmin, () => new Promise(() => {}) as never);
    open();
    expect(await screen.findByText("Loading issue")).toBeInTheDocument();
  });

  it("shows Not found with a way back for an issue the viewer cannot see (the API answers 404 for both cases)", async () => {
    issueApi(importerAdmin, issueDetail(), { "GET /issues/:id": respond(404, { error: "not_found" }) });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent(/not found/i);
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
  });

  it("offers a retry after a server error", async () => {
    let attempts = 0;
    issueApi(importerAdmin, issueDetail(), { "GET /issues/:id": () => (++attempts === 1 ? respond(500, { error: "boom" }) : issueDetail()) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Problem" })).toBeInTheDocument();
  });

  it("asks for the issue in the address", async () => {
    const api = issueApi(importerAdmin);
    open();
    await screen.findByRole("heading", { name: "Problem" });
    expect(api.callsTo("GET /issues/:id")[0]!.params.id).toBe("issue-1");
    api.expectNothingUnmocked();
  });
});
