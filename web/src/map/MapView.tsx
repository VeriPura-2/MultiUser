import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";
import { getTheme } from "../theme/theme";
import { ATTRIBUTION, ATTRIBUTION_HTML, MAP_MAX_ZOOM, MAP_MIN_ZOOM, TILE_MAX_ZOOM, TILE_SUBDOMAINS, tileUrl } from "./tiles";
import { isStale, type Vessel } from "./vessel";
import "./MapView.css";

/** A transparent 1x1 picture, shown in place of a tile that fails to load, so the land underneath stays visible. */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Natural Earth 110m land, bundled with the app. It is the picture when the tile server is unreachable. */
const land = feature(landTopology as unknown as Topology, (landTopology as unknown as Topology).objects.land!);

/** Starting view: South America across to the United Kingdom, where the sample routes run. */
const START_BOUNDS: L.LatLngBoundsLiteral = [
  [-38, -72],
  [58, 8],
];

interface MapViewProps {
  vessels: Vessel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  ariaLabel: string;
}

interface VesselLayers {
  line: L.Polyline;
  marker: L.Marker;
}

/**
 * A Leaflet map of vessels and their routes. Leaflet is imperative, so this component owns the map
 * object and keeps it in step with React state through three effects: build once, restyle when the
 * selection changes, and swap the tile layer when the theme changes.
 *
 * The credit for the tiles is drawn by MapAttribution (React, always visible) rather than by
 * Leaflet's own control, so it cannot be dropped by a Leaflet option.
 */
export function MapView({ vessels, selectedId, onSelect, ariaLabel }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const layers = useRef(new Map<string, VesselLayers>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    const element = container.current;
    if (!element) return;

    const map = L.map(element, {
      zoomControl: true,
      scrollWheelZoom: false,
      attributionControl: false,
      minZoom: MAP_MIN_ZOOM,
      maxZoom: MAP_MAX_ZOOM,
      worldCopyJump: true,
    });

    // Offline fallback: land drawn from bundled data, in a pane below the tiles.
    map.createPane("fallback").style.zIndex = "150";
    L.geoJSON(land, { pane: "fallback", interactive: false, style: () => ({ className: "landfb" }) }).addTo(map);

    let tiles: L.TileLayer | null = null;
    const setTiles = () => {
      if (tiles) map.removeLayer(tiles);
      tiles = L.tileLayer(tileUrl(getTheme() === "dark"), {
        subdomains: TILE_SUBDOMAINS,
        maxZoom: TILE_MAX_ZOOM,
        attribution: ATTRIBUTION_HTML,
        errorTileUrl: BLANK_TILE,
      }).addTo(map);
    };
    setTiles();
    const observer = new MutationObserver(setTiles);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    map.fitBounds(START_BOUNDS, { padding: [10, 10] });

    const built = layers.current;
    for (const vessel of vessels) {
      const line = L.polyline(vessel.path, {
        className: `rt rt-${vessel.state}`,
        dashArray: "6 5",
        interactive: false,
      }).addTo(map);
      const icon = L.divIcon({
        className: "",
        html: `<div class="vdot v-${vessel.state}${isStale(vessel) ? " stale" : ""}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker(vessel.position, { icon, keyboard: true, title: vessel.label }).addTo(map);
      marker.bindTooltip(vessel.label, { permanent: true, direction: "right", offset: [8, 0], className: "vlabel" });
      marker.on("click", () => onSelectRef.current(vessel.id));
      built.set(vessel.id, { line, marker });
    }

    return () => {
      observer.disconnect();
      built.clear();
      map.remove();
    };
    // The vessels are read once, when the map is built.
  }, []);

  useEffect(() => {
    for (const [id, { line, marker }] of layers.current) {
      const selected = id === selectedId;
      line.setStyle({ opacity: selected ? 1 : 0.35, weight: selected ? 3.5 : 2 });
      const icon = marker.getElement();
      if (icon) icon.style.opacity = selected ? "1" : "0.8";
    }
  }, [selectedId]);

  return (
    <div className="map-frame">
      <div ref={container} className="map" role="region" aria-label={ariaLabel} />
      <MapAttribution />
    </div>
  );
}

/** The credit the tile provider requires, always on screen. */
export function MapAttribution() {
  return (
    <p className="map-attribution" data-testid="map-attribution">
      &copy;{" "}
      <a href={ATTRIBUTION.osm.href} target="_blank" rel="noreferrer">
        {ATTRIBUTION.osm.label}
      </a>{" "}
      contributors &copy;{" "}
      <a href={ATTRIBUTION.carto.href} target="_blank" rel="noreferrer">
        {ATTRIBUTION.carto.label}
      </a>{" "}
      &middot; Fallback land: {ATTRIBUTION.fallback}
    </p>
  );
}
