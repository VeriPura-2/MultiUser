import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "../src/db/client.js";
import { audit_log, document_checklist_items, document_types, issues, users } from "../src/db/schema.js";
import { NotFoundError, PermissionDeniedError, ValidationError } from "../src/errors.js";
import { raiseIssue, requestCorrection, resolveIssue } from "../src/services/issues.js";
import {
  checklistItemsOf,
  createActiveOrg,
  createSuperadmin,
  createTradeParties,
  createUserWithRoles,
  submitTestPO,
} from "./helpers.js";

const db = () => getDb();

/** A consignment with the stub's four checklist items, addressable by document type name. */
async function setup() {
  const parties = await createTradeParties();
  const consignment = await submitTestPO(parties);
  const items = await checklistItemsOf(consignment);
  const types = await db().select().from(document_types);
  const item = (name: string) => items.find((i) => types.find((t) => t.id === i.document_type_id)!.name === name)!;
  return {
    parties,
    consignment,
    coo: item("Export Health Certificate"), // stands in for the document with the discrepancy
    invoice: item("Commercial Invoice"), // the source document
    bol: item("Bill of Lading"),
  };
}

const itemStatus = async (id: string) =>
  (await db().select().from(document_checklist_items).where(eq(document_checklist_items.id, id)))[0]!.status;

async function auditFor(targetId: string) {
  return db().select().from(audit_log).where(eq(audit_log.target_id, targetId));
}

describe("raiseIssue", () => {
  it("creates an open issue and flags the parent checklist item", async () => {
    const s = await setup();
    expect(await itemStatus(s.coo.id)).toBe("awaiting_upload");

    const issue = await raiseIssue({
      documentChecklistItemId: s.coo.id,
      problem: "Exporter name does not match the exporter declared on the commercial invoice",
      expectedValue: "Acme Trading GmbH",
      foundValue: "Acme Trading S.A.",
      sourceChecklistItemId: s.invoice.id,
      responsibleOrgType: "exporter",
      actingUser: s.parties.importer.admin,
    });

    expect(issue).toMatchObject({
      document_checklist_item_id: s.coo.id,
      consignment_id: s.consignment.id,
      expected_value: "Acme Trading GmbH",
      found_value: "Acme Trading S.A.",
      source_document_checklist_item_id: s.invoice.id,
      responsible_org_type: "exporter",
      status: "open",
      created_by_user_id: s.parties.importer.admin.id,
      resolved_at: null,
    });
    expect(await itemStatus(s.coo.id)).toBe("flagged");
    expect(await itemStatus(s.invoice.id)).toBe("awaiting_upload"); // the source item is not flagged
  });

  it("accepts an issue with no expected/found values and no source document", async () => {
    const s = await setup();
    const issue = await raiseIssue({
      documentChecklistItemId: s.bol.id,
      problem: "Illegible scan",
      responsibleOrgType: "logistics",
      actingUser: s.parties.exporter.admin,
    });
    expect(issue).toMatchObject({ expected_value: null, found_value: null, source_document_checklist_item_id: null });
  });

  it("can be raised by importer-org users, exporter-org users, and superadmin", async () => {
    const s = await setup();
    const importerUser = await createUserWithRoles(s.parties.importer, ["Viewer"]);
    const exporterUser = await createUserWithRoles(s.parties.exporter, ["Reviewer"]);
    const superadmin = await createSuperadmin();
    for (const actingUser of [importerUser, exporterUser, superadmin]) {
      const issue = await raiseIssue({
        documentChecklistItemId: s.coo.id,
        problem: `raised by ${actingUser.id}`,
        responsibleOrgType: "exporter",
        actingUser,
      });
      expect(issue.created_by_user_id).toBe(actingUser.id);
    }
  });

  it("refuses an org that is not a party to the consignment, and changes nothing", async () => {
    const s = await setup();
    const stranger = await createActiveOrg("importer");
    const auditBefore = (await db().select().from(audit_log)).length;

    await expect(
      raiseIssue({ documentChecklistItemId: s.coo.id, problem: "x", responsibleOrgType: "exporter", actingUser: stranger.admin }),
    ).rejects.toThrow(PermissionDeniedError);

    expect(await db().select().from(issues)).toHaveLength(0);
    expect(await itemStatus(s.coo.id)).toBe("awaiting_upload");
    expect(await db().select().from(audit_log)).toHaveLength(auditBefore);
  });

  it("refuses a party-org user who is not active", async () => {
    const s = await setup();
    const invited = await createUserWithRoles(s.parties.importer, ["Viewer"]);
    await db().update(users).set({ status: "invited" }).where(eq(users.id, invited.id));
    const deactivated = await createUserWithRoles(s.parties.exporter, ["Viewer"]);
    await db().update(users).set({ status: "deactivated" }).where(eq(users.id, deactivated.id));

    for (const actingUser of [invited, deactivated]) {
      await expect(
        raiseIssue({ documentChecklistItemId: s.coo.id, problem: "x", responsibleOrgType: "exporter", actingUser }),
      ).rejects.toThrow(PermissionDeniedError);
    }
    expect(await db().select().from(issues)).toHaveLength(0);
  });

  it("does not trust a forged organization_id on the acting user reference", async () => {
    const s = await setup();
    const stranger = await createActiveOrg("importer");
    const forged = { id: stranger.admin.id, organization_id: s.parties.importer.org.id };
    await expect(
      raiseIssue({ documentChecklistItemId: s.coo.id, problem: "x", responsibleOrgType: "exporter", actingUser: forged }),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("validates input: unknown item, blank problem, bad source item", async () => {
    const s = await setup();
    const other = await setup(); // a different consignment
    const base = { responsibleOrgType: "exporter" as const, actingUser: s.parties.importer.admin };

    await expect(
      raiseIssue({ ...base, documentChecklistItemId: "00000000-0000-4000-8000-000000000000", problem: "x" }),
    ).rejects.toThrow(NotFoundError);
    await expect(raiseIssue({ ...base, documentChecklistItemId: s.coo.id, problem: "   " })).rejects.toThrow(ValidationError);
    await expect(
      raiseIssue({ ...base, documentChecklistItemId: s.coo.id, problem: "x", sourceChecklistItemId: s.coo.id }),
    ).rejects.toThrow(ValidationError);
    await expect(
      raiseIssue({ ...base, documentChecklistItemId: s.coo.id, problem: "x", sourceChecklistItemId: other.invoice.id }),
    ).rejects.toThrow(ValidationError);
    expect(await db().select().from(issues)).toHaveLength(0);
    expect(await itemStatus(s.coo.id)).toBe("awaiting_upload");
  });
});

describe("requestCorrection", () => {
  it("moves the issue to correction_requested, keeps the item flagged, and keeps the message in the audit row", async () => {
    const s = await setup();
    const issue = await raiseIssue({
      documentChecklistItemId: s.coo.id, problem: "Wrong name", responsibleOrgType: "exporter", actingUser: s.parties.importer.admin,
    });

    const updated = await requestCorrection({
      issueId: issue.id, message: "Please reissue with the invoice exporter name", actingUser: s.parties.importer.admin,
    });
    expect(updated.status).toBe("correction_requested");
    expect(await itemStatus(s.coo.id)).toBe("flagged");

    const row = (await auditFor(issue.id)).find((a) => a.action === "issue.correction_requested")!;
    expect(row.metadata).toMatchObject({ message: "Please reissue with the invoice exporter name", previous_status: "open" });
  });

  it("can be repeated as a reminder, but not on a resolved issue, and needs a message", async () => {
    const s = await setup();
    const actingUser = s.parties.importer.admin;
    const issue = await raiseIssue({ documentChecklistItemId: s.coo.id, problem: "p", responsibleOrgType: "exporter", actingUser });

    await requestCorrection({ issueId: issue.id, message: "first", actingUser });
    await requestCorrection({ issueId: issue.id, message: "reminder", actingUser });
    await expect(requestCorrection({ issueId: issue.id, message: "  ", actingUser })).rejects.toThrow(ValidationError);

    await resolveIssue({ issueId: issue.id, actingUser });
    await expect(requestCorrection({ issueId: issue.id, message: "too late", actingUser })).rejects.toThrow(ValidationError);
  });

  it("uses the same party-org permission check", async () => {
    const s = await setup();
    const issue = await raiseIssue({
      documentChecklistItemId: s.coo.id, problem: "p", responsibleOrgType: "exporter", actingUser: s.parties.importer.admin,
    });
    const stranger = await createActiveOrg("exporter");
    await expect(requestCorrection({ issueId: issue.id, message: "m", actingUser: stranger.admin })).rejects.toThrow(
      PermissionDeniedError,
    );
    await expect(
      requestCorrection({ issueId: "00000000-0000-4000-8000-000000000000", message: "m", actingUser: s.parties.importer.admin }),
    ).rejects.toThrow(NotFoundError);
    expect((await db().select().from(issues))[0]!.status).toBe("open");
  });
});

describe("resolveIssue", () => {
  it("sets resolved and resolved_at, and puts the item back to pending, not verified", async () => {
    const s = await setup();
    const actingUser = s.parties.exporter.admin;
    const issue = await raiseIssue({ documentChecklistItemId: s.coo.id, problem: "p", responsibleOrgType: "exporter", actingUser });
    expect(await itemStatus(s.coo.id)).toBe("flagged");

    const resolved = await resolveIssue({ issueId: issue.id, actingUser });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolved_at).toBeInstanceOf(Date);
    expect(await itemStatus(s.coo.id)).toBe("pending");
    expect(await itemStatus(s.coo.id)).not.toBe("verified");
  });

  it("returns a previously verified item to pending as well, so it needs re-verification", async () => {
    const s = await setup();
    const actingUser = s.parties.importer.admin;
    await db().update(document_checklist_items).set({ status: "verified" }).where(eq(document_checklist_items.id, s.coo.id));
    const issue = await raiseIssue({ documentChecklistItemId: s.coo.id, problem: "p", responsibleOrgType: "exporter", actingUser });

    await resolveIssue({ issueId: issue.id, actingUser });
    expect(await itemStatus(s.coo.id)).toBe("pending");
  });

  it("keeps the item flagged until its last unresolved issue is resolved", async () => {
    const s = await setup();
    const actingUser = s.parties.importer.admin;
    const first = await raiseIssue({ documentChecklistItemId: s.coo.id, problem: "one", responsibleOrgType: "exporter", actingUser });
    const second = await raiseIssue({ documentChecklistItemId: s.coo.id, problem: "two", responsibleOrgType: "exporter", actingUser });
    await requestCorrection({ issueId: second.id, message: "fix two", actingUser });

    await resolveIssue({ issueId: first.id, actingUser });
    expect(await itemStatus(s.coo.id)).toBe("flagged"); // a correction_requested issue still counts

    await resolveIssue({ issueId: second.id, actingUser });
    expect(await itemStatus(s.coo.id)).toBe("pending");

    const rows = await auditFor(first.id);
    expect(rows.find((a) => a.action === "issue.resolved")!.metadata).toMatchObject({
      item_status_after: "flagged", remaining_unresolved_issues: 1,
    });
  });

  it("refuses to resolve twice, without a second audit row, and refuses outsiders", async () => {
    const s = await setup();
    const actingUser = s.parties.importer.admin;
    const issue = await raiseIssue({ documentChecklistItemId: s.coo.id, problem: "p", responsibleOrgType: "exporter", actingUser });

    const stranger = await createActiveOrg("importer");
    await expect(resolveIssue({ issueId: issue.id, actingUser: stranger.admin })).rejects.toThrow(PermissionDeniedError);
    expect((await db().select().from(issues))[0]!.status).toBe("open");

    await resolveIssue({ issueId: issue.id, actingUser });
    await expect(resolveIssue({ issueId: issue.id, actingUser })).rejects.toThrow(ValidationError);
    expect((await auditFor(issue.id)).filter((a) => a.action === "issue.resolved")).toHaveLength(1);
  });

  it("stays consistent when issues on one item are raised and resolved concurrently", async () => {
    const s = await setup();
    const actingUser = s.parties.importer.admin;

    const raised = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        raiseIssue({ documentChecklistItemId: s.coo.id, problem: `concurrent ${i}`, responsibleOrgType: "exporter", actingUser }),
      ),
    );
    expect(await itemStatus(s.coo.id)).toBe("flagged");

    await Promise.all(raised.map((r) => resolveIssue({ issueId: r.id, actingUser })));
    expect(await itemStatus(s.coo.id)).toBe("pending"); // never left flagged with nothing open
    expect((await db().select().from(issues)).every((i) => i.status === "resolved")).toBe(true);
  });
});

describe("issue audit trail", () => {
  it("every transition writes its own audit row with the right action, target, actor, and details", async () => {
    const s = await setup();
    const importerAdmin = s.parties.importer.admin;
    const exporterAdmin = s.parties.exporter.admin;

    const issue = await raiseIssue({
      documentChecklistItemId: s.coo.id, problem: "Mismatch", sourceChecklistItemId: s.invoice.id,
      responsibleOrgType: "exporter", actingUser: importerAdmin,
    });
    await requestCorrection({ issueId: issue.id, message: "Please fix", actingUser: importerAdmin });
    await resolveIssue({ issueId: issue.id, actingUser: exporterAdmin });

    const rows = (await auditFor(issue.id)).sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    expect(rows.map((r) => r.action)).toEqual(["issue.raised", "issue.correction_requested", "issue.resolved"]);
    for (const r of rows) expect(r).toMatchObject({ target_type: "issue", target_id: issue.id });
    expect(rows.map((r) => r.actor_user_id)).toEqual([importerAdmin.id, importerAdmin.id, exporterAdmin.id]);
    expect(rows[0]!.metadata).toMatchObject({
      consignment_id: s.consignment.id,
      document_checklist_item_id: s.coo.id,
      source_document_checklist_item_id: s.invoice.id,
      responsible_org_type: "exporter",
      item_status_before: "awaiting_upload", // kept so a later stage can restore the prior status
    });
    expect(rows[2]!.metadata).toMatchObject({ item_status_after: "pending", previous_status: "correction_requested" });
  });
});

describe("issues table constraints", () => {
  it("rejects resolved_at without a resolved status, and a resolved status without resolved_at", async () => {
    const s = await setup();
    const issue = await raiseIssue({
      documentChecklistItemId: s.coo.id, problem: "p", responsibleOrgType: "exporter", actingUser: s.parties.importer.admin,
    });
    const constraintOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        const err = e as { constraint?: string; cause?: { constraint?: string } };
        return err.cause?.constraint ?? err.constraint;
      }
      return undefined;
    };
    expect(await constraintOf(db().update(issues).set({ resolved_at: new Date() }).where(eq(issues.id, issue.id)))).toBe(
      "issues_resolved_at_matches_status",
    );
    expect(await constraintOf(db().update(issues).set({ status: "resolved" }).where(eq(issues.id, issue.id)))).toBe(
      "issues_resolved_at_matches_status",
    );
    expect(
      await constraintOf(
        db().update(issues).set({ source_document_checklist_item_id: s.coo.id }).where(eq(issues.id, issue.id)),
      ),
    ).toBe("issues_source_differs_from_item");
  });
});
