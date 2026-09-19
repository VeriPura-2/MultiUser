/** Small geography helpers for drawing sample routes. Pure, so they are easy to test. */

export type LatLng = [lat: number, lng: number];

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (radians: number) => (radians * 180) / Math.PI;

function toVector([lat, lng]: LatLng): [number, number, number] {
  const la = rad(lat);
  const lo = rad(lng);
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

function toLatLng([x, y, z]: [number, number, number]): LatLng {
  return [deg(Math.atan2(z, Math.hypot(x, y))), deg(Math.atan2(y, x))];
}

/** `steps + 1` points along the great circle from a to b, both ends included. */
export function greatCircle(a: LatLng, b: LatLng, steps: number): LatLng[] {
  const va = toVector(a);
  const vb = toVector(b);
  const dot = Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const angle = Math.acos(dot);
  if (angle < 1e-9) return [a, b];
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

/** A route through the given waypoints, each leg drawn as a great circle. */
export function routeThrough(waypoints: LatLng[], stepsPerLeg = 12): LatLng[] {
  const path: LatLng[] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const leg = greatCircle(waypoints[i]!, waypoints[i + 1]!, stepsPerLeg);
    path.push(...(i === 0 ? leg : leg.slice(1)));
  }
  return path;
}

/** The point `fraction` (0 to 1) of the way along a path, by distance between its points. */
export function pointAlong(path: LatLng[], fraction: number): LatLng {
  if (path.length === 0) throw new Error("pointAlong needs a path");
  const f = Math.min(1, Math.max(0, fraction));
  if (f === 0) return path[0]!;
  if (f === 1) return path[path.length - 1]!;
  const lengths: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = distance(path[i]!, path[i + 1]!);
    lengths.push(d);
    total += d;
  }
  let remaining = f * total;
  for (let i = 0; i < lengths.length; i++) {
    const d = lengths[i]!;
    if (remaining <= d || i === lengths.length - 1) {
      const t = d === 0 ? 0 : Math.min(1, remaining / d);
      const [a, b] = [path[i]!, path[i + 1]!];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    remaining -= d;
  }
  return path[path.length - 1]!;
}

/** Angular distance in radians. Enough to compare positions along a route. */
export function distance(a: LatLng, b: LatLng): number {
  const va = toVector(a);
  const vb = toVector(b);
  return Math.acos(Math.min(1, Math.max(-1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])));
}
