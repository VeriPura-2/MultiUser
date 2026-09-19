import type { ConsignmentPositionItem, ConsignmentSummary } from "../../api/types";
import { count, countryName, shortRef } from "../../format";
import { CONSIGNMENT_STATUS, isLiveConsignment } from "../../labels";
import type { MapVessel, VesselState } from "../../map/vessel";

/** Turns the consignment list and GET /positions into what the map draws. Pure, so it is tested directly. */

/** Red with an open issue, green ("cleared") once every required document is verified, otherwise "on track". */
export function vesselState(c: ConsignmentSummary): VesselState {
  if (c.openIssueCount > 0) return "issue";
  const { verified, total } = c.checklistCompleteness;
  return total > 0 && verified === total ? "done" : "ok";
}

function statusText(c: ConsignmentSummary): string {
  const status = CONSIGNMENT_STATUS[c.status].label;
  return c.openIssueCount > 0 ? `${status}, ${count(c.openIssueCount, "open issue")}` : status;
}

/**
 * One entry per live consignment, in the list's order, including those with no position (the map
 * says why there is no dot for them). A consignment is drawn only where the server gave it a
 * position; nothing is invented, and there is no route from origin to destination, since the
 * backend has no port or route data. The trail is what the vessel actually reported.
 */
export function buildMapVessels(consignments: ConsignmentSummary[], positions: ConsignmentPositionItem[]): MapVessel[] {
  const byConsignment = new Map(positions.map((p) => [p.consignmentId, p]));
  return consignments.filter((c) => isLiveConsignment(c.status)).map((c) => {
    const p = byConsignment.get(c.id);
    const hasPosition = p !== undefined && p.freshness !== "unavailable" && p.lat !== null && p.lng !== null;
    return {
      id: c.id,
      label: shortRef(c.id),
      commodity: c.commodity,
      routeLabel: `${countryName(c.originCountry)} to ${countryName(c.destinationCountry)}`,
      state: vesselState(c),
      statusText: statusText(c),
      freshness: hasPosition ? p.freshness : "unavailable",
      reason: hasPosition ? null : (p?.reason ?? "no_position_received"),
      position: hasPosition ? [p.lat!, p.lng!] : null,
      trail: hasPosition ? (p.trail ?? []).map((t): [number, number] => [t.lat, t.lng]) : [],
      positionTime: hasPosition ? p.positionTime : null,
      speedKnots: hasPosition ? p.speedKnots : null,
      headingDeg: hasPosition ? p.headingDeg : null,
      isSample: hasPosition ? p.isSample : false,
    };
  });
}
