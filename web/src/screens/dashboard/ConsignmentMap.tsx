import { useState } from "react";
import { Link } from "react-router-dom";
import { Card } from "../../components/Card";
import { MapView } from "../../map/MapView";
import { STATE_LABEL, describePosition, isDrawn, mapFlag, type MapVessel } from "../../map/vessel";

const FLAG_TITLE: Record<ReturnType<typeof mapFlag>["tone"], string> = {
  sample: "These positions are made-up demonstration data, not real ships.",
  live: "Positions reported by ships over AIS. Each shows how old it is.",
  stale: "The last positions received. None is recent, so none is shown as live.",
  none: "No vessel has a position to show.",
};

/**
 * The map card: the map, one chip per consignment, an info line for the selected one, and a legend.
 * A consignment with a recent position is a marker, one with an old position is a hollow marker, and
 * one with no position has no marker, but is still a chip whose info line says why. The flag says
 * whether what is drawn is sample data or live AIS, and never calls old positions live.
 */
export function ConsignmentMap({ vessels }: { vessels: MapVessel[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = vessels.find((v) => v.id === selectedId) ?? vessels.find(isDrawn) ?? vessels[0] ?? null;
  const flag = mapFlag(vessels);

  return (
    <Card as="section" aria-label="Consignment map" className="map-card">
      <div className="panel-head map-head">
        <h2>Consignment map</h2>
        <span className={`map-flag ${flag.tone}`} title={FLAG_TITLE[flag.tone]}>
          {flag.text}
        </span>
      </div>
      <div className="map-box">
        <MapView
          vessels={vessels}
          selectedId={selected?.id ?? null}
          onSelect={setSelectedId}
          ariaLabel="Map of the positions of active consignments"
        />
      </div>
      {vessels.length === 0 ? (
        <p className="map-empty">There are no active consignments to show on the map.</p>
      ) : (
        <div className="chip-row map-chips" role="group" aria-label="Choose a consignment">
          {vessels.map((v) => (
            <button key={v.id} type="button" className={`chip${v.id === selected?.id ? " on" : ""}`} aria-pressed={v.id === selected?.id} onClick={() => setSelectedId(v.id)}>
              {v.label}
            </button>
          ))}
        </div>
      )}
      <div className="map-info" aria-live="polite">
        {selected ? (
          <>
            <strong>
              {selected.label} &middot; {selected.commodity}
            </strong>
            <br />
            <span className="soft">
              {selected.routeLabel} &middot; {selected.statusText}
            </span>
            <br />
            <span className="soft">{describePosition(selected)}</span>{" "}
            <Link to={`/consignments/${selected.id}`} className="map-open">
              Open roadmap &rarr;
            </Link>
          </>
        ) : null}
      </div>
      <div className="legend">
        {(["issue", "ok", "done"] as const).map((state) => (
          <span key={state}>
            <span className={`legend-dot ${state}`} aria-hidden="true" />
            {STATE_LABEL[state]}
          </span>
        ))}
        <span>
          <span className="legend-dot stale" aria-hidden="true" />
          No recent position
        </span>
      </div>
    </Card>
  );
}
