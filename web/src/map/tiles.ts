/**
 * Where the map's picture comes from. Everything about the tile provider is here, so changing
 * provider (or adding a key) is a change to this file only.
 *
 * CARTO's public basemaps, built on OpenStreetMap data. No paid key. The provider asks to be
 * credited wherever its tiles show, so the credit is part of this module and the map always
 * renders it (see MapAttribution).
 */

/** Used while the app is in its dark theme (`html.dark`). */
export const TILE_URL_DARK = "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";
/** Used in the light theme. */
export const TILE_URL_LIGHT = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";

export const TILE_SUBDOMAINS = "abcd";
/** The deepest zoom the tile server serves. */
export const TILE_MAX_ZOOM = 19;

/** How far the user can zoom the map itself. This is a regional overview, not a street map. */
export const MAP_MIN_ZOOM = 2;
export const MAP_MAX_ZOOM = 8;

export const tileUrl = (dark: boolean): string => (dark ? TILE_URL_DARK : TILE_URL_LIGHT);

/** The credit the map must always show. Kept as data so the same words feed the tile layer and the on-screen text. */
export const ATTRIBUTION = {
  osm: { label: "OpenStreetMap", href: "https://www.openstreetmap.org/copyright" },
  carto: { label: "CARTO", href: "https://carto.com/attributions" },
  fallback: "Natural Earth",
} as const;

/** The same credit as an HTML string, for the tile layer's own `attribution` option. */
export const ATTRIBUTION_HTML =
  `&copy; <a href="${ATTRIBUTION.osm.href}">${ATTRIBUTION.osm.label}</a> contributors ` +
  `&copy; <a href="${ATTRIBUTION.carto.href}">${ATTRIBUTION.carto.label}</a>`;
