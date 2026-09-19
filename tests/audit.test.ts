import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { recordAudit } from "../src/audit/recordAudit.js";
import { getDb } from "../src/db/client.js";
import { audit_log } from "../src/db/schema.js";
import { ValidationError } from "../src/errors.js";
import { createSuperadmin } from "./helpers.js";

describe("recordAudit", () => {
  it("inserts a row with the actor, action, target, and metadata", async () => {
    const actor = await createSuperadmin();
    const targetId = randomUUID();
    await recordAudit({
      actorUser: actor,
      action: "issue.raised",
      targetType: "issue",
      targetId,
      metadata: { reason: "mismatch", count: 2 },
    });

    const [row] = await getDb().select().from(audit_log).where(eq(audit_log.target_id, targetId));
    expect(row).toMatchObject({
      actor_user_id: actor.id,
      action: "issue.raised",
      target_type: "issue",
      metadata: { reason: "mismatch", count: 2 },
    });
    expect(row!.created_at).toBeInstanceOf(Date);
  });

  it("stores a null actor for system-initiated actions, and defaults metadata to {}", async () => {
    const targetId = randomUUID();
    await recordAudit({ actorUser: null, action: "consignment.checklist_received", targetType: "consignment", targetId });

    const [row] = await getDb().select().from(audit_log).where(eq(audit_log.target_id, targetId));
    expect(row!.actor_user_id).toBeNull();
    expect(row!.metadata).toEqual({});
  });

  it.each(["OrgApproved", "approved", "org approved", "org.", ".approved", ""])(
    "rejects the malformed action name %j",
    async (action) => {
      await expect(
        recordAudit({ actorUser: null, action, targetType: "organization", targetId: randomUUID() }),
      ).rejects.toThrow(ValidationError);
    },
  );

  it("commits with its transaction and rolls back with it", async () => {
    const committed = randomUUID();
    await getDb().transaction((tx) =>
      recordAudit({ actorUser: null, action: "test.committed", targetType: "thing", targetId: committed }, tx),
    );

    const rolledBack = randomUUID();
    await expect(
      getDb().transaction(async (tx) => {
        await recordAudit({ actorUser: null, action: "test.rolled_back", targetType: "thing", targetId: rolledBack }, tx);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await getDb().select().from(audit_log).where(eq(audit_log.target_id, committed))).toHaveLength(1);
    expect(await getDb().select().from(audit_log).where(eq(audit_log.target_id, rolledBack))).toHaveLength(0);
  });
});
