import "dotenv/config";
import { closeDb } from "../src/db/client.js";
import { seedDev } from "../src/dev/seedDev.js";

// Local sandbox sample data for developing the UI. Everything it creates is labelled "Sample".
// Refuses to run against a database that is not on this machine. See src/dev/seedDev.ts.
seedDev((line) => console.log(line))
  .then((summary) => {
    if (summary.skipped) return;
    console.log("\nUsers you can act as (send the user id in an X-Dev-User header, or pick one in the UI switcher):");
    for (const u of summary.users) {
      const where = u.organization ?? "VeriPura (no organization)";
      console.log(`  ${u.email.padEnd(44)} ${where}${u.roles.length ? `, ${u.roles.join(" + ")}` : ""}`);
    }
    console.log("\nConsignments:");
    for (const c of summary.consignments) console.log(`  ${c.status.padEnd(20)} ${c.label}`);
    console.log("\nDone. This is sample data: none of it is real.");
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
