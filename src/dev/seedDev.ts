import { and, eq, inArray } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { setCoreClient, STUB_CHECKLIST_DOCUMENTS } from "../core/client.js";
import type { VeriPuraCoreClient } from "../core/types.js";
import { getDb } from "../db/client.js";
import {
  ORG_TYPES,
  consignments,
  document_checklist_items,
  document_permission_rules,
  document_types,
  org_roles,
  user_role_assignments,
  users,
  type Consignment,
  type OrgType,
  type User,
  type ViewLevel,
} from "../db/schema.js";
import { STANDARD_ROLES, type StandardRoleName } from "../roles.js";
import { submitPurchaseOrder } from "../services/consignments.js";
import { raiseIssue, requestCorrection, resolveIssue } from "../services/issues.js";
import { approveOrganization, proposeOrganization } from "../services/organizations.js";
import { inviteUser } from "../services/users.js";

/**
 * LOCAL SANDBOX SAMPLE DATA, for developing the UI. Nothing here is real.
 *
 * - Document types are ONLY the four the stub VeriPuraCoreClient already returns. The
 *   authoritative document list has not been confirmed, so no names are added and no categories
 *   are invented (category stays null). The UI must render whatever document_types holds.
 * - The visibility matrix below is illustrative, chosen so the UI meets full, status_only, and
 *   hidden cases. The real matrix comes from the pilot Scope of Work, Section 7.
 * - Every grant (edit, download, approve) is false, as the backend prompts direct.
 */

export const SAMPLE_EMAIL_DOMAIN = "sample.veripura.test";
export const SAMPLE_SUPERADMIN_EMAIL = `superadmin@${SAMPLE_EMAIL_DOMAIN}`;

/** Refuses to run against anything but a database on this machine. */
export function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.");
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`seed:dev only runs against a local sandbox database, but DATABASE_URL points at "${host}".`);
  }
}

interface SampleOrg {
  name: string;
  orgType: OrgType;
  slug: string;
  adminName: string;
}

const SAMPLE_ORGS: SampleOrg[] = [
  { name: "Sample Importer Ltd", orgType: "importer", slug: "importer", adminName: "Ivy Importer" },
  { name: "Sample Exporter Alpha", orgType: "exporter", slug: "alpha", adminName: "Alma Alpha" },
  { name: "Sample Exporter Bravo", orgType: "exporter", slug: "bravo", adminName: "Bruno Bravo" },
  { name: "Sample Exporter Charlie", orgType: "exporter", slug: "charlie", adminName: "Carla Charlie" },
  { name: "Sample Logistics Co", orgType: "logistics", slug: "logistics", adminName: "Lena Logistics" },
  { name: "Sample Laboratory", orgType: "lab_cert", slug: "lab", adminName: "Lucas Lab" },
];

const ADMIN_LIKE: StandardRoleName[] = ["Organization Admin", "Compliance Manager", "Compliance User"];

/** Illustrative view level for one org type, role, and document. See the note at the top. */
export function sampleViewLevel(orgType: OrgType, role: StandardRoleName, documentName: string): ViewLevel {
  const adminLike = ADMIN_LIKE.includes(role);
  switch (orgType) {
    case "importer":
      return role === "Viewer" ? "status_only" : "full";
    case "exporter":
      if (role === "Viewer") return "status_only";
      if (role === "Reviewer" && documentName === "Bill of Lading") return "status_only";
      return "full";
    case "logistics":
      if (documentName === "Export Health Certificate") return "hidden";
      if (documentName === "Bill of Lading") return adminLike ? "full" : "status_only";
      return adminLike ? "status_only" : "hidden";
    case "lab_cert":
      if (documentName === "Export Health Certificate") return adminLike ? "full" : "status_only";
      if (documentName === "Bill of Lading") return "status_only";
      return "hidden";
    case "data_source":
      return "status_only";
  }
}

export interface SeedSummary {
  skipped: boolean;
  users: Array<{ email: string; name: string | null; organization: string | null; roles: string[] }>;
  consignments: Array<{ id: string; label: string; status: string }>;
}

/** A core client that accepts a consignment and sends no checklist yet, like real core would. */
const acceptsWithoutChecklist: VeriPuraCoreClient = { submitConsignment: async () => ({}) };

export async function seedDev(log: (line: string) => void = () => {}): Promise<SeedSummary> {
  assertLocalDatabase(process.env.DATABASE_URL);
  const db = getDb();

  const existing = await db.select().from(users).where(eq(users.email, SAMPLE_SUPERADMIN_EMAIL));
  if (existing.length > 0) {
    log("Sample data is already present. Nothing changed. To start over, reset the sandbox database.");
    return { skipped: true, users: [], consignments: [] };
  }

  // Superadmin, and the audit row that says how it came to exist.
  const [superadmin] = await db
    .insert(users)
    .values({ organization_id: null, email: SAMPLE_SUPERADMIN_EMAIL, name: "Sample Superadmin", status: "active" })
    .returning();
  await recordAudit({
    actorUser: null,
    action: "user.superadmin_seeded",
    targetType: "user",
    targetId: superadmin!.id,
    metadata: { email: SAMPLE_SUPERADMIN_EMAIL, source: "seed:dev" },
  });
  log(`Superadmin: ${SAMPLE_SUPERADMIN_EMAIL}`);

  // Document types: exactly the stub's, with no category.
  await db
    .insert(document_types)
    .values(STUB_CHECKLIST_DOCUMENTS.map((d) => ({ name: d.documentTypeName })))
    .onConflictDoNothing();
  const docTypes = await db
    .select()
    .from(document_types)
    .where(inArray(document_types.name, STUB_CHECKLIST_DOCUMENTS.map((d) => d.documentTypeName)));

  // Organizations, through the real lifecycle so roles, admins, and audit rows are genuine.
  const orgIds = new Map<string, string>();
  const admins = new Map<string, User>();
  for (const sample of SAMPLE_ORGS) {
    const { organization, user } = await proposeOrganization(sample.name, sample.orgType, `admin@${sample.slug}.${SAMPLE_EMAIL_DOMAIN}`);
    await approveOrganization(organization.id, superadmin!);
    const [named] = await db.update(users).set({ name: sample.adminName }).where(eq(users.id, user.id)).returning();
    orgIds.set(sample.slug, organization.id);
    admins.set(sample.slug, named!);
  }

  // A second importer user who holds only the Viewer role, so the UI can show a restricted user.
  const importerId = orgIds.get("importer")!;
  const importerAdmin = admins.get("importer")!;
  const [viewerRole] = await db
    .select()
    .from(org_roles)
    .where(and(eq(org_roles.organization_id, importerId), eq(org_roles.name, "Viewer")));
  const invited = await inviteUser(importerId, `viewer@importer.${SAMPLE_EMAIL_DOMAIN}`, [viewerRole!.id], importerAdmin);
  await db.update(users).set({ name: "Victor Viewer", status: "active" }).where(eq(users.id, invited.id));

  // Default permission matrix: every org type, every standard role, every document type.
  const rules = [];
  for (const orgType of ORG_TYPES) {
    for (const role of STANDARD_ROLES) {
      for (const doc of docTypes) {
        rules.push({
          document_type_id: doc.id,
          org_type: orgType,
          org_role_name: role.name,
          view_level: sampleViewLevel(orgType, role.name, doc.name),
          can_edit: false,
          can_download: false,
          can_approve: false,
        });
      }
    }
  }
  await db.insert(document_permission_rules).values(rules);

  // Consignments in different states, made through the real submit flow.
  const sample = { originCountry: "BR", destinationCountry: "GB", fileName: "sample-po.pdf", fileBuffer: Buffer.from("SAMPLE PURCHASE ORDER (local sandbox data)") };
  const submit = (exporter: string, commodity: string, hsCode: string) =>
    submitPurchaseOrder({ importerOrgId: importerId, exporterOrgId: orgIds.get(exporter)!, commodity, hsCode, actingUser: importerAdmin, ...sample });

  const itemOf = async (consignment: Consignment, documentName: string) => {
    const [doc] = docTypes.filter((d) => d.name === documentName);
    const [item] = await db
      .select()
      .from(document_checklist_items)
      .where(and(eq(document_checklist_items.consignment_id, consignment.id), eq(document_checklist_items.document_type_id, doc!.id)));
    return item!;
  };
  const setItem = async (consignment: Consignment, documentName: string, status: "awaiting_upload" | "pending" | "verified") => {
    const item = await itemOf(consignment, documentName);
    await db.update(document_checklist_items).set({ status }).where(eq(document_checklist_items.id, item.id));
  };
  const setStatus = (c: Consignment, status: Consignment["status"]) => db.update(consignments).set({ status }).where(eq(consignments.id, c.id));

  // 1. Waiting on core: accepted, no checklist yet (checklist_pending).
  setCoreClient(acceptsWithoutChecklist);
  const waiting = await submit("bravo", "Frozen poultry", "0207.14");
  setCoreClient(undefined);

  // 2. Checklist received, with an open issue and a correction request.
  const received = await submit("alpha", "Chilled beef", "0201.30");
  const cert = await itemOf(received, "Export Health Certificate");
  const invoice = await itemOf(received, "Commercial Invoice");
  const packing = await itemOf(received, "Packing List");
  await raiseIssue({
    documentChecklistItemId: cert.id,
    problem: "Exporter name does not match the exporter declared on the commercial invoice",
    expectedValue: "Sample Exporter Alpha GmbH",
    foundValue: "Sample Exporter Alpha S.A.",
    sourceChecklistItemId: invoice.id,
    responsibleOrgType: "exporter",
    actingUser: importerAdmin,
  });
  const quantity = await raiseIssue({
    documentChecklistItemId: packing.id,
    problem: "Carton count differs from the commercial invoice",
    expectedValue: "480",
    foundValue: "460",
    sourceChecklistItemId: invoice.id,
    responsibleOrgType: "exporter",
    actingUser: importerAdmin,
  });
  await requestCorrection({ issueId: quantity.id, message: "Please confirm the carton count and reissue the packing list.", actingUser: importerAdmin });

  // 3. Active, mostly verified, one resolved issue in its history.
  const active = await submit("alpha", "Frozen beef", "0202.30");
  await setItem(active, "Commercial Invoice", "verified");
  await setItem(active, "Packing List", "verified");
  await setItem(active, "Bill of Lading", "pending");
  const settled = await raiseIssue({
    documentChecklistItemId: (await itemOf(active, "Packing List")).id,
    problem: "Net weight was missing",
    responsibleOrgType: "exporter",
    actingUser: importerAdmin,
  });
  await resolveIssue({ issueId: settled.id, actingUser: importerAdmin });
  await setItem(active, "Packing List", "verified"); // re-verified after the fix
  await setStatus(active, "active");

  // 4. Completed, everything verified.
  const completed = await submit("charlie", "Frozen pork", "0203.29");
  for (const d of STUB_CHECKLIST_DOCUMENTS) await setItem(completed, d.documentTypeName, "verified");
  await setStatus(completed, "completed");

  // 5. Cancelled.
  const cancelled = await submit("charlie", "Frozen lamb", "0204.10");
  await setStatus(cancelled, "cancelled");

  const all = [waiting, received, active, completed, cancelled];
  const finalConsignments = await db.select().from(consignments).where(inArray(consignments.id, all.map((c) => c.id)));

  // A readable summary of who can be chosen in the dev user switcher.
  const summaryUsers = await db.select().from(users).where(eq(users.status, "active"));
  const orgById = new Map<string, string>();
  for (const s of SAMPLE_ORGS) orgById.set(orgIds.get(s.slug)!, s.name);
  const roleRows = await db
    .select({ userId: user_role_assignments.user_id, name: org_roles.name })
    .from(user_role_assignments)
    .innerJoin(org_roles, eq(org_roles.id, user_role_assignments.org_role_id));
  const rolesByUser = new Map<string, string[]>();
  for (const r of roleRows) rolesByUser.set(r.userId, [...(rolesByUser.get(r.userId) ?? []), r.name]);

  return {
    skipped: false,
    users: summaryUsers.map((u) => ({
      email: u.email,
      name: u.name,
      organization: u.organization_id ? (orgById.get(u.organization_id) ?? null) : null,
      roles: rolesByUser.get(u.id) ?? [],
    })),
    consignments: finalConsignments.map((c) => ({ id: c.id, label: `${c.commodity}, ${c.origin_country} to ${c.destination_country}`, status: c.status })),
  };
}
