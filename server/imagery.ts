// ─── Image-selection rules (pure functions, no network) ─────────────────────
// Sentinel-2 Level-2A images are used only when the FIELD itself (the drawn polygon, not the
// 100 x 100 km satellite tile) is at most MAX_FIELD_CLOUD_PCT cloudy. "Cloudy" means any field pixel
// that is cloud (SCL 8, 9), thin cirrus (SCL 10), cloud shadow (SCL 3) or has no valid data
// (SCL 0/1 or outside the satellite swath). The date range is split into 14-day windows; each
// window gets its clearest qualifying image. A window with no qualifying image borrows the
// nearest qualifying image taken up to FALLBACK_DAYS before or after it, as long as no other
// window already uses that image. Otherwise the window is left as a gap — nothing is estimated.

export const MAX_FIELD_CLOUD_PCT = 20;
export const FALLBACK_DAYS = 7;
export const WINDOW_DAYS = 14;

// Scene Classification Layer classes treated as cloud for both the 20% rule and pixel masking.
export const SCL_CLOUD_CLASSES = [3, 8, 9, 10];
export const SCL_WATER_CLASS = 6;

export type LatLng = { lat: number; lng: number };
export type Window = { from: string; to: string; mid: string };

// One cloud-assessed acquisition date over the field.
export type DailyObservation = {
  date: string;             // YYYY-MM-DD acquisition date
  cloudPct: number;         // % of field pixels that are cloud / cirrus / shadow / no data
  waterPct: number;         // % of field pixels classed as water
  ndvi: number | null;      // mean over clear land pixels only
  msi: number | null;       // mean over clear land pixels only
  // Optional split of cloudPct, for explaining rejected images (% of field pixels).
  breakdown?: { opaque: number; cirrus: number; shadow: number; noData: number };
};

export type SelectedObservation = {
  window: Window;
  obs: DailyObservation | null;   // null = gap (no qualifying image)
  fallback: boolean;              // true when the image was taken outside the window
};

const DAY_MS = 24 * 60 * 60 * 1000;
const toTime = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => new Date(toTime(d) + n * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((toTime(b) - toTime(a)) / DAY_MS);

export function biweeklyWindows(dateFrom: string, dateTo: string): Window[] {
  const windows: Window[] = [];
  let from = dateFrom;
  while (toTime(from) <= toTime(dateTo)) {
    let to = addDays(from, WINDOW_DAYS - 1);
    if (toTime(to) > toTime(dateTo)) to = dateTo;
    let mid = addDays(from, Math.floor(WINDOW_DAYS / 2));
    if (toTime(mid) > toTime(dateTo)) mid = dateTo;
    windows.push({ from, to, mid });
    from = addDays(to, 1);
  }
  return windows;
}

export function qualifies(o: DailyObservation, maxCloud = MAX_FIELD_CLOUD_PCT): boolean {
  return o.cloudPct <= maxCloud && o.ndvi !== null;
}

// Days a date lies outside a window (0 when inside).
function distanceOutside(date: string, w: Window): number {
  if (toTime(date) < toTime(w.from)) return daysBetween(date, w.from);
  if (toTime(date) > toTime(w.to)) return daysBetween(w.to, date);
  return 0;
}

export function selectImagesForWindows(
  windows: Window[],
  observations: DailyObservation[],
  maxCloud = MAX_FIELD_CLOUD_PCT,
  fallbackDays = FALLBACK_DAYS,
): SelectedObservation[] {
  const good = observations.filter(o => qualifies(o, maxCloud));
  const used = new Set<string>();
  const picks: SelectedObservation[] = windows.map(window => ({ window, obs: null, fallback: false }));

  // Pass 1: the clearest qualifying image inside each window (ties → closest to the window's middle).
  for (const p of picks) {
    const inside = good.filter(o => distanceOutside(o.date, p.window) === 0);
    inside.sort((a, b) =>
      a.cloudPct - b.cloudPct ||
      Math.abs(daysBetween(p.window.mid, a.date)) - Math.abs(daysBetween(p.window.mid, b.date)));
    if (inside.length) { p.obs = inside[0]; used.add(inside[0].date); }
  }

  // Pass 2: windows still empty borrow the nearest unused qualifying image within fallbackDays.
  for (const p of picks) {
    if (p.obs) continue;
    const near = good.filter(o => {
      const d = distanceOutside(o.date, p.window);
      return d > 0 && d <= fallbackDays && !used.has(o.date);
    });
    near.sort((a, b) =>
      distanceOutside(a.date, p.window) - distanceOutside(b.date, p.window) || a.cloudPct - b.cloudPct);
    if (near.length) { p.obs = near[0]; p.fallback = true; used.add(near[0].date); }
  }
  return picks;
}

// ─── Geometry helpers ────────────────────────────────────────────────────────
export function fieldGeometry(coords: LatLng[]) {
  const ring = coords.map(c => [c.lng, c.lat]);
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx !== lx || fy !== ly) ring.push([fx, fy]);
  return { type: "Polygon", coordinates: [ring] };
}

export function bboxOf(coords: LatLng[], buffer = 0): [number, number, number, number] {
  const lats = coords.map(c => c.lat), lngs = coords.map(c => c.lng);
  return [Math.min(...lngs) - buffer, Math.min(...lats) - buffer, Math.max(...lngs) + buffer, Math.max(...lats) + buffer];
}

// Raster size for a bbox at a target ground resolution, clamped per dimension.
export function gridSize(bbox: number[], targetMeters: number, minDim: number, maxDim: number) {
  const midLat = (bbox[1] + bbox[3]) / 2;
  const wM = (bbox[2] - bbox[0]) * 111320 * Math.cos((midLat * Math.PI) / 180);
  const hM = (bbox[3] - bbox[1]) * 111320;
  const clamp = (v: number) => Math.max(minDim, Math.min(maxDim, Math.round(v / targetMeters)));
  return { width: clamp(wM), height: clamp(hM) };
}

// Ray-casting point-in-polygon test.
export function pointInPolygon(lat: number, lng: number, coords: LatLng[]): boolean {
  let inside = false;
  for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
    const xi = coords[i].lng, yi = coords[i].lat, xj = coords[j].lng, yj = coords[j].lat;
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Number of raster cells (of a width x height grid over the field's bounding box) whose centre lies
// inside the field polygon. The satellite service reports pixels outside the polygon as "no data",
// so this is the reference count for working out how much of the FIELD itself is really missing.
export function fieldPixelCount(coords: LatLng[], bbox: number[], width: number, height: number): number {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const dx = (maxLng - minLng) / width, dy = (maxLat - minLat) / height;
  let n = 0;
  for (let r = 0; r < height; r++) {
    const lat = maxLat - (r + 0.5) * dy;
    for (let c = 0; c < width; c++) if (pointInPolygon(lat, minLng + (c + 0.5) * dx, coords)) n++;
  }
  return n;
}
