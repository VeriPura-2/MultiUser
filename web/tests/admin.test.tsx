import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { AdminOrganizationSummary, RolePermission } from "../src/api/types";
import { NOT_APPLICABLE, configuredCounts, permissionRow } from "../src/screens/admin/model";
import { adminApi, importerAdmin, orgDetail, pendingOrg, superadmin } from "./fixtures";
import { respond } from "./mockApi";
import { renderApp } from "./renderApp";

// Built from code points so this file contains no dash character itself.
const DASHES = new RegExp(`^[-${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]+$`);
const open = () => renderApp("/admin");
const one = pendingOrg({ id: "org-1", name: "Applicant One", orgType: "exporter" });
const two = pendingOrg({ id: "org-2", name: "Applicant Two", orgType: "lab_cert", createdAt: "2026-09-17T09:00:00.000Z", applicant: { name: null, email: "two@applicant.example.test" } });
const panel = (name: string) => screen.findByRole("region", { name: `Application from ${name}` });
const rule = (over: Partial<RolePermission> = {}): RolePermission => ({
  documentTypeId: "d", documentTypeName: "Doc", viewLevel: "full", canEdit: true, canDownload: false, canApprove: true, configured: true, ...over,
});

describe("approval: the queue", () => {
  it("lists each pending organization with its type, applicant contact and date, oldest first as the API gives", async () => {
    adminApi(superadmin, { pending: [one, two] });
    open();
    const table = (await screen.findAllByRole("table"))[0]!;
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Applicant One");
    expect(within(rows[0]!).getByText("Exporter")).toHaveClass("otag", "exporter");
    expect(rows[0]).toHaveTextContent("pat@applicant-one.example.test");
    expect(rows[0]).toHaveTextContent("2026-09-16");
    expect(rows[1]).toHaveTextContent("Applicant Two");
    expect(within(rows[1]!).getByText("Lab / Cert")).toHaveClass("otag", "lab_cert");
    expect(rows[1]).toHaveTextContent("2026-09-17");
  });

  it("asks only for organizations pending approval", async () => {
    const api = adminApi(superadmin, { pending: [one] });
    open();
    await screen.findByText("Applicant One");
    expect(api.callsTo("GET /admin/organizations").every((c) => c.query.get("status") === "pending_approval")).toBe(true);
  });

  it("shows how many are waiting in the top bar", async () => {
    adminApi(superadmin, { pending: [one, two] });
    open();
    expect(await screen.findByText("org-approvals · queue: 2 pending")).toBeInTheDocument();
  });

  it("selects the first application, and switching shows the other one's detail", async () => {
    const api = adminApi(superadmin, { pending: [one, two] });
    open();
    await panel("Applicant One");
    expect(screen.getByRole("button", { name: "Reviewing Applicant One" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Review Applicant Two" }));
    const second = await panel("Applicant Two");
    expect(second).toHaveTextContent("Application #");
    expect(screen.getByRole("button", { name: "Reviewing Applicant Two" })).toHaveAttribute("aria-pressed", "true");
    expect(api.callsTo("GET /admin/organizations/:id").map((c) => c.params.id)).toEqual(["org-1", "org-2"]);
  });

  it("says when nothing is waiting, and the top bar says 0", async () => {
    adminApi(superadmin, { pending: [] });
    open();
    expect(await screen.findByText("No organizations are waiting for approval")).toBeInTheDocument();
    expect(await screen.findByText("org-approvals · queue: 0 pending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve organization" })).not.toBeInTheDocument();
  });

  it("shows a loading state and an error with a retry", async () => {
    let attempts = 0;
    adminApi(superadmin, {}, { "GET /admin/organizations": () => (++attempts === 1 ? respond(500, { error: "boom" }) : { organizations: [one] }) });
    open();
    await userEvent.click((await screen.findAllByRole("button", { name: "Try again" }))[0]!);
    expect(await screen.findByText("Applicant One")).toBeInTheDocument();
  });

  it("shows loading first", async () => {
    adminApi(superadmin, {}, { "GET /admin/organizations": () => new Promise(() => {}) });
    open();
    expect(await screen.findByText("Loading applications")).toBeInTheDocument();
  });
});

describe("approval: the detail panel", () => {
  it("shows the applicant's facts, and n/a where the API has none", async () => {
    adminApi(superadmin, { pending: [two], detail: (id) => orgDetail({ ...two, id }) });
    open();
    const p = await panel("Applicant Two");
    const facts = p.querySelector(".ad-facts")!;
    expect(facts).toHaveTextContent("Contactn/a");
    expect(facts).toHaveTextContent("Emailtwo@applicant.example.test");
    expect(facts).toHaveTextContent("Submitted2026-09-17");
    expect(facts).toHaveTextContent("StatusPending approval");
    expect(p.textContent).not.toMatch(/Country/); // not in the data, so not shown
  });

  it("shows n/a, never a dash, for an applicant who is missing entirely", async () => {
    adminApi(superadmin, { pending: [{ ...one, applicant: null }], detail: (id) => orgDetail({ ...one, id, applicant: null }) });
    open();
    const p = await panel("Applicant One");
    expect(p.querySelector(".ad-facts")).toHaveTextContent("Contactn/a");
    expect(p.querySelector(".ad-facts")).toHaveTextContent("Emailn/a");
    expect(screen.getAllByText("n/a").length).toBeGreaterThan(1);
  });

  it("shows an error with a retry when the detail fails, without losing the queue", async () => {
    let attempts = 0;
    adminApi(superadmin, { pending: [one] }, { "GET /admin/organizations/:id": () => (++attempts === 1 ? respond(500, { error: "boom" }) : orgDetail({ id: "org-1", name: "Applicant One" })) });
    open();
    await userEvent.click((await screen.findAllByRole("button", { name: "Try again" }))[0]!);
    expect(await panel("Applicant One")).toBeInTheDocument();
    expect(screen.getAllByText("Applicant One").length).toBeGreaterThan(0);
  });
});

describe("approval: the default permission table shows what the API returns", () => {
  it("shows each role, and each document with its view level and the three grants", async () => {
    adminApi(superadmin, { pending: [one] });
    open();
    const p = await panel("Applicant One");
    const perm = within(p).getByRole("table");
    expect(within(perm).getByText("Sample Admin Role (organization admin)")).toBeInTheDocument();
    expect(within(perm).getByText("Sample Reader Role")).toBeInTheDocument();
    const rows = within(perm).getAllByRole("row");
    const cells = (row: HTMLElement) => within(row).getAllByRole("cell").map((c) => c.textContent);
    const docB = rows.find((r) => r.textContent!.startsWith("Sample Doc B") && r.textContent!.includes("Full"))!;
    expect(cells(docB)).toEqual(["Sample Doc B", "Full", "Yes", "Yes", "Yes"]);
    const docA = rows.find((r) => r.textContent!.startsWith("Sample Doc A") && r.textContent!.includes("Full"))!;
    expect(cells(docA)).toEqual(["Sample Doc A", "Full", "Yes", "Yes", "No"]);
  });

  it("shows n/a where a grant does not apply, and Not configured where no rule exists", async () => {
    adminApi(superadmin, { pending: [one] });
    open();
    const p = await panel("Applicant One");
    const rows = within(within(p).getByRole("table")).getAllByRole("row");
    const statusOnly = rows.find((r) => r.textContent!.includes("Status only"))!;
    expect(within(statusOnly).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Sample Doc A", "Status only", "n/a", "n/a", "n/a"]);
    const missing = rows.find((r) => r.textContent!.includes("Not configured"))!;
    expect(within(missing).getAllByRole("cell").map((c) => c.textContent)).toEqual(["Sample Doc B", "Not configured"]);
    expect(within(missing).getByText("Not configured")).toHaveAttribute("colspan", "4");
  });

  it("uses no dash character in any table cell", async () => {
    adminApi(superadmin, { pending: [one] });
    open();
    const p = await panel("Applicant One");
    for (const cell of within(p).getAllByRole("cell")) expect(cell.textContent).not.toMatch(DASHES); // a hyphen, en dash, or em dash on its own
  });

  it("says how many rules have nothing configured, and nothing when all are", async () => {
    adminApi(superadmin, { pending: [one] });
    const first = open();
    expect((await panel("Applicant One")).textContent).toContain("1 of 4 have no rule configured.");
    first.unmount();

    const allSet = orgDetail({ id: "org-1", name: "Applicant One", roles: [{ name: "R", isOrgAdmin: true, permissions: [rule({ documentTypeId: "x", documentTypeName: "Only Doc" })] }] });
    adminApi(superadmin, { pending: [one], detail: () => allSet });
    open();
    const p = await panel("Applicant One");
    expect(p.textContent).not.toMatch(/have no rule configured/);
  });

  it("says so when there are no document types, instead of drawing an empty table", async () => {
    adminApi(superadmin, { pending: [one], detail: (id) => orgDetail({ id, name: "Applicant One", roles: [{ name: "R", isOrgAdmin: true, permissions: [] }] }) });
    open();
    const p = await panel("Applicant One");
    expect(within(p).getByText(/No document types exist yet/)).toBeInTheDocument();
    expect(within(p).queryByRole("table")).not.toBeInTheDocument();
  });

  it("does not show the mockup's sample rules as if they were real", async () => {
    adminApi(superadmin, { pending: [one] });
    open();
    await panel("Applicant One");
    for (const text of [/Compliance Manager/, /Reviewer/, /Org Admin\b/, /Fazenda/, /Hallow/, /Selo Verde/, /ORG-8842/, /Brazil/]) {
      expect(document.body.textContent).not.toMatch(text);
    }
  });

  it("permissionRow: n/a for anything but full view, Yes and No for full, not configured with no rule", () => {
    expect(permissionRow(rule({ viewLevel: "full", canEdit: true, canDownload: false, canApprove: true }))).toMatchObject({
      kind: "rule", view: { text: "Full" }, edit: { text: "Yes", tone: "yes" }, download: { text: "No", tone: "no" }, approve: { text: "Yes" },
    });
    for (const viewLevel of ["status_only", "hidden"] as const) {
      const row = permissionRow(rule({ viewLevel, canEdit: true, canDownload: true, canApprove: true }));
      expect(row).toMatchObject({ edit: { text: NOT_APPLICABLE }, download: { text: NOT_APPLICABLE }, approve: { text: NOT_APPLICABLE } });
    }
    expect(permissionRow(rule({ viewLevel: "hidden" }))).toMatchObject({ view: { text: "Hidden" } });
    expect(permissionRow(rule({ configured: false, viewLevel: null }))).toEqual({ kind: "not_configured", documentTypeName: "Doc" });
    expect(permissionRow(rule({ configured: true, viewLevel: null }))).toMatchObject({ kind: "not_configured" });
    expect(permissionRow(rule({ configured: false, viewLevel: "full" }))).toMatchObject({ kind: "not_configured" });
  });

  it("configuredCounts counts unconfigured rules across every role", () => {
    const roles = [
      { name: "A", isOrgAdmin: true, permissions: [rule(), rule({ configured: false, viewLevel: null })] },
      { name: "B", isOrgAdmin: false, permissions: [rule({ configured: false, viewLevel: null }), rule({ configured: true, viewLevel: null })] },
    ];
    // A rule with no view level is not configured however the flag reads: nothing is assumed for it.
    expect(configuredCounts(roles)).toEqual({ notConfigured: 3, total: 4 });
    expect(configuredCounts([])).toEqual({ notConfigured: 0, total: 0 });
  });
});

describe("approval: approving and rejecting", () => {
  /** A pending list that loses an organization once it has been decided, like the real API. */
  function world() {
    let pending: AdminOrganizationSummary[] = [one, two];
    const api = adminApi(superadmin, { pending: () => pending }, {
      "POST /admin/organizations/:id/approve": (r: { params: { id: string } }) => {
        pending = pending.filter((o) => o.id !== r.params.id);
        return orgDetail({ id: r.params.id, status: "active" });
      },
      "POST /admin/organizations/:id/reject": (r: { params: { id: string } }) => {
        pending = pending.filter((o) => o.id !== r.params.id);
        return orgDetail({ id: r.params.id, status: "rejected" });
      },
    });
    return api;
  }

  it("asks first, explaining what approval does, and sends nothing until confirmed", async () => {
    const api = world();
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve organization" }));
    const dialog = screen.getByRole("dialog", { name: "Approve organization" });
    expect(dialog).toHaveTextContent("This approves Applicant One");
    expect(dialog).toHaveTextContent("five standard roles");
    expect(api.callsTo("POST /admin/organizations/:id/approve")).toHaveLength(0);
    await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.callsTo("POST /admin/organizations/:id/approve")).toHaveLength(0);
  });

  it("approves the selected organization, says so, and moves on to the next one", async () => {
    const api = world();
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve organization" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Applicant One was approved.");
    expect(api.callsTo("POST /admin/organizations/:id/approve").map((c) => c.params.id)).toEqual(["org-1"]);
    expect(await panel("Applicant Two")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Application from Applicant One" })).not.toBeInTheDocument();
    expect(await screen.findByText("org-approvals · queue: 1 pending")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rejects after its own confirmation, and says so", async () => {
    const api = world();
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Review Applicant Two" }));
    await panel("Applicant Two");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = screen.getByRole("dialog", { name: "Reject application" });
    expect(dialog).toHaveTextContent("rejects the application from Applicant Two");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject application" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Applicant Two was rejected.");
    expect(api.callsTo("POST /admin/organizations/:id/reject").map((c) => c.params.id)).toEqual(["org-2"]);
    expect(api.callsTo("POST /admin/organizations/:id/approve")).toHaveLength(0);
    expect(await panel("Applicant One")).toBeInTheDocument();
  });

  it("shows the empty state once the last application is decided", async () => {
    let pending = [one];
    adminApi(superadmin, { pending: () => pending }, {
      "POST /admin/organizations/:id/approve": () => {
        pending = [];
        return orgDetail({ id: "org-1", status: "active" });
      },
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve organization" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await screen.findByText("No organizations are waiting for approval")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Applicant One was approved.");
  });

  it("marks the pending list and the exporter directory stale, since approval changes both", async () => {
    world();
    const { client } = open();
    client.setQueryData(["exporters"], []);
    await userEvent.click(await screen.findByRole("button", { name: "Approve organization" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await screen.findByRole("status");
    expect(client.getQueryState(["exporters"])!.isInvalidated).toBe(true);
  });

  it("shows why and stays open when the server refuses, and nothing is announced as done", async () => {
    adminApi(superadmin, { pending: [one] }, { "POST /admin/organizations/:id/approve": respond(403, { error: "forbidden", message: "Only VeriPura superadmin can do this" }) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve organization" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(/do not have access/i);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("cannot be sent twice or dismissed while the request is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const api = adminApi(superadmin, { pending: [one] }, { "POST /admin/organizations/:id/approve": () => new Promise((r) => (release = r)) });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Approve organization" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    const working = await screen.findByRole("button", { name: "Working" });
    expect(working).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await userEvent.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    release(orgDetail({ id: "org-1", status: "active" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.callsTo("POST /admin/organizations/:id/approve")).toHaveLength(1);
  });
});

describe("approval: who can see it", () => {
  it("sends anyone who is not a superadmin back to the dashboard, and never asks for the queue", async () => {
    const api = adminApi(importerAdmin, {}, { "GET /consignments": { consignments: [] }, "GET /parties/workload": { orgId: "o", counterparties: [] }, "GET /action-queue": { orgId: "o", items: [] } });
    open();
    expect(await screen.findByRole("heading", { name: "Portfolio overview" })).toBeInTheDocument();
    expect(api.callsTo("GET /admin/organizations")).toHaveLength(0);
  });

  it("puts a superadmin on the console from the front page", async () => {
    adminApi(superadmin, { pending: [one] });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Pending organization applications" })).toBeInTheDocument();
  });
});
