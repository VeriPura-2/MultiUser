import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { devUsers, exporterAdmin, importerAdmin, meFor, superadmin } from "./fixtures";
import { mockApi, respond } from "./mockApi";
import { renderApp } from "./renderApp";

describe("app shell", () => {
  it("shows the signed-in user's name and organization in the sidebar, from GET /me", async () => {
    localStorage.setItem("vp-dev-user", importerAdmin.userId);
    const api = mockApi({ "GET /me": importerAdmin });
    renderApp("/");

    const sidebar = await screen.findByRole("navigation", { name: "Main" });
    expect(within(sidebar).getByText("Ivy Importer")).toBeInTheDocument();
    expect(within(sidebar).getByText("Sample Importer Ltd")).toBeInTheDocument();
    expect(within(sidebar).getByText("II")).toBeInTheDocument(); // initials avatar
    expect(api.callsTo("GET /me")).toHaveLength(1);
  });

  it("falls back to the email when the user has no name", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": { ...importerAdmin, name: null } });
    renderApp("/");
    const sidebar = await screen.findByRole("navigation", { name: "Main" });
    expect(within(sidebar).getByText("admin@importer.example.test")).toBeInTheDocument();
  });

  it("lists the six sections; only Dashboard and Consignments lead anywhere, the rest are disabled with a reason", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": importerAdmin });
    renderApp("/");
    const sidebar = await screen.findByRole("navigation", { name: "Main" });

    expect(within(sidebar).getByRole("link", { name: "Dashboard" })).toHaveAttribute("href", "/");
    expect(within(sidebar).getByRole("link", { name: "Dashboard" })).toHaveClass("active");
    expect(within(sidebar).getByRole("link", { name: "Consignments" })).toHaveAttribute("href", "/#consignments");
    for (const name of ["Parties", "Issues", "Documents", "Settings"]) {
      const entry = within(sidebar).getByText(name);
      expect(entry).toHaveAttribute("aria-disabled", "true");
      expect(entry).toHaveAttribute("title", expect.stringMatching(/not built yet/i));
      expect(entry).not.toHaveAttribute("href");
    }
  });

  it("shows the dashboard heading and a theme toggle once the user is known", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": importerAdmin });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Portfolio overview" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle dark mode/i })).toBeInTheDocument();
  });

  it("shows a loading state while /me is on its way", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": () => new Promise(() => {}) }); // never resolves
    renderApp("/");
    expect(await screen.findByText("Loading")).toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Portfolio overview" })).not.toBeInTheDocument();
  });

  it("shows an error state with a retry when /me fails, and recovers on retry", async () => {
    localStorage.setItem("vp-dev-user", "x");
    let attempts = 0;
    mockApi({ "GET /me": () => (++attempts === 1 ? respond(500, { message: "database is down" }) : importerAdmin) });
    renderApp("/");

    expect(await screen.findByRole("alert")).toHaveTextContent("database is down");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Portfolio overview" })).toBeInTheDocument();
  });

  it("explains a network failure in plain words", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": () => Promise.reject(new TypeError("Failed to fetch")) });
    renderApp("/");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/i);
  });

  it("shows a page-not-found state for an unknown address, with a way back", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": importerAdmin });
    renderApp("/nowhere/at/all");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /back to the dashboard/i })).toHaveAttribute("href", "/");
  });
});

describe("the superadmin route", () => {
  it("is inaccessible to a non-superadmin: they are sent to the dashboard and never see the console", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": importerAdmin });
    renderApp("/admin");

    expect(await screen.findByRole("heading", { name: "Portfolio overview" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pending organization applications" })).not.toBeInTheDocument();
    expect(screen.queryByText("Superadmin Console")).not.toBeInTheDocument();
  });

  it("is refused for an exporter as well as an importer", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": exporterAdmin });
    renderApp("/admin");
    expect(await screen.findByRole("heading", { name: "Portfolio overview" })).toBeInTheDocument();
    expect(screen.queryByText("Superadmin Console")).not.toBeInTheDocument();
  });

  it("is available to a superadmin, with the top-bar layout and no sidebar", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": superadmin });
    renderApp("/admin");

    expect(await screen.findByRole("heading", { name: "Pending organization applications" })).toBeInTheDocument();
    expect(screen.getByText("Superadmin Console")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Main" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle dark mode/i })).toBeInTheDocument();
  });

  it("sends a superadmin who lands on the dashboard to the console instead", async () => {
    localStorage.setItem("vp-dev-user", "x");
    mockApi({ "GET /me": superadmin });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Pending organization applications" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Portfolio overview" })).not.toBeInTheDocument();
  });
});

describe("not signed in", () => {
  it("in development offers the sample users, and choosing one signs in as them", async () => {
    mockApi({
      "GET /me": meFor(exporterAdmin),
      "GET /dev/users": { users: devUsers },
    });
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Choose a sample user" })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: /Alma Alpha, Sample Exporter Alpha/ }));

    expect(localStorage.getItem("vp-dev-user")).toBe(exporterAdmin.userId);
    const sidebar = await screen.findByRole("navigation", { name: "Main" });
    expect(within(sidebar).getByText("Sample Exporter Alpha")).toBeInTheDocument();
  });

  it("describes each sample user with organization and roles", async () => {
    mockApi({ "GET /me": respond(401, {}), "GET /dev/users": { users: devUsers } });
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Ivy Importer, Sample Importer Ltd (Organization Admin)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Victor Viewer, Sample Importer Ltd (Viewer)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sample Superadmin, VeriPura superadmin" })).toBeInTheDocument();
  });

  it("a stored user that no longer exists is offered the picker again", async () => {
    localStorage.setItem("vp-dev-user", "deleted-user");
    mockApi({ "GET /me": respond(401, {}), "GET /dev/users": { users: devUsers } });
    renderApp("/");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Choose a sample user" })).toBeInTheDocument());
  });
});
