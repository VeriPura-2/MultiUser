import { and, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { signBody } from "../src/core/signature.js";
import type { CoreConsignmentPayload, CoreSubmitResult, VeriPuraCoreClient } from "../src/core/types.js";
import { getDb } from "../src/db/client.js";
import {
  consignments,
  document_checklist_items,
  document_permission_rules,
  document_types,
  org_roles,
  user_role_assignments,
  users,
  type Consignment,
  type DocumentChecklistItem,
  type DocumentType,
  type Organization,
  type OrgRole,
  type OrgType,
  type User,
  type ViewLevel,
} from "../src/db/schema.js";
import type { StandardRoleName } from "../src/roles.js";
import { submitPurchaseOrder } from "../src/services/consignments.js";
import { approveOrganization, proposeOrganization } from "../src/services/organizations.js";

let counter = 0;
const unique = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;

export async function createSuperadmin(): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ organization_id: null, email: `super-${unique()}@veripura.test`, status: "active" })
    .returning();
  return user!;
}

export interface TestOrg {
  org: Organization;
  /** The requester, activated by approval and holding Organization Admin. */
  admin: User;
  roles: Record<StandardRoleName, OrgRole>;
}

/** Proposes and approves an organization through the real lifecycle functions. */
export async function createActiveOrg(orgType: OrgType, name = `Org ${unique()}`): Promise<TestOrg> {
  const superadmin = await createSuperadmin();
  const { organization } = await proposeOrganization(name, orgType, `admin-${unique()}@example.test`);
  const org = await approveOrganization(organization.id, superadmin);
  const rows = await getDb().select().from(org_roles).where(eq(org_roles.organization_id, org.id));
  const roles = Object.fromEntries(rows.map((r) => [r.name, r])) as Record<StandardRoleName, OrgRole>;
  const [admin] = await getDb()
    .select()
    .from(users)
    .where(and(eq(users.organization_id, org.id)));
  return { org, admin: admin!, roles };
}

/** Inserts an active user with the given roles directly, without going through inviteUser. */
export async function createUserWithRoles(t: TestOrg, roleNames: StandardRoleName[]): Promise<User> {
  const [user] = await getDb()
    .insert(users)
    .values({ organization_id: t.org.id, email: `user-${unique()}@example.test`, status: "active" })
    .returning();
  if (roleNames.length > 0) {
    await getDb()
      .insert(user_role_assignments)
      .values(roleNames.map((n) => ({ user_id: user!.id, org_role_id: t.roles[n].id })));
  }
  return user!;
}

export async function createDocumentType(name = `Doc ${unique()}`): Promise<DocumentType> {
  const [dt] = await getDb().insert(document_types).values({ name, category: "Test" }).returning();
  return dt!;
}

export async function setRule(
  documentType: DocumentType,
  orgType: OrgType,
  roleName: StandardRoleName,
  grant: { view: ViewLevel; edit?: boolean; download?: boolean; approve?: boolean },
): Promise<void> {
  await getDb()
    .insert(document_permission_rules)
    .values({
      document_type_id: documentType.id,
      org_type: orgType,
      org_role_name: roleName,
      view_level: grant.view,
      can_edit: grant.edit ?? false,
      can_download: grant.download ?? false,
      can_approve: grant.approve ?? false,
    });
}

// ---------------------------------------------------------------------------
// Stage 2 helpers
// ---------------------------------------------------------------------------

export const TEST_WEBHOOK_SECRET = "test-webhook-secret";

export interface TradeParties {
  importer: TestOrg;
  exporter: TestOrg;
}

export async function createTradeParties(): Promise<TradeParties> {
  return { importer: await createActiveOrg("importer"), exporter: await createActiveOrg("exporter") };
}

/** A core client that records calls and returns whatever `respond` says (no checklist by default). */
export class RecordingCoreClient implements VeriPuraCoreClient {
  readonly calls: CoreConsignmentPayload[] = [];
  constructor(private readonly respond: (p: CoreConsignmentPayload) => Promise<CoreSubmitResult> | CoreSubmitResult = () => ({})) {}
  async submitConsignment(payload: CoreConsignmentPayload): Promise<CoreSubmitResult> {
    this.calls.push(payload);
    return this.respond(payload);
  }
}

export const PO_DEFAULTS = {
  commodity: "Frozen beef",
  originCountry: "BR",
  destinationCountry: "GB",
  fileName: "po-1001.pdf",
  fileBuffer: Buffer.from("%PDF-1.4 fake purchase order"),
};

/** Submits a PO as the importer's admin through the real flow (stub core unless overridden). */
export async function submitTestPO(parties: TradeParties, overrides: Partial<Parameters<typeof submitPurchaseOrder>[0]> = {}) {
  return submitPurchaseOrder({
    importerOrgId: parties.importer.org.id,
    exporterOrgId: parties.exporter.org.id,
    actingUser: parties.importer.admin,
    ...PO_DEFAULTS,
    ...overrides,
  });
}

export async function checklistItemsOf(consignment: Pick<Consignment, "id">): Promise<DocumentChecklistItem[]> {
  return getDb().select().from(document_checklist_items).where(eq(document_checklist_items.consignment_id, consignment.id));
}

export async function reloadConsignment(id: string): Promise<Consignment> {
  const [row] = await getDb().select().from(consignments).where(eq(consignments.id, id));
  return row!;
}

/** POSTs a JSON body to the checklist webhook, signed with the test secret unless told otherwise. */
export async function postChecklist(
  app: FastifyInstance,
  body: unknown,
  opts: { signature?: string | null; secret?: string } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const signature = opts.signature === undefined ? signBody(raw, opts.secret ?? TEST_WEBHOOK_SECRET) : opts.signature;
  return app.inject({
    method: "POST",
    url: "/webhooks/veripura-core/checklist",
    headers: { "content-type": "application/json", ...(signature ? { "x-veripura-signature": signature } : {}) },
    payload: raw,
  });
}

/**
 * A consignment carrying the stub's four checklist documents, addressable by name, with the
 * parties and their admins. The shared starting point for tests of the read views.
 */
export async function scenario(parties?: TradeParties, overrides: Parameters<typeof submitTestPO>[1] = {}) {
  const p = parties ?? (await createTradeParties());
  const consignment = await submitTestPO(p, overrides);
  const items = await checklistItemsOf(consignment);
  const types = await getDb().select().from(document_types);
  const doc = (name: string) => {
    const type = types.find((t) => t.name === name)!;
    return { type, item: items.find((i) => i.document_type_id === type.id)! };
  };
  return {
    parties: p,
    consignment,
    invoice: doc("Commercial Invoice"),
    packing: doc("Packing List"),
    bol: doc("Bill of Lading"),
    cert: doc("Export Health Certificate"),
    importerAdmin: p.importer.admin,
    exporterAdmin: p.exporter.admin,
  };
}
export type Scenario = Awaited<ReturnType<typeof scenario>>;
