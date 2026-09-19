import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { COUNTRY_CODES, countryOptions } from "../src/countries";
import { MAX_FILE_BYTES, buildIntakeForm, fileProblem, validateIntake, EMPTY_INTAKE } from "../src/screens/intake/model";
import { formatBytes } from "../src/format";
import { consignment, dashboardApi, detail, exporterAdmin, exporterOrgs, importerAdmin, intakeApi } from "./fixtures";
import { respond } from "./mockApi";
import { renderApp } from "./renderApp";

const open = () => renderApp("/consignments/new");
const pdf = (name = "po.pdf", body = "purchase order") => new File([body], name, { type: "application/pdf" });
const fileInput = () => screen.getByLabelText("Purchase order file") as HTMLInputElement;

/** Fills the whole form; the file is uploaded through the real input. */
async function fillAll(overrides: { hs?: string; commodity?: string } = {}) {
  await screen.findByRole("option", { name: "Sample Exporter Alpha" });
  await userEvent.upload(fileInput(), pdf());
  await userEvent.selectOptions(screen.getByLabelText("Exporter"), "org-alpha");
  await userEvent.type(screen.getByLabelText("Product description"), overrides.commodity ?? "  Frozen boneless beef  ");
  await userEvent.selectOptions(screen.getByLabelText("Origin"), "BR");
  await userEvent.selectOptions(screen.getByLabelText("Destination"), "GB");
  if (overrides.hs) await userEvent.type(screen.getByLabelText(/HS code/), overrides.hs);
}
const submit = () => userEvent.click(screen.getByRole("button", { name: "Submit purchase order" }));
const created = () => detail({ id: "new-consignment-id", commodity: "Frozen boneless beef" });

describe("intake: who may use it", () => {
  it("shows the form to an importer, with their organization", async () => {
    intakeApi(importerAdmin);
    open();
    expect(await screen.findByRole("heading", { level: 1, name: "New consignment" })).toBeInTheDocument();
    expect(screen.getByText("Sample Importer Ltd · Importer")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Purchase order" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Consignment details" })).toBeInTheDocument();
  });

  it("tells an exporter it is for importers, and asks the API for nothing more", async () => {
    const api = intakeApi(exporterAdmin);
    open();
    expect(await screen.findByText("Only importers can start a consignment")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit purchase order" })).not.toBeInTheDocument();
    expect(api.callsTo("GET /organizations/exporters")).toHaveLength(0);
  });

  it("makes no claim that anything is extracted or filled in for the user", async () => {
    intakeApi(importerAdmin);
    open();
    await screen.findByRole("heading", { name: "Consignment details" });
    for (const text of [/AI-extracted/i, /IOTA/i, /Tangle/i, /extracted/i, /VeriPura AI/i, /Quantity/i, /Seller/i, /Continue to Compliance/i]) {
      expect(document.body.textContent).not.toMatch(text);
    }
    expect(screen.getByText(/Nothing is filled in for you/)).toBeInTheDocument();
  });
});

describe("intake: the fields", () => {
  it("lists the approved exporters the API returns, and countries by name with codes as values", async () => {
    intakeApi(importerAdmin);
    open();
    const exporter = await screen.findByLabelText("Exporter");
    expect(within(exporter).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose an exporter", "Sample Exporter Alpha", "Sample Exporter Bravo"]);
    const origin = screen.getByLabelText("Origin");
    expect(within(origin).getByRole("option", { name: "Brazil" })).toHaveValue("BR");
    expect(within(origin).getByRole("option", { name: "United Kingdom" })).toHaveValue("GB");
    expect(within(origin).getAllByRole("option")).toHaveLength(COUNTRY_CODES.length + 1);
    expect(screen.getByLabelText("HS code (optional)")).toBeInTheDocument();
  });

  it("shows a loading state, an empty note, or an error with a retry for the exporter list", async () => {
    intakeApi(importerAdmin, [], { "GET /organizations/exporters": () => new Promise(() => {}) });
    const first = open();
    expect(await screen.findByText("Loading exporters")).toBeInTheDocument();
    first.unmount();

    intakeApi(importerAdmin, []);
    const second = open();
    expect(await screen.findByText(/no approved exporters yet/i)).toBeInTheDocument();
    second.unmount();

    let attempts = 0;
    intakeApi(importerAdmin, exporterOrgs, {
      "GET /organizations/exporters": () => (++attempts === 1 ? respond(500, { error: "boom" }) : { organizations: exporterOrgs }),
    });
    open();
    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("option", { name: "Sample Exporter Alpha" })).toBeInTheDocument();
  });
});

describe("intake: the file", () => {
  it("takes a chosen file and shows its name, size and readiness", async () => {
    intakeApi(importerAdmin);
    open();
    await screen.findByLabelText("Exporter");
    await userEvent.upload(fileInput(), pdf("Purchase_Order_0847.pdf", "x".repeat(2048)));
    expect(screen.getByText("Purchase_Order_0847.pdf")).toBeInTheDocument();
    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose a different file" })).toBeInTheDocument();
    expect(screen.queryByText(/Drop the purchase order here/)).not.toBeInTheDocument();
  });

  it("takes a dropped file", async () => {
    intakeApi(importerAdmin);
    open();
    await screen.findByLabelText("Exporter");
    const zone = screen.getByText(/Drop the purchase order here/).closest(".in-drop")!;
    fireEvent.dragOver(zone);
    expect(zone).toHaveClass("over");
    fireEvent.drop(zone, { dataTransfer: { files: [pdf("dropped.pdf")] } });
    expect(await screen.findByText("dropped.pdf")).toBeInTheDocument();
  });

  it("accepts one file only, and says so when several are dropped", async () => {
    intakeApi(importerAdmin);
    open();
    await screen.findByLabelText("Exporter");
    const zone = screen.getByText(/Drop the purchase order here/).closest(".in-drop")!;
    fireEvent.drop(zone, { dataTransfer: { files: [pdf("a.pdf"), pdf("b.pdf")] } });
    expect(await screen.findByRole("alert")).toHaveTextContent(/one file at a time/i);
    expect(screen.queryByText("a.pdf")).not.toBeInTheDocument();
  });

  it("refuses an empty file and one over the limit, straight away", async () => {
    intakeApi(importerAdmin);
    open();
    await screen.findByLabelText("Exporter");
    await userEvent.upload(fileInput(), new File([], "empty.pdf"));
    expect(await screen.findByText(/file is empty/i)).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();

    const big = new File(["x"], "big.pdf");
    Object.defineProperty(big, "size", { value: MAX_FILE_BYTES + 1 });
    await userEvent.upload(fileInput(), big);
    expect(await screen.findByText(/over 15 MB/i)).toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
  });

  it("fileProblem and formatBytes draw their lines where the backend does", () => {
    expect(fileProblem(new File([], "a"))).toMatch(/empty/);
    const exact = new File(["x"], "a");
    Object.defineProperty(exact, "size", { value: MAX_FILE_BYTES });
    expect(fileProblem(exact)).toBeNull();
    expect(MAX_FILE_BYTES).toBe(15 * 1024 * 1024);
    expect([formatBytes(500), formatBytes(2048), formatBytes(4.5 * 1024 * 1024)]).toEqual(["500 B", "2 KB", "4.5 MB"]);
  });
});

describe("intake: checking before sending", () => {
  it("names every missing thing, puts focus on the first, and sends nothing", async () => {
    const api = intakeApi(importerAdmin, exporterOrgs, { "POST /consignments": { consignment: created() } });
    open();
    await screen.findByRole("option", { name: "Sample Exporter Alpha" });
    await submit();
    for (const text of ["Add the purchase order file.", "Choose the exporter.", "Enter what is being shipped.", "Choose the country it ships from.", "Choose the country it ships to."]) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    expect(fileInput()).toHaveFocus();
    expect(screen.getByLabelText("Exporter")).toHaveAttribute("aria-invalid", "true");
    expect(api.callsTo("POST /consignments")).toHaveLength(0);
  });

  it("focuses the first field that is wrong, not always the file", async () => {
    const api = intakeApi(importerAdmin, exporterOrgs, { "POST /consignments": { consignment: created() } });
    open();
    await screen.findByRole("option", { name: "Sample Exporter Alpha" });
    await userEvent.upload(fileInput(), pdf());
    await submit();
    expect(screen.getByLabelText("Exporter")).toHaveFocus();
    expect(api.callsTo("POST /consignments")).toHaveLength(0);
  });

  it("treats a blank product description as missing, and clears each message as it is fixed", async () => {
    intakeApi(importerAdmin, exporterOrgs, { "POST /consignments": { consignment: created() } });
    open();
    await fillAll({ commodity: "   " });
    await submit();
    expect(screen.getByText("Enter what is being shipped.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Product description"), "Beef");
    expect(screen.queryByText("Enter what is being shipped.")).not.toBeInTheDocument();
  });

  it("validateIntake asks for exactly the five required things, and not the HS code", () => {
    expect(Object.keys(validateIntake(EMPTY_INTAKE)).sort()).toEqual(["commodity", "destinationCountry", "exporterOrgId", "file", "originCountry"]);
  });
});

describe("intake: submitting", () => {
  it("posts the purchase order as a form, then opens the new consignment's roadmap", async () => {
    const api = intakeApi(importerAdmin, exporterOrgs, {
      "POST /consignments": { consignment: created() },
      "GET /consignments/:id": created(),
      "GET /consignments/:id/checklist": { consignmentId: "new-consignment-id", consignmentStatus: "checklist_received", checklist: [] },
    });
    open();
    await fillAll({ hs: " 0202.30 " });
    await submit();

    expect(await screen.findByRole("heading", { level: 1, name: /Frozen boneless beef/ })).toBeInTheDocument();
    const posted = api.callsTo("POST /consignments");
    expect(posted).toHaveLength(1);
    const form = posted[0]!.form!;
    expect(Object.fromEntries([...form.entries()].filter(([k]) => k !== "file"))).toEqual({
      exporterOrgId: "org-alpha",
      commodity: "Frozen boneless beef",
      originCountry: "BR",
      destinationCountry: "GB",
      hsCode: "0202.30",
    });
    expect((form.get("file") as File).name).toBe("po.pdf");
    expect(posted[0]!.headers.get("content-type")).toBeNull(); // the browser sets the multipart boundary itself
    expect(api.callsTo("GET /consignments/:id")[0]!.params.id).toBe("new-consignment-id");
  });

  it("leaves the HS code out of the form when it is blank", async () => {
    const api = intakeApi(importerAdmin, exporterOrgs, {
      "POST /consignments": { consignment: created() },
      "GET /consignments/:id": created(),
      "GET /consignments/:id/checklist": { consignmentId: "new-consignment-id", consignmentStatus: "checklist_received", checklist: [] },
    });
    open();
    await fillAll({ hs: "   " });
    await submit();
    await screen.findByRole("heading", { level: 1, name: /Frozen boneless beef/ });
    expect(api.callsTo("POST /consignments")[0]!.form!.has("hsCode")).toBe(false);
  });

  it("marks the consignment lists stale so the dashboard shows the new one", async () => {
    intakeApi(importerAdmin, exporterOrgs, {
      "POST /consignments": { consignment: created() },
      "GET /consignments/:id": created(),
      "GET /consignments/:id/checklist": { consignmentId: "new-consignment-id", consignmentStatus: "checklist_received", checklist: [] },
    });
    const { client } = open();
    for (const key of [["consignments"], ["action-queue"], ["parties-workload"]]) client.setQueryData(key, {});
    await fillAll();
    await submit();
    await screen.findByRole("heading", { level: 1, name: /Frozen boneless beef/ });
    for (const key of [["consignments"], ["action-queue"], ["parties-workload"]]) expect(client.getQueryState(key)!.isInvalidated, key[0]).toBe(true);
  });

  it("does not send twice while the first is in flight", async () => {
    let release: (v: unknown) => void = () => {};
    const api = intakeApi(importerAdmin, exporterOrgs, {
      "POST /consignments": () => new Promise((r) => (release = r)),
      "GET /consignments/:id": created(),
      "GET /consignments/:id/checklist": { consignmentId: "new-consignment-id", consignmentStatus: "checklist_received", checklist: [] },
    });
    open();
    await fillAll();
    await submit();
    const sending = await screen.findByRole("button", { name: "Submitting" });
    expect(sending).toBeDisabled();
    await userEvent.click(sending);
    release({ consignment: created() });
    await screen.findByRole("heading", { level: 1, name: /Frozen boneless beef/ });
    expect(api.callsTo("POST /consignments")).toHaveLength(1);
  });

  it("shows why it failed, keeps everything typed, and lets the user try again", async () => {
    let attempts = 0;
    const api = intakeApi(importerAdmin, exporterOrgs, {
      "POST /consignments": () => (++attempts === 1 ? respond(400, { error: "invalid_request", message: "commodity is required" }) : { consignment: created() }),
      "GET /consignments/:id": created(),
      "GET /consignments/:id/checklist": { consignmentId: "new-consignment-id", consignmentStatus: "checklist_received", checklist: [] },
    });
    open();
    await fillAll();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/commodity is required/);
    expect(screen.getByLabelText("Product description")).toHaveValue("  Frozen boneless beef  ");
    expect(screen.getByLabelText("Exporter")).toHaveValue("org-alpha");
    expect(screen.getByText("po.pdf")).toBeInTheDocument();
    await submit();
    await screen.findByRole("heading", { level: 1, name: /Frozen boneless beef/ });
    expect(api.callsTo("POST /consignments")).toHaveLength(2);
  });

  it("explains a refusal in plain words for a network failure too", async () => {
    intakeApi(importerAdmin, exporterOrgs, { "POST /consignments": respond(403, { error: "forbidden", message: "Only importer organizations can submit purchase orders" }) });
    open();
    await fillAll();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/do not have access/i);
  });
});

describe("intake: the purchase order was saved but the checklist service is down (502)", () => {
  const setup = () => {
    const api = intakeApi(importerAdmin, exporterOrgs, {
      "POST /consignments": respond(502, { error: "core_unavailable", message: "VeriPura Core unreachable", consignmentId: "saved-id" }),
    });
    const utils = open();
    return { api, ...utils };
  };

  it("says it was saved, links to it, warns not to resubmit, and offers no way to", async () => {
    const { api } = setup();
    await fillAll();
    await submit();
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Your purchase order was saved");
    expect(notice).toHaveTextContent(/do not submit it again/i);
    expect(within(notice).getByRole("link", { name: "Open the consignment" })).toHaveAttribute("href", "/consignments/saved-id");
    expect(screen.queryByRole("button", { name: "Submit purchase order" })).not.toBeInTheDocument();
    expect(api.callsTo("POST /consignments")).toHaveLength(1);
  });

  it("marks the consignment lists stale, because the consignment exists", async () => {
    const { client } = setup();
    client.setQueryData(["consignments"], {});
    await fillAll();
    await submit();
    await screen.findByText("Your purchase order was saved");
    expect(client.getQueryState(["consignments"])!.isInvalidated).toBe(true);
  });

  it("a 502 that does not name a consignment is an ordinary error, and the form stays", async () => {
    intakeApi(importerAdmin, exporterOrgs, { "POST /consignments": respond(502, { error: "core_unavailable", message: "unreachable" }) });
    open();
    await fillAll();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(/unreachable/);
    expect(screen.getByRole("button", { name: "Submit purchase order" })).toBeEnabled();
  });
});

describe("intake: reaching it from the dashboard", () => {
  it("shows + New Consignment to an importer, linking to the form", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment()] });
    renderApp("/");
    expect(await screen.findByRole("link", { name: "+ New Consignment" })).toHaveAttribute("href", "/consignments/new");
  });

  it("does not show it to an exporter", async () => {
    dashboardApi(exporterAdmin, { consignments: [consignment()] });
    renderApp("/");
    await screen.findByRole("heading", { name: "Portfolio overview" });
    expect(screen.queryByRole("link", { name: "+ New Consignment" })).not.toBeInTheDocument();
  });
});

describe("countries and form helpers", () => {
  it("has each ISO code once, and a real name for every one, sorted by name", () => {
    expect(new Set(COUNTRY_CODES).size).toBe(COUNTRY_CODES.length);
    expect(COUNTRY_CODES.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
    const options = countryOptions();
    expect(options.every((o) => o.name !== o.code)).toBe(true);
    expect(options.map((o) => o.name)).toEqual([...options.map((o) => o.name)].sort((a, b) => a.localeCompare(b)));
    expect(options.some((o) => o.code === "BR" && o.name === "Brazil")).toBe(true);
  });

  it("buildIntakeForm trims, omits a blank HS code, and carries the file", () => {
    const file = pdf("a.pdf");
    const form = buildIntakeForm({ file, exporterOrgId: "x", commodity: "  beef ", hsCode: "  ", originCountry: "BR", destinationCountry: "GB" });
    expect(form.get("commodity")).toBe("beef");
    expect(form.has("hsCode")).toBe(false);
    expect((form.get("file") as File).name).toBe("a.pdf");
  });
});
