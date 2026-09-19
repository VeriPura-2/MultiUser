import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { devUsers, exporterAdmin, importerAdmin } from "./fixtures";
import { mockApi, respond } from "./mockApi";
import { renderApp } from "./renderApp";

const byId = Object.fromEntries(devUsers.map((u) => [u.userId, u]));
const meByHeader = (request: { headers: Headers }) => byId[request.headers.get("X-Dev-User") ?? ""] ?? respond(401, {});

describe("dev user switcher (development)", () => {
  it("is shown in the corner, listing the sample users with their organization and roles", async () => {
    localStorage.setItem("vp-dev-user", importerAdmin.userId);
    mockApi({ "GET /me": meByHeader, "GET /dev/users": { users: devUsers } });
    renderApp("/");

    const switcher = await screen.findByTestId("dev-user-switcher");
    const select = within(switcher).getByRole("combobox", { name: "Acting as" });
    expect(await within(switcher).findByRole("option", { name: "Alma Alpha, Sample Exporter Alpha (Organization Admin)" })).toBeInTheDocument();
    // The stored choice is selected once its option exists.
    expect(select).toHaveValue(importerAdmin.userId);
    expect(within(switcher).getByRole("option", { name: "Sample Superadmin, VeriPura superadmin" })).toBeInTheDocument();
  });

  it("switching user drops the cache, starts over as the new user, and lands on the dashboard", async () => {
    localStorage.setItem("vp-dev-user", importerAdmin.userId);
    const api = mockApi({ "GET /me": meByHeader, "GET /dev/users": { users: devUsers } });
    renderApp("/nowhere");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeInTheDocument();

    const select = await screen.findByRole("combobox", { name: "Acting as" });
    await screen.findByRole("option", { name: /Alma Alpha/ });
    await userEvent.selectOptions(select, exporterAdmin.userId);

    expect(localStorage.getItem("vp-dev-user")).toBe(exporterAdmin.userId);
    const sidebar = await screen.findByRole("navigation", { name: "Main" });
    expect(within(sidebar).getByText("Sample Exporter Alpha")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Portfolio overview" })).toBeInTheDocument();
    // /me was asked again, as the new user.
    const asked = api.callsTo("GET /me").map((c) => c.headers.get("X-Dev-User"));
    expect(asked).toContain(importerAdmin.userId);
    expect(asked.at(-1)).toBe(exporterAdmin.userId);
  });

  it("sends X-Dev-User with every request once a user is chosen", async () => {
    localStorage.setItem("vp-dev-user", importerAdmin.userId);
    const api = mockApi({ "GET /me": meByHeader });
    renderApp("/");
    await screen.findByRole("heading", { name: "Portfolio overview" });
    expect(api.callsTo("GET /me")[0]!.headers.get("X-Dev-User")).toBe(importerAdmin.userId);
  });

  it("shows the switcher on the unauthenticated screen too, so you can always pick a user", async () => {
    mockApi({ "GET /me": respond(401, {}), "GET /dev/users": { users: devUsers } });
    renderApp("/");
    expect(await screen.findByRole("heading", { name: "Choose a sample user" })).toBeInTheDocument();
    expect(screen.getByTestId("dev-user-switcher")).toBeInTheDocument();
  });
});

describe("dev user switcher (production)", () => {
  it("is absent when the app is not running in development", async () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem("vp-dev-user", importerAdmin.userId);
    mockApi({ "GET /me": importerAdmin });
    renderApp("/");

    await screen.findByRole("heading", { name: "Portfolio overview" });
    expect(screen.queryByTestId("dev-user-switcher")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Acting as" })).not.toBeInTheDocument();
  });

  it("does not send X-Dev-User, and does not even read the stored choice", async () => {
    vi.stubEnv("DEV", false);
    localStorage.setItem("vp-dev-user", importerAdmin.userId);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const api = mockApi({ "GET /me": importerAdmin });
    renderApp("/");

    await screen.findByRole("heading", { name: "Portfolio overview" });
    for (const call of api.calls) expect(call.headers.has("X-Dev-User")).toBe(false);
    expect(getItem).not.toHaveBeenCalledWith("vp-dev-user");
  });

  it("does not offer sample users when not signed in: it says sign-in is not available yet", async () => {
    vi.stubEnv("DEV", false);
    const api = mockApi({ "GET /me": respond(401, {}), "GET /dev/users": { users: devUsers } });
    renderApp("/");

    expect(await screen.findByRole("heading", { name: "Sign-in is not available yet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choose a sample user" })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("dev-user-switcher")).not.toBeInTheDocument());
    expect(api.callsTo("GET /dev/users")).toHaveLength(0);
  });
});
