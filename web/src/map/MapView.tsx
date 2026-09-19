import * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";
import landTopology from "world-atlas/land-110m.json";
import { getTheme } from "../theme/theme";
import { ATTRIBUTION, ATTRIBUTION_HTML, MAP_MAX_ZOOM, MAP_MIN_ZOOM, TILE_MAX_ZOOM, TILE_SUBDOMAINS, tileUrl } from "./tiles";
import { isDrawn, isStale, type MapVessel } from "./vessel";
import "./MapView.css";

/** A transparent 1x1 picture, shown in place of a tile that fails to load, so the land underneath stays visible. */
const BLANK_TILE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Natural Earth 110m land, bundled with the app. It is the picture when the tile server is unreachable. */
const land = feature(landTopology as unknown as Topology, (landTopology as unknown as Topology).objects.land!);

/** The view before any vessel is known: the Atlantic between South America and the United Kingdom. */
const START_BOUNDS: L.LatLngBoundsLiteral = [
  [-38, -72],
  [58, 8],
];

interface MapViewProps {
  /** Only the vessels with a position are drawn; the others (no marker) are ignored here. */
  vessels: MapVessel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  ariaLabel: string;
}

interface VesselLayers {
  trail: L.Polyline | null;
  marker: L.Marker;
}

/**
 * A Leaflet map of vessels and the trails they have actually sailed. Leaflet is imperative, so this
 * component owns the map object and keeps it in step with React through four effects: build the map
 * once, redraw markers and trails when the vessels change (positions refresh every minute), restyle
 * when the selection changes, and (inside the first one) swap the tile layer when the theme changes.
 *
 * A "recent" vessel is a normal marker and a "stale" one is the hollow dashed marker. There is no
 * planned route: only the vessel's own trail is drawn, as a thin line.
 *
 * The credit for the tiles is drawn by MapAttribution (React, always visible) rather than by
 * Leaflet's own control, so it cannot be dropped by a Leaflet option.
 */
export function MapView({ vessels, selectedId, onSelect, ariaLabel }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const drawn = useRef<L.LayerGroup | null>(null);
  const layers = useRef(new Map<string, VesselLayers>());
  const fitted = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;

  const styleSelection = () => {
    for (const [id, { trail, marker }] of layers.current) {
      const selected = id === selectedRef.current;
      trail?.setStyle({ opacity: selected ? 1 : 0.4, weight: selected ? 3 : 1.5 });
      const icon = marker.getElement();
      if (icon) icon.style.opacity = selected ? "1" : "0.8";
    }
  };

  // Build the map once.
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
    mapRef.current = map;

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
    drawn.current = L.layerGroup().addTo(map);

    return () => {
      observer.disconnect();
      layers.current.clear();
      drawn.current = null;
      mapRef.current = null;
      fitted.current = false;
      map.remove();
    };
  }, []);

  // Draw the vessels, and draw them again whenever they change.
  useEffect(() => {
    const map = mapRef.current;
    const group = drawn.current;
    if (!map || !group) return;
    group.clearLayers();
    layers.current.clear();

    const shown = vessels.filter(isDrawn);
    for (const vessel of shown) {
      const trail =
        vessel.trail.length >= 2
          ? L.polyline(vessel.trail, { className: `rt rt-${vessel.state}`, interactive: false }).addTo(group)
          : null;
      const icon = L.divIcon({
        className: "",
        html: `<div class="vdot v-${vessel.state}${isStale(vessel) ? " stale" : ""}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      const marker = L.marker(vessel.position!, { icon, keyboard: true, title: vessel.label }).addTo(group);
      marker.bindTooltip(vessel.label, { permanent: true, direction: "right", offset: [8, 0], className: "vlabel" });
      marker.on("click", () => onSelectRef.current(vessel.id));
      layers.current.set(vessel.id, { trail, marker });
    }
    styleSelection();

    // The first time there is something to show, frame it. After that the user's own view is left alone.
    if (!fitted.current && shown.length > 0) {
      fitted.current = true;
      map.fitBounds(L.latLngBounds(shown.map((v) => v.position!)), { padding: [40, 40], maxZoom: 6 });
    }
  }, [vessels]);

  // Restyle when the selection changes.
  useEffect(() => {
    styleSelection();
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
