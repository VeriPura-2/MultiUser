import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { isFullItem } from "../src/api/types";
import { LIMITED_ACCESS, UNCATEGORISED, buttonsFor, groupChecklist } from "../src/screens/roadmap/model";
import { detail, fullItem, importerAdmin, roadmapApi, statusOnlyItem } from "./fixtures";
import { respond } from "./mockApi";
import { renderApp } from "./renderApp";

const ID = "a1b2c3d4-0000-4000-8000-000000000000";
const open = () => renderApp(`/consignments/${ID}`);
const group = async (name: string) => screen.findByRole("region", { name });
const rowOf = (container: HTMLElement, documentName: string) => within(container).getByText(documentName).closest("li")!;

describe("roadmap: header", () => {
  it("shows the consignment's own facts from GET /consignments/:id, and only those", async () => {
    roadmapApi(importerAdmin, { detail: detail({ commodity: "Chilled ribeye", hsCode: "0201.30", originCountry: "AR" }) });
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "Chilled ribeye · Argentina → United Kingdom" })).toBeInTheDocument();
    expect(screen.getByText("Consignment #A1B2C3D4")).toBeInTheDocument();
    const meta = document.querySelector(".rm-meta")!;
    expect(meta).toHaveTextContent("SellerSample Exporter Alpha");
    expect(meta).toHaveTextContent("BuyerSample Importer Ltd");
    expect(meta).toHaveTextContent("HS Code0201.30");
    expect(meta).toHaveTextContent("StatusIn review");
    expect(meta).toHaveTextContent("Created2026-09-16");
    expect(meta.textContent).not.toMatch(/kg|quantity|tonne/i);
  });

  it("leaves out the HS code when the consignment has none", async () => {
    roadmapApi(importerAdmin, { detail: detail({ hsCode: null }) });
    open();
    await screen.findByText("Seller");
    expect(screen.queryByText("HS Code")).not.toBeInTheDocument();
  });

  it("has one tab, the compliance roadmap, and none of the features that are out of scope", async () => {
    roadmapApi(importerAdmin, { checklist: [fullItem()] });
    open();
    await screen.findByRole("region", { name: "Sample Category One" });
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toHaveTextContent("Compliance Roadmap");
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    for (const text of [/guardian/i, /forensic/i, /ledger/i, /passport/i, /cryptographic/i, /registry/i, /Document name TBC/i, /placeholder/i, /Mandatory/, /pending\.\s/i]) {
      expect(document.body.textContent).not.toMatch(text);
    }
  });

  it("links back to the dashboard and has the theme toggle", async () => {
    roadmapApi(importerAdmin);
    open();
    expect(await screen.findByRole("link", { name: /back to dashboard/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("button", { name: /toggle dark mode/i })).toBeInTheDocument();
  });
});

describe("roadmap: the vessel", () => {
  it("shows the vessel's name, IMO and MMSI in the header when they are known", async () => {
    roadmapApi(importerAdmin, { detail: detail({ vesselName: "Sample Voyager", vesselImo: "9074729", vesselMmsi: "235012345" }) });
    open();
    await screen.findByText("Seller");
    const meta = document.querySelector(".rm-meta")!;
    expect(meta).toHaveTextContent("VesselSample Voyager");
    expect(meta).toHaveTextContent("IMO9074729");
    expect(meta).toHaveTextContent("MMSI235012345");
  });

  it("shows only the parts that are known", async () => {
    roadmapApi(importerAdmin, { detail: detail({ vesselImo: "9074729" }) });
    open();
    await screen.findByText("Seller");
    expect(screen.getByText("IMO")).toBeInTheDocument();
    expect(screen.queryByText("Vessel")).not.toBeInTheDocument();
    expect(screen.queryByText("MMSI")).not.toBeInTheDocument();
  });

  it("shows no vessel at all, and no placeholder, when none has been entered", async () => {
    roadmapApi(importerAdmin, { detail: detail() });
    open();
    await screen.findByText("Seller");
    for (const label of ["Vessel", "IMO", "MMSI"]) expect(screen.queryByText(label)).not.toBeInTheDocument();
  });
});

describe("roadmap: grouping by category from the API", () => {
  it("groups by whatever categories the API names, alphabetically, with counts", async () => {
    roadmapApi(importerAdmin, {
      checklist: [
        fullItem({ documentTypeName: "Zulu Doc", category: "Zebra Filing" }),
        fullItem({ documentTypeName: "Alpha Doc", category: "Aardvark Papers" }),
        fullItem({ documentTypeName: "Alpha Two", category: "Aardvark Papers" }),
      ],
    });
    open();
    await group("Aardvark Papers");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Aardvark Papers (2)", "Zebra Filing (1)"]);
    expect(within(await group("Aardvark Papers")).getAllByRole("listitem")).toHaveLength(2);
  });

  it("puts an item with no category under Uncategorised, after the named ones", async () => {
    roadmapApi(importerAdmin, {
      checklist: [fullItem({ documentTypeName: "No Category Doc", category: null }), fullItem({ documentTypeName: "Filed Doc", category: "Some Category" })],
    });
    open();
    await group("Some Category");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Some Category (1)", `${UNCATEGORISED} (1)`]);
    expect(within(await group(UNCATEGORISED)).getByText("No Category Doc")).toBeInTheDocument();
  });

  it("treats a blank category as none", async () => {
    roadmapApi(importerAdmin, { checklist: [fullItem({ category: "   " })] });
    open();
    expect(await group(UNCATEGORISED)).toBeInTheDocument();
  });

  it("shows each document's name, who provides it, and its status", async () => {
    roadmapApi(importerAdmin, {
      checklist: [
        fullItem({ documentTypeName: "Doc A", requiredBy: "logistics", status: "awaiting_upload" }),
        fullItem({ documentTypeName: "Doc B", requiredBy: "importer", status: "pending" }),
        fullItem({ documentTypeName: "Doc C", requiredBy: "exporter", status: "verified" }),
      ],
    });
    open();
    const g = await group("Sample Category One");
    expect(within(rowOf(g, "Doc A")).getByText("Logistics")).toHaveClass("tag");
    expect(within(rowOf(g, "Doc A")).getByText("Awaiting upload")).toHaveClass("badge", "gray");
    expect(within(rowOf(g, "Doc B")).getByText("Importer")).toBeInTheDocument();
    expect(within(rowOf(g, "Doc B")).getByText("Under review")).toHaveClass("badge", "blue");
    expect(within(rowOf(g, "Doc C")).getByText("Exporter")).toBeInTheDocument();
    expect(within(rowOf(g, "Doc C")).getByText("Verified")).toHaveClass("badge", "green");
  });
});

describe("roadmap: hidden documents", () => {
  it("shows only what the API sends: a document it left out (hidden from this user) appears nowhere, not even in a count", async () => {
    // The API omits hidden items entirely, so the roadmap has nothing to hide: it must not invent, count or name anything else.
    roadmapApi(importerAdmin, {
      checklist: [fullItem({ documentTypeName: "Visible Doc", category: "Only Category" })],
    });
    open();
    const g = await group("Only Category");
    expect(within(g).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Only Category (1)"]);
    expect(document.body.textContent).not.toMatch(/Hidden|Sealed|Limited access/);
    expect(document.querySelectorAll(".row")).toHaveLength(1);
  });
});

describe("roadmap: what a status-only viewer sees", () => {
  it("shows name and status only, under Limited access, with nothing else", async () => {
    roadmapApi(importerAdmin, {
      checklist: [statusOnlyItem({ documentTypeName: "Sealed Certificate", status: "flagged", canEdit: false })],
    });
    open();
    const g = await group(LIMITED_ACCESS);
    const row = rowOf(g, "Sealed Certificate");
    expect(within(row).getByText("Correction needed")).toHaveClass("badge", "red");
    expect(row.querySelector(".tag")).toBeNull(); // no requiredBy
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
    expect(within(row).queryByRole("link")).not.toBeInTheDocument(); // no issue, so nothing to open
    expect(row.textContent).toBe("Sealed CertificateCorrection needed");
    expect(document.body.textContent).not.toContain(UNCATEGORISED);
  });

  it("keeps full and status-only items apart when a checklist has both", async () => {
    roadmapApi(importerAdmin, {
      checklist: [fullItem({ documentTypeName: "Open Doc", category: "Real Category" }), statusOnlyItem({ documentTypeName: "Sealed Doc" })],
    });
    open();
    await group("Real Category");
    expect(within(await group("Real Category")).queryByText("Sealed Doc")).not.toBeInTheDocument();
    expect(within(await group(LIMITED_ACCESS)).getByText("Sealed Doc")).toBeInTheDocument();
  });
});

describe("roadmap: buttons follow the flags", () => {
  const item = (o: Parameters<typeof fullItem>[0]) => fullItem({ documentTypeName: "Target Doc", ...o });
  const renderOne = async (o: Parameters<typeof fullItem>[0]) => {
    roadmapApi(importerAdmin, { checklist: [item(o)] });
    open();
    return rowOf(await group("Sample Category One"), "Target Doc");
  };

  it("shows a disabled Upload with a reason when the user may edit and the document is awaited", async () => {
    const row = await renderOne({ canEdit: true, status: "awaiting_upload" });
    const upload = within(row).getByRole("button", { name: "Upload" });
    expect(upload).toBeDisabled();
    expect(upload.parentElement).toHaveAttribute("title", expect.stringMatching(/later stage/i));
  });

  it("shows no Upload without the edit flag", async () => {
    const row = await renderOne({ canEdit: false, status: "awaiting_upload" });
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows no Upload once a document is verified, even with the edit flag", async () => {
    const row = await renderOne({ canEdit: true, status: "verified" });
    expect(within(row).queryByRole("button", { name: "Upload" })).not.toBeInTheDocument();
  });

  it("shows Download only with the download flag and only once there is a document", async () => {
    expect(within(await renderOne({ canDownload: true, status: "verified" })).getByRole("button", { name: "Download" })).toBeDisabled();
  });

  it("shows no Download for an awaited document, or without the flag", async () => {
    const row = await renderOne({ canDownload: true, status: "awaiting_upload" });
    expect(within(row).queryByRole("button", { name: "Download" })).not.toBeInTheDocument();
  });

  it("shows Approve only with the approve flag and a document under review", async () => {
    expect(within(await renderOne({ canApprove: true, status: "pending" })).getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("shows no Approve for a document that is not under review, even with the flag", async () => {
    for (const status of ["awaiting_upload", "verified", "flagged"] as const) {
      const { unmount } = (roadmapApi(importerAdmin, { checklist: [item({ canApprove: true, status })] }), open());
      const row = rowOf(await group("Sample Category One"), "Target Doc");
      expect(within(row).queryByRole("button", { name: "Approve" }), status).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows no Approve without the flag", async () => {
    const row = await renderOne({ canApprove: false, status: "pending" });
    expect(within(row).queryByRole("button")).not.toBeInTheDocument();
  });

  it("buttonsFor gives status-only items no buttons whatever their flags say", () => {
    expect(buttonsFor(statusOnlyItem({ status: "pending" }))).toEqual({ upload: false, download: false, approve: false });
  });
});

describe("roadmap: flagged documents", () => {
  it("makes the whole row a link to its issue, showing what is wrong", async () => {
    roadmapApi(importerAdmin, {
      checklist: [
        fullItem({
          documentTypeName: "Flagged Doc",
          status: "flagged",
          canEdit: true,
          openIssue: { issueId: "issue-42", problem: "A reference number does not match", expectedValue: "1", foundValue: "2", responsibleOrgType: "exporter", status: "open" },
        }),
      ],
    });
    open();
    const link = (await screen.findByText("Flagged Doc")).closest("a")!;
    expect(link).toHaveAttribute("href", "/issues/issue-42");
    expect(link).toHaveClass("flagged");
    expect(link).toHaveTextContent("A reference number does not match");
    expect(link).toHaveTextContent("Correction needed");
    expect(within(link).queryByRole("button")).not.toBeInTheDocument(); // no button nested in a link
  });

  it("is not a link when a flagged document has no open issue to open", async () => {
    roadmapApi(importerAdmin, { checklist: [fullItem({ documentTypeName: "Flagged Alone", status: "flagged", openIssue: null })] });
    open();
    const row = (await screen.findByText("Flagged Alone")).closest("li")!;
    expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    expect(within(row).getByText("Correction needed")).toBeInTheDocument();
  });
});

describe("roadmap: loading, empty, errors", () => {
  it("shows loading states first", async () => {
    roadmapApi(importerAdmin, {}, { "GET /consignments/:id": () => new Promise(() => {}), "GET /consignments/:id/checklist": () => new Promise(() => {}) });
    open();
    expect(await screen.findByText("Loading checklist")).toBeInTheDocument();
    expect(screen.getByText("Loading consignment details")).toBeInTheDocument();
  });

  it("says why there is nothing to list when the checklist has not arrived", async () => {
    roadmapApi(importerAdmin, { detail: detail({ status: "checklist_pending" }), checklist: [] });
    open();
    expect(await screen.findByText("No checklist yet")).toBeInTheDocument();
    expect(screen.getByText("Awaiting checklist")).toBeInTheDocument();
  });

  it("shows Not found, with a way back, for a consignment the user cannot see", async () => {
    roadmapApi(importerAdmin, {}, { "GET /consignments/:id": respond(404, { error: "not_found" }) });
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent(/not found/i);
    expect(screen.getByRole("link", { name: "Back to dashboard" })).toHaveAttribute("href", "/");
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
  });

  it("keeps the header when only the checklist fails, and the retry works", async () => {
    let attempts = 0;
    roadmapApi(importerAdmin, { checklist: [fullItem({ documentTypeName: "Recovered Doc" })] }, {
      "GET /consignments/:id/checklist": () => (++attempts === 1 ? respond(500, { error: "boom" }) : { consignmentId: ID, consignmentStatus: "checklist_received", checklist: [fullItem({ documentTypeName: "Recovered Doc" })] }),
    });
    open();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Frozen boneless beef");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Recovered Doc")).toBeInTheDocument();
  });

  it("asks for the right consignment and its checklist", async () => {
    const api = roadmapApi(importerAdmin, { checklist: [fullItem()] });
    open();
    await screen.findByRole("region", { name: "Sample Category One" });
    expect(api.callsTo("GET /consignments/:id")).toHaveLength(1);
    expect(api.callsTo("GET /consignments/:id/checklist")[0]!.params.id).toBe(ID);
    await waitFor(() => api.expectNothingUnmocked());
  });
});

describe("groupChecklist", () => {
  it("keeps the API's order inside a group and never invents a group", () => {
    const a = fullItem({ documentTypeName: "One", category: "G" });
    const b = fullItem({ documentTypeName: "Two", category: "G" });
    const groups = groupChecklist([b, a]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.items.map((i) => (isFullItem(i) ? i.documentTypeName : ""))).toEqual(["Two", "One"]);
    expect(groupChecklist([])).toEqual([]);
  });
});
