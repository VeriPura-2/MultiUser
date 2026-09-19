import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { distance, greatCircle, pointAlong, routeThrough } from "../src/map/geo";
import { ATTRIBUTION_HTML, MAP_MAX_ZOOM, MAP_MIN_ZOOM, TILE_SUBDOMAINS, TILE_URL_DARK, TILE_URL_LIGHT, tileUrl } from "../src/map/tiles";
import { STALE_AFTER_MINUTES, describePosition, isStale } from "../src/map/vessel";
import { SAMPLE_VESSELS } from "../src/sample/mapSample";
import { consignment, dashboardApi, importerAdmin } from "./fixtures";
import { renderApp } from "./renderApp";

// Leaflet's tile layer is replaced by a recorder that hands back an empty layer group, so the test
// sees exactly which tiles the map asks for and never touches the network. Everything else in
// Leaflet is real.
const tileRequests = vi.hoisted(() => [] as Array<{ url: string; options: Record<string, unknown>; layer: unknown }>);
vi.mock("leaflet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("leaflet")>();
  const real = (actual as unknown as { default?: typeof actual }).default ?? actual;
  const tileLayer = (url: string, options: Record<string, unknown>) => {
    const layer = real.layerGroup();
    tileRequests.push({ url, options, layer });
    return layer;
  };
  return { ...real, default: { ...real, tileLayer }, tileLayer };
});

const mapCard = () => screen.findByRole("region", { name: "Consignment map" });
/** The chip for a vessel. The map's own markers are buttons with the same names, so scope to the chip row. */
const chip = (card: HTMLElement, label: string) => within(within(card).getByRole("group", { name: "Choose a vessel" })).getByRole("button", { name: label });

describe("map: what the card must always say", () => {
  it("shows the tile provider's credit, as links, at all times", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const credit = await screen.findByTestId("map-attribution");
    expect(credit).toBeVisible();
    expect(credit).toHaveTextContent("OpenStreetMap contributors");
    expect(credit).toHaveTextContent("CARTO");
    expect(within(credit).getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(within(credit).getByRole("link", { name: "CARTO" })).toHaveAttribute("href", "https://carto.com/attributions");
  });

  it("flags the positions as sample data, and does not claim the view is live", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const card = await mapCard();
    expect(within(card).getByText("Sample positions")).toBeInTheDocument();
    expect(card).not.toHaveTextContent(/live/i);
    expect(within(card).getByText(/\(sample\)/)).toBeInTheDocument(); // the info line says so too
  });

  it("keeps the credit and the flag while the other theme is showing", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    await screen.findByTestId("map-attribution");
    await userEvent.click(screen.getByRole("button", { name: /toggle dark mode/i }));
    expect(screen.getByTestId("map-attribution")).toBeVisible();
    expect(screen.getByText("Sample positions")).toBeInTheDocument();
  });
});

describe("map: tiles follow the theme", () => {
  it("asks for light tiles in the light theme and swaps to dark tiles, and back, when the theme is toggled", async () => {
    tileRequests.length = 0;
    dashboardApi(importerAdmin);
    renderApp("/");
    await screen.findByTestId("map-attribution");
    await waitFor(() => expect(tileRequests).toHaveLength(1));
    expect(tileRequests[0]!.url).toBe(TILE_URL_LIGHT);
    expect(TILE_URL_LIGHT).toContain("basemaps.cartocdn.com/rastertiles/voyager/");

    await userEvent.click(screen.getByRole("button", { name: /toggle dark mode/i }));
    await waitFor(() => expect(tileRequests).toHaveLength(2));
    expect(tileRequests[1]!.url).toBe(TILE_URL_DARK);
    expect(TILE_URL_DARK).toContain("basemaps.cartocdn.com/dark_all/");

    await userEvent.click(screen.getByRole("button", { name: /toggle dark mode/i }));
    await waitFor(() => expect(tileRequests).toHaveLength(3));
    expect(tileRequests[2]!.url).toBe(TILE_URL_LIGHT);
  });

  it("removes the old tile layer when it swaps, so only one is ever on the map", async () => {
    tileRequests.length = 0;
    dashboardApi(importerAdmin);
    renderApp("/");
    await screen.findByTestId("map-attribution");
    await waitFor(() => expect(tileRequests).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: /toggle dark mode/i }));
    await waitFor(() => expect(tileRequests).toHaveLength(2));
    const onMap = (layer: unknown) => Boolean((layer as { _map?: unknown })._map);
    expect(onMap(tileRequests[0]!.layer)).toBe(false);
    expect(onMap(tileRequests[1]!.layer)).toBe(true);
  });

  it("starts in dark tiles when the saved theme is dark", async () => {
    tileRequests.length = 0;
    document.documentElement.classList.add("dark");
    dashboardApi(importerAdmin);
    renderApp("/");
    await screen.findByTestId("map-attribution");
    await waitFor(() => expect(tileRequests.length).toBeGreaterThan(0));
    expect(tileRequests[0]!.url).toBe(TILE_URL_DARK);
  });

  it("gives the tile layer its subdomains, zoom limit, credit and a blank picture for missing tiles", async () => {
    tileRequests.length = 0;
    dashboardApi(importerAdmin);
    renderApp("/");
    await waitFor(() => expect(tileRequests).toHaveLength(1));
    const options = tileRequests[0]!.options;
    expect(options.subdomains).toBe(TILE_SUBDOMAINS);
    expect(options.attribution).toBe(ATTRIBUTION_HTML);
    expect(options.attribution).toContain("OpenStreetMap");
    expect(options.attribution).toContain("CARTO");
    expect(String(options.errorTileUrl)).toMatch(/^data:image\/gif/);
  });

  it("tileUrl picks by theme", () => {
    expect(tileUrl(true)).toBe(TILE_URL_DARK);
    expect(tileUrl(false)).toBe(TILE_URL_LIGHT);
  });
});

describe("map: markers, routes and fallback land", () => {
  it("draws the fallback land, a route and a marker for each sample vessel, and no default Leaflet marker image", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    await screen.findByTestId("map-attribution");
    const map = screen.getByRole("region", { name: /map of sample consignments/i });
    await waitFor(() => expect(map.querySelectorAll(".vdot")).toHaveLength(SAMPLE_VESSELS.length));
    expect(map.querySelectorAll(".rt")).toHaveLength(SAMPLE_VESSELS.length);
    expect(map.querySelector(".landfb")).not.toBeNull();
    expect(map.querySelector("img.leaflet-marker-icon")).toBeNull();
    expect(map.querySelector(".leaflet-control-zoom")).not.toBeNull();
    expect(map.querySelector(".leaflet-control-attribution")).toBeNull(); // the credit is ours, outside Leaflet
  });

  it("draws the hollow marker only for a position that is not recent", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const map = await screen.findByRole("region", { name: /map of sample consignments/i });
    await waitFor(() => expect(map.querySelectorAll(".vdot")).toHaveLength(SAMPLE_VESSELS.length));
    expect(map.querySelectorAll(".vdot.stale")).toHaveLength(SAMPLE_VESSELS.filter(isStale).length);
    expect(SAMPLE_VESSELS.some(isStale)).toBe(true);
    expect(SAMPLE_VESSELS.some((v) => !isStale(v))).toBe(true);
  });

  it("colours each marker by its state", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const map = await screen.findByRole("region", { name: /map of sample consignments/i });
    await waitFor(() => expect(map.querySelectorAll(".vdot")).toHaveLength(SAMPLE_VESSELS.length));
    for (const state of ["issue", "ok", "done"] as const) {
      expect(map.querySelectorAll(`.vdot.v-${state}`)).toHaveLength(SAMPLE_VESSELS.filter((v) => v.state === state).length);
    }
  });
});

describe("map: choosing a vessel", () => {
  it("starts on the first vessel and shows its details", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const card = await mapCard();
    const first = SAMPLE_VESSELS[0]!;
    expect(chip(card, first.label)).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveTextContent(`${first.label} · ${first.commodity}`);
    expect(card).toHaveTextContent(describePosition(first));
  });

  it("switches the info line when another chip is chosen", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const card = await mapCard();
    const stale = SAMPLE_VESSELS.find(isStale)!;
    await userEvent.click(chip(card, stale.label));
    expect(chip(card, stale.label)).toHaveAttribute("aria-pressed", "true");
    expect(chip(card, SAMPLE_VESSELS[0]!.label)).toHaveAttribute("aria-pressed", "false");
    expect(card).toHaveTextContent(`${stale.label} · ${stale.commodity}`);
    expect(card).toHaveTextContent(/No position for \d+ h, showing last known/);
  });

  it("emphasises the chosen route and dims the others", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const card = await mapCard();
    const map = screen.getByRole("region", { name: /map of sample consignments/i });
    await waitFor(() => expect(map.querySelectorAll(".rt")).toHaveLength(SAMPLE_VESSELS.length));
    await userEvent.click(chip(card, SAMPLE_VESSELS[2]!.label));
    const routes = [...map.querySelectorAll<SVGPathElement>(".rt")];
    const widths = routes.map((r) => r.getAttribute("stroke-width"));
    expect(widths.filter((w) => w === "3.5")).toHaveLength(1);
    expect(widths.filter((w) => w === "2")).toHaveLength(SAMPLE_VESSELS.length - 1);
    expect(routes[2]!.getAttribute("stroke-width")).toBe("3.5");
  });

  it("selecting a vessel does not rebuild the map (no extra tile requests)", async () => {
    tileRequests.length = 0;
    dashboardApi(importerAdmin);
    renderApp("/");
    const card = await mapCard();
    await waitFor(() => expect(tileRequests).toHaveLength(1));
    await userEvent.click(chip(card, SAMPLE_VESSELS[1]!.label));
    expect(tileRequests).toHaveLength(1);
  });

  it("has no link to a roadmap: sample vessels are not consignments", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment()] });
    renderApp("/");
    const card = await mapCard();
    expect(within(card).queryByRole("link", { name: /roadmap/i })).not.toBeInTheDocument();
  });

  it("explains the markers in a legend, including the hollow one", async () => {
    dashboardApi(importerAdmin);
    renderApp("/");
    const card = await mapCard();
    for (const text of ["Open issue", "On track", "Cleared", "No recent position"]) {
      expect(within(card).getByText(text)).toBeInTheDocument();
    }
  });
});

describe("sample data honesty", () => {
  it("gives sample vessels ids and labels that cannot be mistaken for consignment references", () => {
    for (const v of SAMPLE_VESSELS) {
      expect(v.label).toMatch(/^Sample /);
      expect(v.id).not.toMatch(/^#|^[A-Z]{2}-\d+/);
    }
  });

  it("keeps every sample position on its own route", () => {
    for (const v of SAMPLE_VESSELS) {
      const nearest = Math.min(...v.path.map((p) => distance(p, v.position)));
      expect(nearest).toBeLessThan(0.05); // radians, about 300 km: the position is interpolated between route points
    }
  });
});

describe("vessel age wording", () => {
  it("counts a position as stale from the threshold, and words each case", () => {
    expect(isStale({ positionAgeMinutes: STALE_AFTER_MINUTES - 1 })).toBe(false);
    expect(isStale({ positionAgeMinutes: STALE_AFTER_MINUTES })).toBe(true);
    expect(describePosition({ positionAgeMinutes: 12 })).toBe("Last position 12 min ago");
    expect(describePosition({ positionAgeMinutes: 9 * 60 })).toBe("No position for 9 h, showing last known");
  });

  it("limits the map's zoom to a regional view", () => {
    expect(MAP_MIN_ZOOM).toBe(2);
    expect(MAP_MAX_ZOOM).toBeLessThanOrEqual(10);
  });
});

describe("geo helpers", () => {
  const dublin: [number, number] = [53.3, -6.3];
  const santos: [number, number] = [-24.0, -46.3];

  it("greatCircle starts and ends exactly on its endpoints and has the requested number of steps", () => {
    const points = greatCircle(santos, dublin, 10);
    expect(points).toHaveLength(11);
    expect(points[0]![0]).toBeCloseTo(santos[0], 6);
    expect(points[0]![1]).toBeCloseTo(santos[1], 6);
    expect(points[10]![0]).toBeCloseTo(dublin[0], 6);
    expect(points[10]![1]).toBeCloseTo(dublin[1], 6);
  });

  it("greatCircle stays on the shortest path: every point is between the endpoints", () => {
    const total = distance(santos, dublin);
    for (const p of greatCircle(santos, dublin, 10)) {
      expect(distance(santos, p) + distance(p, dublin)).toBeCloseTo(total, 6);
    }
  });

  it("greatCircle copes with identical endpoints", () => {
    expect(greatCircle(dublin, dublin, 5)).toEqual([dublin, dublin]);
  });

  it("routeThrough joins legs without repeating the shared waypoint", () => {
    const path = routeThrough([santos, [0, -30], dublin], 4);
    expect(path).toHaveLength(9);
  });

  it("pointAlong finds the ends, clamps outside 0 to 1, and finds the middle by distance", () => {
    const path: Array<[number, number]> = [
      [0, 0],
      [0, 10],
      [0, 30],
    ];
    expect(pointAlong(path, 0)).toEqual([0, 0]);
    expect(pointAlong(path, 1)).toEqual([0, 30]);
    expect(pointAlong(path, -5)).toEqual([0, 0]);
    expect(pointAlong(path, 5)).toEqual([0, 30]);
    const mid = pointAlong(path, 0.5);
    expect(mid[0]).toBeCloseTo(0, 1);
    expect(mid[1]).toBeCloseTo(15, 0);
  });
});
