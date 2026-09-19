/** Great-circle helpers for the sample provider. Pure. (Same maths as web/src/map/geo.ts.) */

export type LatLng = [lat: number, lng: number];

const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function toVector([lat, lng]: LatLng): [number, number, number] {
  const la = rad(lat);
  const lo = rad(lng);
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

function toLatLng([x, y, z]: [number, number, number]): LatLng {
  return [deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))];
}

/** Angular distance in radians. */
export function distance(a: LatLng, b: LatLng): number {
  const va = toVector(a);
  const vb = toVector(b);
  return Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
}

/** `steps + 1` points along the great circle from a to b, both ends included. */
export function greatCircle(a: LatLng, b: LatLng, steps: number): LatLng[] {
  const angle = distance(a, b);
  if (angle < 1e-9) return [a, b];
  const va = toVector(a);
  const vb = toVector(b);
  const sin = Math.sin(angle);
  const points: LatLng[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const wa = Math.sin((1 - t) * angle) / sin;
    const wb = Math.sin(t * angle) / sin;
    points.push(toLatLng([wa * va[0] + wb * vb[0], wa * va[1] + wb * vb[1], wa * va[2] + wb * vb[2]]));
  }
  return points;
}

/** A route through the given waypoints, each leg a great circle. */
export function routeThrough(waypoints: LatLng[], stepsPerLeg = 12): LatLng[] {
  const path: LatLng[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = greatCircle(waypoints[i]!, waypoints[i + 1]!, stepsPerLeg);
    path.push(...(i === 0 ? leg : leg.slice(1)));
  }
  return path;
}

/** The point `fraction` (0 to 1) of the way along a path by distance, and the compass bearing of travel there. */
export function pointAndBearingAlong(path: LatLng[], fraction: number): { point: LatLng; bearing: number } {
  const f = Math.min(1, Math.max(0, fraction));
  const lengths = path.slice(1).map((p, i) => distance(path[i]!, p));
  const total = lengths.reduce((a, b) => a + b, 0);
  let remaining = f * total;
  let i = 0;
  while (i < lengths.length - 1 && remaining > lengths[i]!) {
    remaining -= lengths[i]!;
    i++;
  }
  const [a, b] = [path[i]!, path[i + 1]!];
  const t = lengths[i] === 0 ? 0 : Math.min(1, remaining / lengths[i]!);
  return { point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], bearing: bearing(a, b) };
}

/** Initial compass bearing from a to b, 0 to 359.9 degrees. */
export function bearing(a: LatLng, b: LatLng): number {
  const [la1, la2, dLon] = [rad(a[0]), rad(b[0]), rad(b[1] - a[1])];
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}
