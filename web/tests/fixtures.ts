import type { DevUser, Me } from "../src/api/types";
import { respond } from "./mockApi";

/**
 * Sample users for tests. These are test data, kept outside web/src, so document names and
 * categories used elsewhere in tests never appear in the app itself.
 */

export const importerAdmin: Me = {
  userId: "user-importer-admin",
  name: "Ivy Importer",
  email: "admin@importer.example.test",
  organization: { id: "org-importer", name: "Sample Importer Ltd", orgType: "importer" },
  roleNames: ["Organization Admin"],
  isSuperadmin: false,
};

export const importerViewer: Me = {
  userId: "user-importer-viewer",
  name: "Victor Viewer",
  email: "viewer@importer.example.test",
  organization: { id: "org-importer", name: "Sample Importer Ltd", orgType: "importer" },
  roleNames: ["Viewer"],
  isSuperadmin: false,
};

export const exporterAdmin: Me = {
  userId: "user-exporter-admin",
  name: "Alma Alpha",
  email: "admin@alpha.example.test",
  organization: { id: "org-alpha", name: "Sample Exporter Alpha", orgType: "exporter" },
  roleNames: ["Organization Admin"],
  isSuperadmin: false,
};

export const superadmin: Me = {
  userId: "user-superadmin",
  name: "Sample Superadmin",
  email: "superadmin@example.test",
  organization: null,
  roleNames: [],
  isSuperadmin: true,
};

export const devUsers: DevUser[] = [importerAdmin, importerViewer, exporterAdmin, superadmin].map((u) => ({ ...u, status: "active" }));

/** A /me handler that answers as `user` only when that user's id is sent, and 401 otherwise. */
export function meFor(user: Me) {
  return (request: { headers: Headers }) =>
    request.headers.get("X-Dev-User") === user.userId ? user : respond(401, { error: "unauthenticated" });
}
