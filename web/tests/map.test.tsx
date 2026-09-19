import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { POSITIONS_REFETCH_MS } from "../src/api/hooks";
import { distance, greatCircle, pointAlong, routeThrough } from "../src/map/geo";
import { ATTRIBUTION_HTML, MAP_MAX_ZOOM, MAP_MIN_ZOOM, TILE_SUBDOMAINS, TILE_URL_DARK, TILE_URL_LIGHT, tileUrl } from "../src/map/tiles";
import { ConsignmentMap } from "../src/screens/dashboard/ConsignmentMap";
import { SAMPLE_VESSELS } from "../src/sample/mapSample";
import { consignment, dashboardApi, importerAdmin, noPosition, positionItem } from "./fixtures";
import { respond } from "./mockApi";
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

// The map is a lazily loaded chunk (Leaflet and the land data), and the first load is slow on a busy
// machine. Load it once up front, with room to do so, so no test's own wait has to cover it.
beforeAll(async () => {
  await import("../src/screens/dashboard/ConsignmentMap");
}, 90_000);

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const D = "dddddddd-0000-4000-8000-000000000004";
const HOURS = 3_600_000;
const trailOf = (points: Array<[number, number]>) => points.map(([lat, lng], i) => ({ lat, lng, positionTime: new Date(Date.now() - (points.length - i) * 600_000).toISOString() }));

const mapCard = () => screen.findByRole("region", { name: "Consignment map" });
/** The chip for a consignment. The map's own markers are buttons with the same names, so scope to the chip row. */
const chip = (card: HTMLElement, label: string) => within(within(card).getByRole("group", { name: "Choose a consignment" })).getByRole("button", { name: label });
const map = () => screen.getByRole("region", { name: /map of the positions/i });
const markers = () => map().querySelectorAll(".vdot");

/** A dashboard whose map has these consignments and positions. */
function withMap(consignments = [consignment({ id: A, commodity: "Frozen beef" })], positions = [positionItem(A)]) {
  return dashboardApi(importerAdmin, { consignments, positions });
}

describe("map: what the card must always say", () => {
  it("shows the tile provider's credit, as links, at all times, even with nothing to draw", async () => {
    withMap([], []);
    renderApp("/");
    const credit = await screen.findByTestId("map-attribution");
    expect(credit).toBeVisible();
    expect(credit).toHaveTextContent("OpenStreetMap contributors");
    expect(credit).toHaveTextContent("CARTO");
    expect(within(credit).getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
    expect(within(credit).getByRole("link", { name: "CARTO" })).toHaveAttribute("href", "https://carto.com/attributions");
  });

  it("flags sample positions as sample whenever any shown position is sample, even beside real ones", async () => {
    withMap([consignment({ id: A }), consignment({ id: B })], [positionItem(A, { isSample: true }), positionItem(B, { isSample: false })]);
    renderApp("/");
    const card = await mapCard();
    expect(within(card).getByText("Sample positions")).toBeInTheDocument();
    expect(within(card).queryByText("Live AIS")).not.toBeInTheDocument();
  });

  it("says Live AIS for real, recent positions, and never for sample data", async () => {
    withMap([consignment({ id: A })], [positionItem(A)]);
    renderApp("/");
    const card = await mapCard();
    expect(within(card).getByText("Live AIS")).toBeInTheDocument();
    expect(within(card).queryByText("Sample positions")).not.toBeInTheDocument();
  });

  it("never calls stale data live: all-stale positions are 'Last known positions'", async () => {
    withMap([consignment({ id: A }), consignment({ id: B })], [positionItem(A, { freshness: "stale", ageSeconds: 3 * 3600 }), positionItem(B, { freshness: "stale", ageSeconds: 9 * 3600 })]);
    renderApp("/");
    const card = await mapCard();
    expect(within(card).getByText("Last known positions")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/live/i);
  });

  it("says Live AIS as soon as one shown position is recent, even beside stale ones", async () => {
    withMap([consignment({ id: A }), consignment({ id: B })], [positionItem(A), positionItem(B, { freshness: "stale" })]);
    renderApp("/");
    expect(within(await mapCard()).getByText("Live AIS")).toBeInTheDocument();
  });

  it("flags nothing as live when no consignment has a position", async () => {
    withMap([consignment({ id: A }), consignment({ id: B })], [noPosition(A, "no_vessel_identifier"), noPosition(B, "no_position_received")]);
    renderApp("/");
    const card = await mapCard();
    expect(within(card).getByText("No vessel positions")).toBeInTheDocument();
    expect(card.textContent).not.toMatch(/live|sample positions/i);
  });

  it("keeps the credit and the flag while the other theme is showing", async () => {
    withMap([consignment({ id: A })], [positionItem(A, { isSample: true })]);
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
    withMap();
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
    withMap();
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
    withMap();
    renderApp("/");
    await screen.findByTestId("map-attribution");
    await waitFor(() => expect(tileRequests.length).toBeGreaterThan(0));
    expect(tileRequests[0]!.url).toBe(TILE_URL_DARK);
  });

  it("gives the tile layer its subdomains, credit and a blank picture for missing tiles", async () => {
    tileRequests.length = 0;
    withMap();
    renderApp("/");
    await waitFor(() => expect(tileRequests).toHaveLength(1));
    const options = tileRequests[0]!.options;
    expect(options.subdomains).toBe(TILE_SUBDOMAINS);
    expect(options.attribution).toBe(ATTRIBUTION_HTML);
    expect(String(options.errorTileUrl)).toMatch(/^data:image\/gif/);
  });

  it("tileUrl picks by theme, and the zoom limits keep it a regional view", () => {
    expect(tileUrl(true)).toBe(TILE_URL_DARK);
    expect(tileUrl(false)).toBe(TILE_URL_LIGHT);
    expect(MAP_MIN_ZOOM).toBe(2);
    expect(MAP_MAX_ZOOM).toBeLessThanOrEqual(10);
  });
});

describe("map: markers follow freshness", () => {
  it("draws a normal marker for a recent position, a hollow dashed one for a stale position, and none for an unavailable one", async () => {
    withMap(
      [consignment({ id: A }), consignment({ id: B }), consignment({ id: C }), consignment({ id: D })],
      [positionItem(A), positionItem(B, { freshness: "stale", lat: 40 }), noPosition(C, "no_vessel_identifier"), noPosition(D, "no_position_received")],
    );
    renderApp("/");
    const card = await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(2));
    expect(map().querySelectorAll(".vdot.stale")).toHaveLength(1);
    expect(map().querySelectorAll(".vdot:not(.stale)")).toHaveLength(1);
    // The unavailable ones are still there as chips, so they can be asked about.
    for (const id of ["#CCCCCCCC", "#DDDDDDDD"]) expect(chip(card, id)).toBeInTheDocument();
  });

  it("has no marker at all when no consignment has a position", async () => {
    withMap([consignment({ id: A })], [noPosition(A, "no_vessel_identifier")]);
    renderApp("/");
    await mapCard();
    expect(markers()).toHaveLength(0);
    expect(map().querySelector("img.leaflet-marker-icon")).toBeNull();
  });

  it("colours a marker by its consignment: open issue, on track, or cleared", async () => {
    withMap(
      [
        consignment({ id: A, openIssueCount: 1 }),
        consignment({ id: B, checklistCompleteness: { verified: 2, total: 4 } }),
        consignment({ id: C, checklistCompleteness: { verified: 4, total: 4 } }),
      ],
      [positionItem(A, { lat: 10 }), positionItem(B, { lat: 20 }), positionItem(C, { lat: 30 })],
    );
    renderApp("/");
    await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(3));
    expect(map().querySelectorAll(".vdot.v-issue")).toHaveLength(1);
    expect(map().querySelectorAll(".vdot.v-ok")).toHaveLength(1);
    expect(map().querySelectorAll(".vdot.v-done")).toHaveLength(1);
  });

  it("leaves a finished consignment off the map and out of the chips", async () => {
    withMap([consignment({ id: A }), consignment({ id: B, status: "completed" })], [positionItem(A), positionItem(B)]);
    renderApp("/");
    const card = await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(1));
    expect(within(card).queryByRole("button", { name: "#BBBBBBBB" })).not.toBeInTheDocument();
  });

  it("uses no default Leaflet marker image and no Leaflet attribution control", async () => {
    withMap();
    renderApp("/");
    await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(1));
    expect(map().querySelector("img.leaflet-marker-icon")).toBeNull();
    expect(map().querySelector(".leaflet-control-zoom")).not.toBeNull();
    expect(map().querySelector(".leaflet-control-attribution")).toBeNull();
  });
});

describe("map: trails, and no planned route", () => {
  it("draws the trail a vessel has reported as a line, and nothing for a vessel with no trail", async () => {
    withMap(
      [consignment({ id: A }), consignment({ id: B })],
      [positionItem(A, { trail: trailOf([[10, 10], [11, 11], [12, 12]]) }), positionItem(B, { lat: 30, trail: [] })],
    );
    renderApp("/");
    await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(2));
    expect(map().querySelectorAll(".rt")).toHaveLength(1);
  });

  it("draws no line for a trail of one point, and no origin-to-destination arc for anything", async () => {
    withMap([consignment({ id: A, originCountry: "BR", destinationCountry: "GB" })], [positionItem(A, { trail: trailOf([[10, 10]]) })]);
    renderApp("/");
    await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(1));
    expect(map().querySelectorAll(".rt, path.leaflet-interactive")).toHaveLength(0);
  });

  it("colours a trail like its marker, and draws it thin", async () => {
    withMap([consignment({ id: A, openIssueCount: 1 })], [positionItem(A, { trail: trailOf([[10, 10], [11, 11]]) })]);
    renderApp("/");
    await mapCard();
    await waitFor(() => expect(map().querySelectorAll(".rt")).toHaveLength(1));
    const line = map().querySelector(".rt")!;
    expect(line).toHaveClass("rt-issue");
    expect(Number(line.getAttribute("stroke-width"))).toBeLessThanOrEqual(3);
  });

  it("emphasises the chosen consignment's trail and dims the others", async () => {
    // A has an open issue (red trail) and B is on track (green trail), so which one is thick can be told.
    withMap(
      [consignment({ id: A, openIssueCount: 1 }), consignment({ id: B })],
      [positionItem(A, { trail: trailOf([[10, 10], [11, 11]]) }), positionItem(B, { lat: 30, trail: trailOf([[30, 30], [31, 31]]) })],
    );
    renderApp("/");
    const card = await mapCard();
    await waitFor(() => expect(map().querySelectorAll(".rt")).toHaveLength(2));
    const width = (cls: string) => map().querySelector(`.${cls}`)!.getAttribute("stroke-width");
    // A is first, so it starts selected.
    expect([width("rt-issue"), width("rt-ok")]).toEqual(["3", "1.5"]);
    await userEvent.click(chip(card, "#BBBBBBBB"));
    expect([width("rt-issue"), width("rt-ok")]).toEqual(["1.5", "3"]);
  });

  it("selects a consignment when its marker on the map is clicked", async () => {
    withMap([consignment({ id: A, commodity: "First Cargo" }), consignment({ id: B, commodity: "Second Cargo" })], [positionItem(A), positionItem(B, { lat: 30, lng: 30 })]);
    renderApp("/");
    const card = await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(2));
    expect(chip(card, "#AAAAAAAA")).toHaveAttribute("aria-pressed", "true");
    const second = [...map().querySelectorAll<HTMLElement>(".leaflet-marker-icon")].find((m) => m.getAttribute("title") === "#BBBBBBBB")!;
    fireEvent.click(second);
    await waitFor(() => expect(chip(card, "#BBBBBBBB")).toHaveAttribute("aria-pressed", "true"));
    expect(card).toHaveTextContent("Second Cargo");
  });
});

describe("map: the info line", () => {
  it("shows the last position's age, speed and heading for a recent position", async () => {
    withMap([consignment({ id: A, commodity: "Frozen beef", originCountry: "BR", destinationCountry: "GB" })], [positionItem(A, { speedKnots: 12.54, headingDeg: 87.6, positionTime: new Date(Date.now() - 12 * 60_000).toISOString() })]);
    renderApp("/");
    const card = await mapCard();
    expect(card).toHaveTextContent("#AAAAAAAA · Frozen beef");
    expect(card).toHaveTextContent("Brazil to United Kingdom");
    expect(card).toHaveTextContent("Last position 12 minutes ago · 12.5 kn · heading 88°");
    expect(within(card).getByRole("link", { name: /open roadmap/i })).toHaveAttribute("href", `/consignments/${A}`);
  });

  it("calls a stale position the last known one, and never words it as current", async () => {
    withMap([consignment({ id: A })], [positionItem(A, { freshness: "stale", positionTime: new Date(Date.now() - 5 * HOURS).toISOString() })]);
    renderApp("/");
    const card = await mapCard();
    expect(card).toHaveTextContent("Last known position 5 hours ago");
    expect(card).not.toHaveTextContent(/Last position/);
  });

  it("says a sample position is a sample", async () => {
    withMap([consignment({ id: A })], [positionItem(A, { isSample: true })]);
    renderApp("/");
    expect(await mapCard()).toHaveTextContent(/\(sample\)/);
  });

  it("leaves out the speed and the heading when they are not known", async () => {
    withMap([consignment({ id: A })], [positionItem(A, { speedKnots: null, headingDeg: null })]);
    renderApp("/");
    const card = await mapCard();
    expect(card).toHaveTextContent("Last position 10 minutes ago");
    expect(card.textContent).not.toMatch(/ kn|heading/);
  });

  it("says why there is no dot for a consignment with no vessel, and for one with no position yet", async () => {
    withMap([consignment({ id: A }), consignment({ id: B })], [noPosition(A, "no_vessel_identifier"), noPosition(B, "no_position_received")]);
    renderApp("/");
    const card = await mapCard();
    // The first consignment is selected by default (none has a position).
    expect(card).toHaveTextContent("No vessel identifier on this consignment");
    await userEvent.click(chip(card, "#BBBBBBBB"));
    expect(card).toHaveTextContent("No position received yet");
    expect(card).not.toHaveTextContent("No vessel identifier on this consignment");
  });

  it("starts on the first consignment that has a position, and switches when another chip is chosen", async () => {
    withMap(
      [consignment({ id: A, commodity: "No Position Cargo" }), consignment({ id: B, commodity: "Has Position Cargo" }), consignment({ id: C, commodity: "Third Cargo" })],
      [noPosition(A, "no_vessel_identifier"), positionItem(B), positionItem(C, { lat: 30 })],
    );
    renderApp("/");
    const card = await mapCard();
    expect(chip(card, "#BBBBBBBB")).toHaveAttribute("aria-pressed", "true");
    expect(card).toHaveTextContent("Has Position Cargo");
    await userEvent.click(chip(card, "#CCCCCCCC"));
    expect(chip(card, "#CCCCCCCC")).toHaveAttribute("aria-pressed", "true");
    expect(chip(card, "#BBBBBBBB")).toHaveAttribute("aria-pressed", "false");
    expect(card).toHaveTextContent("Third Cargo");
  });

  it("says there is nothing to show when there are no active consignments", async () => {
    withMap([], []);
    renderApp("/");
    expect(await screen.findByText("There are no active consignments to show on the map.")).toBeInTheDocument();
  });

  it("explains each marker in a legend, including the hollow one", async () => {
    withMap();
    renderApp("/");
    const card = await mapCard();
    for (const text of ["Open issue", "On track", "Cleared", "No recent position"]) expect(within(card).getByText(text)).toBeInTheDocument();
  });
});

describe("map: where the data comes from", () => {
  it("reads only our own API: every request is to /api, and none goes to a provider", async () => {
    const api = withMap([consignment({ id: A })], [positionItem(A)]);
    renderApp("/");
    await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(1));
    expect(api.callsTo("GET /positions")).toHaveLength(1);
    expect(api.unmocked).toEqual([]);
    expect(document.documentElement.innerHTML).not.toMatch(/vesselapi|VESSELAPI|api\.vesselapi/i);
  });

  it("re-reads positions every minute, but only while the tab is showing", async () => {
    withMap();
    const { client } = renderApp("/");
    await mapCard();
    const query = client.getQueryCache().find({ queryKey: ["positions"] })!;
    const options = query.observers[0]!.options;
    expect(options.refetchInterval).toBe(60_000);
    expect(POSITIONS_REFETCH_MS).toBe(60_000);
    expect(options.refetchIntervalInBackground).toBe(false);
  });

  it("moves a marker when a refresh brings a new position, without rebuilding the map", async () => {
    tileRequests.length = 0;
    let lat = 10;
    const consignments = [consignment({ id: A })];
    dashboardApi(importerAdmin, { consignments }, { "GET /positions": () => ({ positions: [positionItem(A, { lat })] }) });
    const { client } = renderApp("/");
    await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(1));
    const before = markers()[0]!.closest(".leaflet-marker-icon")!.getAttribute("style");
    const tilesBefore = tileRequests.length;

    lat = 45;
    await client.refetchQueries({ queryKey: ["positions"] });
    await waitFor(() => expect(markers()[0]!.closest(".leaflet-marker-icon")!.getAttribute("style")).not.toBe(before));
    expect(markers()).toHaveLength(1);
    expect(tileRequests.length).toBe(tilesBefore); // the same map, redrawn: not a new one
  });

  it("shows a marker that appears on a refresh for a vessel that had none, and one that goes back to none", async () => {
    let item = noPosition(A, "no_position_received");
    dashboardApi(importerAdmin, { consignments: [consignment({ id: A })] }, { "GET /positions": () => ({ positions: [item] }) });
    const { client } = renderApp("/");
    const card = await mapCard();
    expect(markers()).toHaveLength(0);
    expect(card).toHaveTextContent("No position received yet");

    item = positionItem(A);
    await client.refetchQueries({ queryKey: ["positions"] });
    await waitFor(() => expect(markers()).toHaveLength(1));
    expect(card).toHaveTextContent("Last position");

    item = noPosition(A, "no_vessel_identifier");
    await client.refetchQueries({ queryKey: ["positions"] });
    await waitFor(() => expect(markers()).toHaveLength(0));
    expect(card).toHaveTextContent("No vessel identifier on this consignment");
  });

  it("shows a loading state for the map while positions are on their way, and the rest of the page carries on", async () => {
    dashboardApi(importerAdmin, { consignments: [consignment({ id: A, commodity: "Still Listed" })] }, { "GET /positions": () => new Promise(() => {}) });
    renderApp("/");
    expect(await screen.findByText("Loading map")).toBeInTheDocument();
    expect(await screen.findByText(/Still Listed/)).toBeInTheDocument();
  });

  it("shows an error with a retry when positions cannot be read, and the retry works", async () => {
    let attempts = 0;
    dashboardApi(importerAdmin, { consignments: [consignment({ id: A })] }, { "GET /positions": () => (++attempts === 1 ? respond(500, { error: "boom" }) : { positions: [positionItem(A)] }) });
    renderApp("/");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
    await userEvent.click(within(alert.parentElement!).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(markers()).toHaveLength(1));
  });
});

describe("the sample fixture", () => {
  it("still renders through the same map, flagged as sample, with a hollow marker and no marker for the unavailable one", async () => {
    render(
      <MemoryRouter>
        <ConsignmentMap vessels={SAMPLE_VESSELS} />
      </MemoryRouter>,
    );
    const card = await mapCard();
    await waitFor(() => expect(markers()).toHaveLength(4));
    expect(within(card).getByText("Sample positions")).toBeInTheDocument();
    expect(map().querySelectorAll(".vdot.stale")).toHaveLength(1);
    expect(within(within(card).getByRole("group", { name: "Choose a consignment" })).getAllByRole("button")).toHaveLength(SAMPLE_VESSELS.length);
    await userEvent.click(chip(card, "Sample E"));
    expect(card).toHaveTextContent("No vessel identifier on this consignment");
  });
});

describe("geo helpers", () => {
  const dublin: [number, number] = [53.3, -6.3];
  const santos: [number, number] = [-24.0, -46.3];

  it("greatCircle starts and ends exactly on its endpoints and has the requested number of steps", () => {
    const points = greatCircle(santos, dublin, 10);
    expect(points).toHaveLength(11);
    expect(points[0]![0]).toBeCloseTo(santos[0], 6);
    expect(points[10]![1]).toBeCloseTo(dublin[1], 6);
  });

  it("greatCircle stays on the shortest path, and copes with identical endpoints", () => {
    const total = distance(santos, dublin);
    for (const p of greatCircle(santos, dublin, 10)) expect(distance(santos, p) + distance(p, dublin)).toBeCloseTo(total, 6);
    expect(greatCircle(dublin, dublin, 5)).toEqual([dublin, dublin]);
  });

  it("routeThrough joins legs without repeating the shared waypoint, and pointAlong finds the ends, clamps, and finds the middle by distance", () => {
    expect(routeThrough([santos, [0, -30], dublin], 4)).toHaveLength(9);
    const path: Array<[number, number]> = [[0, 0], [0, 10], [0, 30]];
    expect(pointAlong(path, 0)).toEqual([0, 0]);
    expect(pointAlong(path, 1)).toEqual([0, 30]);
    expect(pointAlong(path, -5)).toEqual([0, 0]);
    expect(pointAlong(path, 5)).toEqual([0, 30]);
    expect(pointAlong(path, 0.5)[1]).toBeCloseTo(15, 0);
  });
});
