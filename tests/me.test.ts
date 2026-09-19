import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { user_role_assignments, users } from "../src/db/schema.js";
import { buildApp } from "../src/http/app.js";
import { createActiveOrg, createSuperadmin, createUserWithRoles } from "./helpers.js";

const db = () => getDb();
const devApp = () => buildApp({ actor: { allowDevActorHeader: true } });

const me = (app: ReturnType<typeof buildApp>, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url: "/me", headers });

/** Sets environment variables for one test body and restores them afterward. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

afterEach(() => {
  // withEnv restores on its own; this is a guard against a leaked production flag.
  expect(process.env.NODE_ENV).not.toBe("production");
});

describe("GET /me", () => {
  it("describes a superadmin: no organization, no roles, isSuperadmin true", async () => {
    const superadmin = await createSuperadmin();
    await db().update(users).set({ name: "Vera Puri" }).where(eq(users.id, superadmin.id));

    const res = await me(devApp(), { "x-dev-user": superadmin.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: superadmin.id,
      name: "Vera Puri",
      email: superadmin.email,
      organization: null,
      roleNames: [],
      isSuperadmin: true,
    });
  });

  it("describes a normal user with their organization and roles, sorted", async () => {
    const t = await createActiveOrg("exporter", "Alpha Exports");
    const user = await createUserWithRoles(t, ["Viewer", "Compliance User"]);

    const res = await me(devApp(), { "x-dev-user": user.id });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: user.id,
      name: null, // invited users have no name until they set one
      email: user.email,
      organization: { id: t.org.id, name: "Alpha Exports", orgType: "exporter" },
      roleNames: ["Compliance User", "Viewer"],
      isSuperadmin: false,
    });
  });

  it("shows Organization Admin for the first user of an approved org", async () => {
    const t = await createActiveOrg("importer");
    const res = await me(devApp(), { "x-dev-user": t.admin.id });
    expect(res.json().roleNames).toEqual(["Organization Admin"]);
  });

  it("never lists a role from another organization, even if a stray assignment points at one", async () => {
    const mine = await createActiveOrg("importer");
    const theirs = await createActiveOrg("exporter");
    const user = await createUserWithRoles(mine, ["Viewer"]);
    await db().insert(user_role_assignments).values({ user_id: user.id, org_role_id: theirs.roles["Organization Admin"].id });

    const res = await me(devApp(), { "x-dev-user": user.id });
    expect(res.json().roleNames).toEqual(["Viewer"]);
  });

  it("is 401 without an acting user, for an unknown or malformed id, and when the dev mechanism is off", async () => {
    const superadmin = await createSuperadmin();
    const app = devApp();
    expect((await me(app)).statusCode).toBe(401);
    expect((await me(app, { "x-dev-user": "00000000-0000-4000-8000-000000000000" })).statusCode).toBe(401);
    expect((await me(app, { "x-dev-user": "not-a-uuid" })).statusCode).toBe(401);

    const locked = buildApp(); // AUTH_MODE is empty in the test environment
    expect((await me(locked, { "x-dev-user": superadmin.id })).statusCode).toBe(401);
  });

  it("is 403 for a user who is not active", async () => {
    const t = await createActiveOrg("importer");
    const user = await createUserWithRoles(t, ["Viewer"]);
    for (const status of ["invited", "deactivated"] as const) {
      await db().update(users).set({ status }).where(eq(users.id, user.id));
      expect((await me(devApp(), { "x-dev-user": user.id })).statusCode, status).toBe(403);
    }
  });

  it("accepts the legacy X-Acting-User-Id header, and prefers X-Dev-User when both are sent", async () => {
    const a = await createActiveOrg("importer");
    const b = await createActiveOrg("exporter");
    const app = devApp();
    expect((await me(app, { "x-acting-user-id": a.admin.id })).json().userId).toBe(a.admin.id);
    const both = await me(app, { "x-dev-user": b.admin.id, "x-acting-user-id": a.admin.id });
    expect(both.json().userId).toBe(b.admin.id);
  });
});

describe("AUTH_MODE and the production guard", () => {
  it("AUTH_MODE=dev switches the dev acting user on; any other value leaves it off", async () => {
    const superadmin = await createSuperadmin();
    await withEnv({ AUTH_MODE: "dev" }, async () => {
      expect((await me(buildApp(), { "x-dev-user": superadmin.id })).statusCode).toBe(200);
    });
    await withEnv({ AUTH_MODE: "google" }, async () => {
      expect((await me(buildApp(), { "x-dev-user": superadmin.id })).statusCode).toBe(401);
    });
  });

  it("the deprecated ALLOW_DEV_ACTOR_HEADER=true still switches it on", async () => {
    const superadmin = await createSuperadmin();
    await withEnv({ ALLOW_DEV_ACTOR_HEADER: "true" }, async () => {
      expect((await me(buildApp(), { "x-dev-user": superadmin.id })).statusCode).toBe(200);
    });
  });

  it("refuses to start with AUTH_MODE=dev and NODE_ENV=production", async () => {
    await withEnv({ AUTH_MODE: "dev", NODE_ENV: "production" }, () => {
      expect(() => buildApp()).toThrow(/Refusing to start/);
    });
  });

  it("refuses to start under production for the deprecated switch and for an explicit option too", async () => {
    await withEnv({ ALLOW_DEV_ACTOR_HEADER: "true", NODE_ENV: "production" }, () => {
      expect(() => buildApp()).toThrow(/Refusing to start/);
    });
    await withEnv({ NODE_ENV: "production" }, () => {
      expect(() => buildApp({ actor: { allowDevActorHeader: true } })).toThrow(/Refusing to start/);
      expect(() => buildApp({ purchaseOrders: { allowDevActorHeader: true } })).toThrow(/Refusing to start/);
    });
  });

  it("starts normally in production when the dev mechanism is off, and then every acting-user route is 401", async () => {
    const superadmin = await createSuperadmin();
    await withEnv({ NODE_ENV: "production", AUTH_MODE: "" }, async () => {
      const app = buildApp();
      expect((await me(app, { "x-dev-user": superadmin.id })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url: "/dev/users" })).statusCode).toBe(404);
    });
  });
});

describe("GET /dev/users", () => {
  it("is a 404 unless the dev mechanism is on", async () => {
    await createSuperadmin();
    expect((await buildApp().inject({ method: "GET", url: "/dev/users" })).statusCode).toBe(404);
  });

  it("lists every user with organization, roles, and status, and needs no acting user", async () => {
    const superadmin = await createSuperadmin();
    const t = await createActiveOrg("exporter", "Alpha Exports");
    const viewer = await createUserWithRoles(t, ["Viewer"]);

    const res = await devApp().inject({ method: "GET", url: "/dev/users" });
    expect(res.statusCode).toBe(200);
    const list = res.json().users as Array<Record<string, any>>;
    // Four users: the helper that approves the org creates a superadmin of its own.
    expect(list).toHaveLength(4);
    expect(list.map((u) => u.userId)).toEqual(expect.arrayContaining([superadmin.id, t.admin.id, viewer.id]));
    const v = list.find((u) => u.userId === viewer.id)!;
    expect(v).toMatchObject({
      status: "active",
      isSuperadmin: false,
      roleNames: ["Viewer"],
      organization: { id: t.org.id, name: "Alpha Exports", orgType: "exporter" },
    });
    expect(list.find((u) => u.userId === superadmin.id)).toMatchObject({ isSuperadmin: true, organization: null, roleNames: [] });
  });
});
