import { eq } from "drizzle-orm";
import { recordAudit } from "../audit/recordAudit.js";
import { getDb } from "../db/client.js";
import { consignments } from "../db/schema.js";
import { PermissionDeniedError, UnprocessableEntityError } from "../errors.js";
import { parseVesselFields, type VesselFieldsInput } from "../tracking/identifiers.js";
import { isSuperadmin, type UserRef } from "../types.js";
import { loadActiveActor } from "./actors.js";
import { UUID_PATTERN, consignmentNotFound, getConsignmentDetail, isPartyTo, type ConsignmentDetail } from "./consignmentViews.js";

/**
 * Sets or clears the vessel identifiers on a consignment.
 *
 * Who may: the importing organization (which submitted the consignment and is the one that wants
 * it tracked), and superadmin. The permission engine grants per document rather than per
 * consignment, so there is no finer grant to consult yet; this is the same rule as submitting the
 * purchase order. The exporter is a party and can see the consignment, so it gets 403, not 404. A
 * user who is not a party gets exactly what a missing consignment gets.
 *
 * Only the fields named in `changes` are touched, and blank or null clears one. Something that
 * changes nothing is answered with the current detail and writes no audit row. A real change
 * writes "consignment.vessel_updated" with the old and new values, in the same transaction.
 */
export async function updateConsignmentVessel(input: {
  consignmentId: string;
  actingUser: UserRef;
  changes: VesselFieldsInput;
}): Promise<ConsignmentDetail> {
  const actor = await loadActiveActor(input.actingUser);
  if (!UUID_PATTERN.test(input.consignmentId)) throw consignmentNotFound();

  await getDb().transaction(async (tx) => {
    // Lock the row so two edits at once cannot each audit a stale "old" value.
    const [c] = await tx.select().from(consignments).where(eq(consignments.id, input.consignmentId)).for("update");
    if (!c || !isPartyTo(actor, c)) throw consignmentNotFound();
    if (!isSuperadmin(actor) && actor.organization_id !== c.importer_org_id) {
      throw new PermissionDeniedError("Only the importing organization can change the vessel");
    }

    const named = ["vesselImo", "vesselMmsi", "vesselName"].some((k) => (input.changes as Record<string, unknown>)[k] !== undefined);
    if (!named) throw new UnprocessableEntityError("Send at least one of vesselImo, vesselMmsi, vesselName.");
    const next = parseVesselFields(input.changes);

    const before = { vessel_imo: c.vessel_imo, vessel_mmsi: c.vessel_mmsi, vessel_name: c.vessel_name };
    const after = {
      vessel_imo: next.vesselImo === undefined ? c.vessel_imo : next.vesselImo,
      vessel_mmsi: next.vesselMmsi === undefined ? c.vessel_mmsi : next.vesselMmsi,
      vessel_name: next.vesselName === undefined ? c.vessel_name : next.vesselName,
    };
    if (before.vessel_imo === after.vessel_imo && before.vessel_mmsi === after.vessel_mmsi && before.vessel_name === after.vessel_name) return;

    await tx.update(consignments).set(after).where(eq(consignments.id, c.id));
    await recordAudit(
      { actorUser: actor, action: "consignment.vessel_updated", targetType: "consignment", targetId: c.id, metadata: { old: before, new: after } },
      tx,
    );
  });

  return getConsignmentDetail(input.consignmentId, actor);
}
