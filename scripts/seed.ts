import "dotenv/config";
import { recordAudit } from "../src/audit/recordAudit.js";
import { closeDb, getDb } from "../src/db/client.js";
import { document_types, users } from "../src/db/schema.js";

/**
 * Local-sandbox seed. Idempotent: safe to run repeatedly.
 *
 * Creates a VeriPura superadmin (organization_id null) and a starter set of document types.
 * It deliberately seeds NO document_permission_rules: the default visibility matrix is a
 * follow-up data-seeding step taken from the pilot's Scope of Work, not part of this build.
 * With no rules, every document type resolves to full view with no edit/download/approve.
 */
const DOCUMENT_TYPES = [
  { name: "Commercial Invoice", category: "Customs & logistics" },
  { name: "Packing List", category: "Customs & logistics" },
  { name: "Bill of Lading", category: "Customs & logistics" },
  { name: "Export Health Certificate", category: "Certifications" },
];

async function main(): Promise<void> {
  const db = getDb();
  const email = (process.env.SEED_SUPERADMIN_EMAIL ?? "superadmin@veripura.local").toLowerCase();

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({ organization_id: null, email, name: "VeriPura Superadmin", status: "active" })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      await recordAudit(
        {
          actorUser: null,
          action: "user.superadmin_seeded",
          targetType: "user",
          targetId: inserted[0].id,
          metadata: { email },
        },
        tx,
      );
      console.log(`Created superadmin ${email}`);
    } else {
      console.log(`Superadmin ${email} already exists`);
    }

    const created = await tx.insert(document_types).values(DOCUMENT_TYPES).onConflictDoNothing().returning();
    console.log(`Document types created: ${created.length} of ${DOCUMENT_TYPES.length}`);
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
