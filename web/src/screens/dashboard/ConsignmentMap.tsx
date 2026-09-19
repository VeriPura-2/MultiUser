import { useState } from "react";
import { Card } from "../../components/Card";
import { MapView } from "../../map/MapView";
import { STATE_LABEL, describePosition, type Vessel } from "../../map/vessel";

/**
 * The map card: the map, one chip per vessel, an info line for the selected one, and a legend.
 * The positions are sample data and the card says so; see web/src/sample/mapSample.ts.
 */
export function ConsignmentMap({ vessels }: { vessels: Vessel[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(vessels[0]?.id ?? null);
  const selected = vessels.find((v) => v.id === selectedId) ?? null;

  return (
    <Card as="section" aria-label="Consignment map" className="map-card">
      <div className="panel-head map-head">
        <h2>Consignment map</h2>
        <span className="sample-flag" title="These positions are illustrative. No tracking source is connected yet.">
          Sample positions
        </span>
      </div>
      <div className="map-box">
        <MapView
          vessels={vessels}
          selectedId={selectedId}
          onSelect={setSelectedId}
          ariaLabel="Map of sample consignments between South America, Ireland and the United Kingdom"
        />
      </div>
      <div className="chip-row map-chips" role="group" aria-label="Choose a vessel">
        {vessels.map((v) => (
          <button key={v.id} type="button" className={`chip${v.id === selectedId ? " on" : ""}`} aria-pressed={v.id === selectedId} onClick={() => setSelectedId(v.id)}>
            {v.label}
          </button>
        ))}
      </div>
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
            <span className="soft">{describePosition(selected)} (sample)</span>
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
