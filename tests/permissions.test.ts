import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { document_permission_rules } from "../src/db/schema.js";
import {
  DEFAULT_PERMISSIONS,
  SUPERADMIN_PERMISSIONS,
  canConfigureVisibilityRules,
  canManageOrgUsers,
  mergePermissionRules,
  resolveDocumentPermissions,
} from "../src/permissions/engine.js";
import type { UserRef } from "../src/types.js";
import { createActiveOrg, createDocumentType, createSuperadmin, createUserWithRoles, setRule } from "./helpers.js";

/** Pulls the Postgres constraint name out of a (possibly Drizzle-wrapped) error. */
async function constraintOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    const e = err as { constraint?: string; cause?: { constraint?: string } };
    return e.cause?.constraint ?? e.constraint;
  }
  return undefined;
}

const NO_GRANTS = { canEdit: false, canDownload: false, canApprove: false };

describe("mergePermissionRules (pure)", () => {
  const rule = (view_level: "full" | "status_only" | "hidden", can_edit = false, can_download = false, can_approve = false) => ({
    view_level,
    can_edit,
    can_download,
    can_approve,
  });

  it("returns the opt-in defaults when there are no rules", () => {
    expect(mergePermissionRules([])).toEqual({ viewLevel: "full", ...NO_GRANTS });
  });

  it("takes the most permissive view level: full > status_only > hidden", () => {
    expect(mergePermissionRules([rule("hidden"), rule("status_only")]).viewLevel).toBe("status_only");
    expect(mergePermissionRules([rule("hidden"), rule("full")]).viewLevel).toBe("full");
    expect(mergePermissionRules([rule("status_only"), rule("full"), rule("hidden")]).viewLevel).toBe("full");
    expect(mergePermissionRules([rule("hidden"), rule("hidden")]).viewLevel).toBe("hidden");
  });

  it("ORs each boolean across full-view rules", () => {
    const merged = mergePermissionRules([rule("full", true, false, false), rule("full", false, true, true)]);
    expect(merged).toEqual({ viewLevel: "full", canEdit: true, canDownload: true, canApprove: true });
  });

  it("does not leak edit/download/approve from rules below full when the merged view is below full", () => {
    // These rows cannot exist in the database (CHECK constraint), so they are hand-built here
    // to prove the merge does not depend on that constraint.
    const merged = mergePermissionRules([rule("hidden", true, true, true), rule("status_only", true, true, true)]);
    expect(merged).toEqual({ viewLevel: "status_only", ...NO_GRANTS });

    const hiddenOnly = mergePermissionRules([rule("hidden", true, true, true)]);
    expect(hiddenOnly).toEqual({ viewLevel: "hidden", ...NO_GRANTS });
  });

  it("does not leak a grant from a below-full rule into a merged result that resolves to full", () => {
    const merged = mergePermissionRules([rule("status_only", true, true, true), rule("full", false, false, false)]);
    expect(merged).toEqual({ viewLevel: "full", ...NO_GRANTS });
  });
});

describe("document_permission_rules constraints", () => {
  it("rejects can_edit on a status_only rule", async () => {
    const t = await createActiveOrg("exporter");
    const dt = await createDocumentType();
    const c = await constraintOf(setRule(dt, t.org.org_type, "Compliance User", { view: "status_only", edit: true }));
    expect(c).toBe("dpr_grants_require_full_view");
  });

  it.each([
    ["can_download", { download: true }],
    ["can_approve", { approve: true }],
  ] as const)("rejects %s on a hidden rule", async (_name, grant) => {
    const t = await createActiveOrg("exporter");
    const dt = await createDocumentType();
    const c = await constraintOf(setRule(dt, t.org.org_type, "Viewer", { view: "hidden", ...grant }));
    expect(c).toBe("dpr_grants_require_full_view");
  });

  it("accepts every grant on a full rule", async () => {
    const t = await createActiveOrg("exporter");
    const dt = await createDocumentType();
    await setRule(dt, t.org.org_type, "Compliance Manager", { view: "full", edit: true, download: true, approve: true });
  });

  it("does not allow a rule to be stored for veripura_superadmin", async () => {
    const dt = await createDocumentType();
    const c = await constraintOf(
      getDb().insert(document_permission_rules).values({
        document_type_id: dt.id,
        org_type: "veripura_superadmin",
        org_role_name: "Anything",
        view_level: "full",
      }),
    );
    expect(c).toBe("dpr_no_superadmin_rows");
  });

  it("allows only one rule per (document type, org type, role name)", async () => {
    const t = await createActiveOrg("importer");
    const dt = await createDocumentType();
    await setRule(dt, "importer", "Viewer", { view: "full" });
    await expect(setRule(dt, "importer", "Viewer", { view: "hidden" })).rejects.toThrow();
  });
});

describe("resolveDocumentPermissions", () => {
  it("a Compliance User with a status_only rule cannot see full document detail", async () => {
    const t = await createActiveOrg("exporter");
    const dt = await createDocumentType("Bill of Lading");
    await setRule(dt, "exporter", "Compliance User", { view: "status_only" });
    const user = await createUserWithRoles(t, ["Compliance User"]);

    expect(await resolveDocumentPermissions(user, dt)).toEqual({ viewLevel: "status_only", ...NO_GRANTS });
  });

  it("a user with a full+can_approve role and a hidden role resolves to full with can_approve true", async () => {
    const t = await createActiveOrg("importer");
    const dt = await createDocumentType();
    await setRule(dt, "importer", "Compliance Manager", { view: "full", approve: true });
    await setRule(dt, "importer", "Viewer", { view: "hidden" });
    const user = await createUserWithRoles(t, ["Compliance Manager", "Viewer"]);

    expect(await resolveDocumentPermissions(user, dt)).toEqual({
      viewLevel: "full",
      canEdit: false,
      canDownload: false,
      canApprove: true,
    });
  });

  it("merged result below full carries no grants (status_only + hidden roles)", async () => {
    const t = await createActiveOrg("importer");
    const dt = await createDocumentType();
    await setRule(dt, "importer", "Reviewer", { view: "status_only" });
    await setRule(dt, "importer", "Viewer", { view: "hidden" });
    const user = await createUserWithRoles(t, ["Reviewer", "Viewer"]);

    expect(await resolveDocumentPermissions(user, dt)).toEqual({ viewLevel: "status_only", ...NO_GRANTS });
  });

  it("a document type with zero configured rules resolves to full view with no edit/download/approve", async () => {
    const t = await createActiveOrg("logistics");
    const dt = await createDocumentType();
    const user = await createUserWithRoles(t, ["Compliance User"]);

    expect(await resolveDocumentPermissions(user, dt)).toEqual({ ...DEFAULT_PERMISSIONS });
    expect(await resolveDocumentPermissions(user, dt)).toEqual({ viewLevel: "full", ...NO_GRANTS });
  });

  it("a rule for a different role, org type, or document type does not apply", async () => {
    const t = await createActiveOrg("exporter");
    const dt = await createDocumentType();
    const other = await createDocumentType();
    await setRule(dt, "exporter", "Viewer", { view: "hidden" }); // other role
    await setRule(dt, "importer", "Compliance User", { view: "hidden" }); // other org type
    await setRule(other, "exporter", "Compliance User", { view: "hidden" }); // other document type
    const user = await createUserWithRoles(t, ["Compliance User"]);

    expect(await resolveDocumentPermissions(user, dt)).toEqual({ ...DEFAULT_PERMISSIONS });
  });

  it("a role only counts for the org type it is configured for", async () => {
    const importerOrg = await createActiveOrg("importer");
    const exporterOrg = await createActiveOrg("exporter");
    const dt = await createDocumentType();
    await setRule(dt, "importer", "Viewer", { view: "hidden" });
    const importerViewer = await createUserWithRoles(importerOrg, ["Viewer"]);
    const exporterViewer = await createUserWithRoles(exporterOrg, ["Viewer"]);

    expect((await resolveDocumentPermissions(importerViewer, dt)).viewLevel).toBe("hidden");
    expect((await resolveDocumentPermissions(exporterViewer, dt)).viewLevel).toBe("full");
  });

  it("a user with no roles gets the opt-in defaults", async () => {
    const t = await createActiveOrg("exporter");
    const dt = await createDocumentType();
    await setRule(dt, "exporter", "Viewer", { view: "hidden" });
    const user = await createUserWithRoles(t, []);

    expect(await resolveDocumentPermissions(user, dt)).toEqual({ ...DEFAULT_PERMISSIONS });
  });

  it("superadmin always resolves to full/all-true regardless of rules", async () => {
    const superadmin = await createSuperadmin();
    const t = await createActiveOrg("importer");
    const dt = await createDocumentType();
    // Hide the document from every role of every org type that exists.
    for (const orgType of ["importer", "exporter", "logistics", "lab_cert", "data_source"] as const) {
      for (const role of ["Organization Admin", "Compliance Manager", "Compliance User", "Reviewer", "Viewer"] as const) {
        await setRule(dt, orgType, role, { view: "hidden" });
      }
    }

    expect(await resolveDocumentPermissions(superadmin, dt)).toEqual({ ...SUPERADMIN_PERMISSIONS });
    expect(await resolveDocumentPermissions(superadmin, dt)).toEqual({
      viewLevel: "full",
      canEdit: true,
      canDownload: true,
      canApprove: true,
    });
    // ...while an ordinary user of that org type is hidden from it.
    const viewer = await createUserWithRoles(t, ["Viewer"]);
    expect((await resolveDocumentPermissions(viewer, dt)).viewLevel).toBe("hidden");
  });

  it("does not treat a missing organization_id (undefined) as superadmin", async () => {
    const dt = await createDocumentType();
    const malformed = { id: "00000000-0000-0000-0000-000000000000" } as unknown as UserRef;

    await expect(resolveDocumentPermissions(malformed, dt)).rejects.toThrow(TypeError);
    expect(await canManageOrgUsers(malformed)).toBe(false);
    expect(canConfigureVisibilityRules(malformed)).toBe(false);
  });
});

describe("canManageOrgUsers and canConfigureVisibilityRules", () => {
  it("canManageOrgUsers: true for superadmin, true for an Organization Admin, false for other roles and roleless users", async () => {
    const superadmin = await createSuperadmin();
    const t = await createActiveOrg("exporter");
    const manager = await createUserWithRoles(t, ["Compliance Manager"]);
    const viewer = await createUserWithRoles(t, ["Viewer"]);
    const roleless = await createUserWithRoles(t, []);
    const multi = await createUserWithRoles(t, ["Viewer", "Organization Admin"]);

    expect(await canManageOrgUsers(superadmin)).toBe(true);
    expect(await canManageOrgUsers(t.admin)).toBe(true);
    expect(await canManageOrgUsers(manager)).toBe(false);
    expect(await canManageOrgUsers(viewer)).toBe(false);
    expect(await canManageOrgUsers(roleless)).toBe(false);
    expect(await canManageOrgUsers(multi)).toBe(true);
  });

  it("canConfigureVisibilityRules: true only for superadmin, even for an Organization Admin", async () => {
    const superadmin = await createSuperadmin();
    const t = await createActiveOrg("importer");

    expect(canConfigureVisibilityRules(superadmin)).toBe(true);
    expect(canConfigureVisibilityRules(t.admin)).toBe(false);
  });
});
