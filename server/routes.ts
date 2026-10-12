import type { Express } from "express";
import { Server } from "http";
import zlib from "zlib";
import { randomUUID } from "crypto";
import { storage } from "./storage";
import { insertFieldSchema } from "@shared/schema";
import { generateFieldReport } from "./report";
import { sendWhatsAppNotification, buildWhatsAppMessage } from "./whatsapp";
import {
  MAX_FIELD_CLOUD_PCT, FALLBACK_DAYS, SCL_CLOUD_CLASSES, SCL_WATER_CLASS,
  biweeklyWindows, selectImagesForWindows, fieldGeometry, bboxOf, gridSize, addDays, fieldPixelCount,
  type DailyObservation, type LatLng,
} from "./imagery";
// ─── Auth middleware (inline to avoid esbuild hoisting issues) ─────────────
import type { Request, Response, NextFunction } from "express";
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if ((req as any).session?.userId) return next();
  res.status(401).json({ error: "Unauthorized" });
}
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const userId = (req as any).session?.userId;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const user = storage.getUserById(userId);
  if (!user || user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}


// ─── SentinelHub Integration ───────────────────────────────────────────────
// Copernicus OAuth2 credentials
const COPERNICUS_USER_ID = process.env.COPERNICUS_USER_ID || "sh-cd0256f9-1e8d-4ba4-9cc6-b7d068c13401";
const COPERNICUS_ACCOUNT_ID = process.env.COPERNICUS_ACCOUNT_ID || ""; // must be set via env var in deployment — this is an OAuth2 client secret, never hardcode it
// Copernicus Data Space Sentinel Hub endpoints (sh- prefix credentials use cdse.eu, not sentinel-hub.com)
const SENTINEL_API = "https://sh.dataspace.copernicus.eu/api/v1/process";
const SENTINEL_STATS_API = "https://sh.dataspace.copernicus.eu/api/v1/statistics";
const SENTINEL_TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";

// Static token fallback (legacy env var)
const STATIC_TOKEN = process.env.SENTINEL_HUB_TOKEN || "";

// OAuth2 token cache
let _cachedToken: string | null = null;
let _tokenExpiry = 0;

async function getSentinelToken(): Promise<string> {
  // Use static token if explicitly provided
  if (STATIC_TOKEN) return STATIC_TOKEN;
  // Use cached token if still valid (with 60s buffer)
  if (_cachedToken && Date.now() < _tokenExpiry - 60000) return _cachedToken;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8s hard timeout
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: COPERNICUS_USER_ID,
      client_secret: COPERNICUS_ACCOUNT_ID,
    });
    const res = await fetch(SENTINEL_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const errText = await res.text();
      console.warn("OAuth2 token error:", res.status, errText);
      // Credentials not configured or rejected — caller reports the failure (no simulated fallback)
      return "";
    }
    const json = await res.json();
    _cachedToken = json.access_token || "";
    _tokenExpiry = Date.now() + (json.expires_in || 600) * 1000;
    return _cachedToken || "";
  } catch (err) {
    console.warn("OAuth2 token fetch failed:", err);
    return "";
  }
}

/**
 * Classify a pixel based on MSI (Moisture Stress Index = SWIR/NIR, B11/B8A).
 * MSI < 0.4   → High moisture / no stress
 * MSI 0.4–0.6 → Adequate moisture
 * MSI 0.6–1.0 → Mild water stress
 * MSI 1.0–1.2 → Moderate drought stress
 * MSI > 1.2   → Severe drought stress
 * (MSI increases with stress — opposite of NDWI/MNDWI)
 */
function classifyMsi(msi: number): { label: string; isWater: boolean } {
  // Very low MSI can indicate open water (no reflected SWIR)
  if (msi < 0.1) return { label: "Open water (excluded)", isWater: true };
  if (msi < 0.4) return { label: "High moisture", isWater: false };
  if (msi < 0.6) return { label: "Adequate moisture", isWater: false };
  if (msi < 1.0) return { label: "Mild water stress", isWater: false };
  if (msi < 1.2) return { label: "Moderate drought stress", isWater: false };
  return { label: "Severe drought stress", isWater: false };
}
// Keep alias for downstream compatibility
function classifyNdwi(val: number): { label: string; isWater: boolean } {
  return classifyMsi(val);
}

function classifyNdvi(ndvi: number) {
  if (ndvi >= 0.6) return "Excellent";
  if (ndvi >= 0.4) return "Good";
  if (ndvi >= 0.25) return "Moderate";
  if (ndvi >= 0.1) return "Poor";
  return "Critical";
}
void classifyNdvi;

// ─── Daily field observations (Statistics API, field polygon) ──────────────
// One request returns, for every Sentinel-2 L2A acquisition date in the range, how cloudy the FIELD
// is and the mean NDVI / MSI over its clear land pixels. Pixels outside the field polygon are
// ignored by the API. Means are computed as mean(value×clear) / mean(clear) so cloudy, shadowed,
// water and no-data pixels never enter the average, while every field pixel counts toward the
// cloud percentage.
const SCL_CLOUD_JS = JSON.stringify(SCL_CLOUD_CLASSES);
const DAILY_EVALSCRIPT = [
  "//VERSION=3",
  "function setup() {",
  "  return {",
  "    input: [{ bands: ['B04','B08','B8A','B11','SCL','dataMask'] }],",
  "    output: [",
  "      { id: 'ndvi',  bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'msi',   bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'clear', bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'cloud', bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'water', bands: 1, sampleType: 'FLOAT32' },",
  // Breakdown of the cloud total, used only to explain rejected images.
  "      { id: 'opaque', bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'cirrus', bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'shadow', bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'nodata', bands: 1, sampleType: 'FLOAT32' },",
  "      { id: 'dataMask', bands: 1 }",
  "    ],",
  "    mosaicking: 'SIMPLE'",
  "  };",
  "}",
  "function evaluatePixel(s) {",
  "  var noData = s.dataMask === 0 || s.SCL === 0 || s.SCL === 1;",
  `  var cloud = noData || ${SCL_CLOUD_JS}.indexOf(s.SCL) >= 0;`,
  `  var water = !cloud && s.SCL === ${SCL_WATER_CLASS};`,
  "  var d1 = s.B08 + s.B04;",
  "  var clear = (!cloud && !water && d1 >= 0.01 && s.B8A >= 0.01) ? 1 : 0;",
  "  var ndvi = clear ? (s.B08 - s.B04) / d1 : 0;",
  "  var msi = clear ? s.B11 / s.B8A : 0;",
  // dataMask output = the input dataMask: 0 for pixels OUTSIDE the field polygon (and for genuinely
  // missing pixels), so they are left out of the statistics. Missing pixels inside the field are
  // then counted by comparing the valid-pixel count with the field's own pixel count.
  "  var opaque = !noData && (s.SCL === 8 || s.SCL === 9) ? 1 : 0;",
  "  var cirrus = !noData && s.SCL === 10 ? 1 : 0;",
  "  var shadow = !noData && s.SCL === 3 ? 1 : 0;",
  "  return { ndvi: [ndvi * clear], msi: [msi * clear], clear: [clear], cloud: [cloud ? 1 : 0], water: [water ? 1 : 0],",
  "           opaque: [opaque], cirrus: [cirrus], shadow: [shadow], nodata: [noData ? 1 : 0], dataMask: [s.dataMask] };",
  "}"
].join("\n");

const STATS_CHUNK_DAYS = 60;

class SatelliteServiceError extends Error {}

async function fetchDailyChunk(token: string, geometry: object, bbox: number[], grid: { width: number; height: number; fieldPixels: number }, from: string, to: string): Promise<DailyObservation[]> {
  const { width, height, fieldPixels } = grid;
  const body = {
    input: {
      bounds: { geometry, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
      data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` } } }]
    },
    aggregation: {
      timeRange: { from: `${from}T00:00:00Z`, to: `${to}T23:59:59Z` },
      aggregationInterval: { of: "P1D" },
      width, height,
      evalscript: DAILY_EVALSCRIPT
    },
    calculations: { default: {} }
  };

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      const res = await fetch(SENTINEL_STATS_API, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!res.ok) { lastErr = `${res.status} ${(await res.text()).slice(0, 300)}`; continue; }
      const json = await res.json();
      const out: DailyObservation[] = [];
      const intervals: any[] = json?.data || [];
      // Days the service could not process come back with an `error` instead of outputs.
      // Never drop them silently: if every day failed, report the service's own message.
      const failed = intervals.filter(iv => iv?.error);
      if (failed.length) {
        console.warn(`Statistics API: ${failed.length}/${intervals.length} days returned errors (${from}..${to}):`, JSON.stringify(failed[0].error).slice(0, 300));
        if (failed.length === intervals.length) {
          throw new SatelliteServiceError(`The satellite service could not process this field (${failed.length} days failed). Service message: ${String(failed[0].error?.message || JSON.stringify(failed[0].error)).slice(0, 250)}`);
        }
      }
      for (const iv of intervals) {
        const st = (id: string) => iv?.outputs?.[id]?.bands?.B0?.stats;
        const cloud = st("cloud"), clear = st("clear"), water = st("water");
        if (!cloud || !(cloud.sampleCount > 0)) continue;
        // Share of the field that actually has data on this date (pixels outside the polygon are
        // excluded by the service and are NOT missing data).
        const validPixels = Math.max(0, cloud.sampleCount - (cloud.noDataCount ?? 0));
        const validFrac = fieldPixels > 0 ? Math.min(1, validPixels / fieldPixels) : (validPixels > 0 ? 1 : 0);
        const missingFrac = 1 - validFrac;
        // Statistic means are over valid pixels; convert each to a share of the whole field.
        const frac = (x: any) => (validFrac > 0 && typeof x?.mean === "number" && isFinite(x.mean) ? x.mean * validFrac : 0);
        const pct = (f: number) => Math.round(f * 1000) / 10;
        const clearFrac = validFrac > 0 && typeof clear?.mean === "number" && isFinite(clear.mean) ? clear.mean : 0;
        const ndviSum = st("ndvi")?.mean, msiSum = st("msi")?.mean;
        const ndvi = clearFrac > 0 && typeof ndviSum === "number" ? ndviSum / clearFrac : null;
        const msi = clearFrac > 0 && typeof msiSum === "number" ? msiSum / clearFrac : null;
        out.push({
          date: String(iv.interval?.from || "").slice(0, 10),
          cloudPct: pct(Math.min(1, frac(cloud) + missingFrac)),
          waterPct: pct(frac(water)),
          ndvi: ndvi !== null && ndvi >= -1 && ndvi <= 1 ? Math.round(ndvi * 1000) / 1000 : null,
          msi: msi !== null && msi > 0 && msi < 10 ? Math.round(msi * 1000) / 1000 : null,
          breakdown: {
            opaque: pct(frac(st("opaque"))), cirrus: pct(frac(st("cirrus"))), shadow: pct(frac(st("shadow"))),
            noData: pct(Math.min(1, frac(st("nodata")) + missingFrac)),
          },
        });
      }
      return out;
    } catch (err) {
      if (err instanceof SatelliteServiceError) throw err;
      lastErr = String(err);
    }
  }
  throw new Error(`Satellite statistics request failed (${from} to ${to}): ${lastErr}`);
}

async function fetchDailyObservations(token: string, coords: LatLng[], from: string, to: string): Promise<DailyObservation[]> {
  const geometry = fieldGeometry(coords);
  const bbox = bboxOf(coords);
  const size = gridSize(bbox, 10, 32, 256);
  const grid = { ...size, fieldPixels: fieldPixelCount(coords, bbox, size.width, size.height) };
  const chunks: { from: string; to: string }[] = [];
  for (let f = from; f <= to; f = addDays(f, STATS_CHUNK_DAYS)) {
    const t = addDays(f, STATS_CHUNK_DAYS - 1);
    chunks.push({ from: f, to: t > to ? to : t });
  }
  const parts = await Promise.all(chunks.map(c => fetchDailyChunk(token, geometry, bbox, grid, c.from, c.to)));
  const byDate = new Map<string, DailyObservation>();
  for (const o of parts.flat()) if (o.date) byDate.set(o.date, o);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── OPTRAM soil-moisture calibration (per-pixel, Process API) ─────────────
// The Optical Trapezoid Model estimates a relative soil-wetness index W in [0,1] from the
// SWIR-Transformed-Reflectance (STR) vs NDVI feature space. W = 0 on the "dry edge" and W = 1 on
// the "wet edge" of the trapezoid. Edges are calibrated per analysis request (this site has no
// pre-fitted trapezoid parameters).
//
// Correct OPTRAM needs the actual STR-vs-NDVI *point cloud* — thousands of individual pixels — to
// locate the dry/wet edges. The Statistics API only returns per-date aggregates (one point per
// date, ~5 total), which cannot define a trapezoid. So soil-moisture is fetched from the Sentinel
// Hub *Process* API as raw per-pixel FLOAT32 rasters (NDVI, STR, mask). All valid pixels from all
// acquisition dates are pooled into one dataset, the dry/wet edges are fit on that pool, then a
// per-pixel W is computed and averaged per date.
const OPTRAM_NDVI_BINS = 35;          // pooled cloud has thousands of pts → finer binning is justified
const OPTRAM_MIN_BIN_PIXELS = 5;      // ignore sparse NDVI bins whose STR extremes are just noise
// Oversaturation ceiling: W is conceptually in [0,1]. We keep a small 5% margin (W <= 1.05) to
// tolerate edge-fit / sensor noise on genuinely-wet pixels, but discard anything above it as an
// oversaturated / non-physical value. Negative W (below the dry edge) is likewise discarded.
const OPTRAM_W_CEILING = 1.05;
// ── Outlier-robustness for the STR-vs-NDVI edge fit ──
// STR = (1-ρswir)²/(2ρswir) diverges as ρswir → 0, so pixels with tiny SWIR reflectance produce
// huge STR values that are sensor/atmospheric artifacts, not real wet soil. Two independent guards
// keep them out of the edge fit:
//   • SWIR reflectance floor (evalscript): ρswir must exceed OPTRAM_SWIR_FLOOR. At ρ = 0.05, STR ≈
//     9.0, so 0.05 is the lowest floor that even begins to bound STR; combined with the STR ceiling
//     below it removes near-saturated pixels while keeping genuine bright/dry soil (ρswir ≈ 0.15–0.35).
//   • Hard STR ceiling (pool filter): any pixel with STR > OPTRAM_STR_CEILING is dropped. OPTRAM
//     literature (Sadeghi et al. 2017) places real dry→wet soil/vegetation STR roughly in 0–3;
//     5 is a generous margin, so STR > 5 (ρswir ≲ 0.084) is treated as an artifact. This is the
//     binding guard that previously let the wet edge run away to ≈8–10.
const OPTRAM_SWIR_FLOOR = 0.05;
const OPTRAM_STR_CEILING = 5;
// Per-NDVI-bin edge candidates use robust percentiles instead of the raw min/max, which are
// maximally sensitive to a single bad pixel. The wet edge uses the 98th percentile of STR in each
// bin and the dry edge the 2nd percentile — capturing the true edges of the point cloud without
// chasing lone outliers.
const OPTRAM_WET_PCTL = 0.98;
const OPTRAM_DRY_PCTL = 0.02;
// Native SWIR (B11) resolution is 20 m. We request the raster at ~20 m/pixel but cap each
// dimension at OPTRAM_MAX_DIM so a large field can't produce a huge payload / slow request. At the
// cap the decompressed raster is ≤ 1024·1024·3·4 ≈ 12 MB and the request stays well within the
// 30 s fetch timeout on the free Render instance; fields large enough to hit the cap are simply
// sampled a little coarser than 20 m, which is fine for a field-mean soil-moisture estimate.
const OPTRAM_TARGET_METERS = 20;
const OPTRAM_MAX_DIM = 1024;

function linearFit(pts: { x: number; y: number }[]): { slope: number; intercept: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) return null; // all NDVI identical — can't fit a slope
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

type PixelSample = { ndvi: number; str: number };

// ─── Minimal FLOAT32 GeoTIFF decoder ──────────────────────────────────────
// Sentinel Hub's Process API returns a big-endian, Deflate-compressed, striped, chunky
// (interleaved) TIFF with FLOAT32 samples (verified against real output). This reads only the tags
// we need to pull the interleaved samples back out; it is not a general TIFF library.
function decodeFloat32Tiff(buf: Buffer): { width: number; height: number; samples: number; data: Float32Array } | null {
  if (buf.length < 8) return null;
  const bo = buf.toString("ascii", 0, 2);
  const le = bo === "II";
  if (!le && bo !== "MM") return null;
  const u16 = (o: number) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o: number) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));

  const ifd = u32(4);
  const nEntries = u16(ifd);
  const tags = new Map<number, { type: number; count: number; valueOff: number }>();
  for (let i = 0; i < nEntries; i++) {
    const e = ifd + 2 + i * 12;
    tags.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 });
  }
  // Short/long array reader (inline when total bytes <= 4, else the field holds an offset).
  const readNums = (tag: number): number[] => {
    const t = tags.get(tag);
    if (!t) return [];
    const size = t.type === 3 ? 2 : 4; // 3=SHORT, 4=LONG
    const total = size * t.count;
    const base = total <= 4 ? t.valueOff : u32(t.valueOff);
    const out: number[] = [];
    for (let k = 0; k < t.count; k++) out.push(size === 2 ? u16(base + k * 2) : u32(base + k * 4));
    return out;
  };

  const width = readNums(256)[0];
  const height = readNums(257)[0];
  const bits = readNums(258);
  const compression = readNums(259)[0] ?? 1;
  const spp = readNums(277)[0] ?? 1;
  const rowsPerStrip = readNums(278)[0] ?? height;
  const stripOffsets = readNums(273);
  const stripByteCounts = readNums(279);
  const sampleFormat = readNums(339);
  const planar = readNums(284)[0] ?? 1; // 1 = chunky/interleaved (Sentinel Hub uses this)

  if (!width || !height || !spp || !stripOffsets.length) return null;
  if (!bits.every(b => b === 32)) return null;                 // only FLOAT32 supported
  if (sampleFormat.length && !sampleFormat.every(s => s === 3)) return null; // 3 = IEEE float
  if (planar !== 1) return null;

  // Concatenate decompressed strips.
  const parts: Buffer[] = [];
  for (let s = 0; s < stripOffsets.length; s++) {
    const chunk = buf.subarray(stripOffsets[s], stripOffsets[s] + stripByteCounts[s]);
    if (compression === 8 || compression === 32946) parts.push(zlib.inflateSync(chunk)); // Deflate
    else if (compression === 1) parts.push(chunk);                                        // uncompressed
    else return null;                                                                     // unsupported
  }
  void rowsPerStrip;
  const raw = Buffer.concat(parts);
  const need = width * height * spp * 4;
  if (raw.length < need) return null;

  const rdFloat = (o: number) => (le ? raw.readFloatLE(o) : raw.readFloatBE(o));
  const data = new Float32Array(width * height * spp);
  for (let i = 0; i < data.length; i++) data[i] = rdFloat(i * 4);
  return { width, height, samples: spp, data };
}

// Fetch one per-pixel OPTRAM raster (NDVI, STR, validity mask) for a date window and return every
// valid (non-cloud, non-oversaturated) pixel as an (ndvi, str) pair.
async function fetchOptramRaster(
  token: string,
  coords: LatLng[],
  date: string
): Promise<PixelSample[]> {
  // Exactly the qualifying image's acquisition date, clipped to the field polygon.
  const bbox = bboxOf(coords);
  const { width, height } = gridSize(bbox, OPTRAM_TARGET_METERS, 1, OPTRAM_MAX_DIM);

  const evalscript = [
    "//VERSION=3",
    "function setup() {",
    "  return {",
    "    input: [{ bands: ['B04','B08','B11','SCL','dataMask'] }],",
    "    output: { bands: 3, sampleType: 'FLOAT32' },",
    "    mosaicking: 'SIMPLE'",
    "  };",
    "}",
    "function evaluatePixel(s) {",
    // Reuse the same SCL cloud/shadow/water mask as the rest of the pipeline (3,6,8,9,10).
    "  var scl = s.SCL;",
    `  var bad = (s.dataMask === 0 || scl === 0 || scl === 1 || ${SCL_CLOUD_JS}.indexOf(scl) >= 0 || scl === ${SCL_WATER_CLASS}) ? 1 : 0;`,
    "  var n = s.B08, r = s.B04, sw = s.B11;",
    "  var d = n + r;",
    "  var ndvi = d < 0.01 ? 0 : (n - r) / d;",
    // STR = (1 - ρswir)^2 / (2 ρswir); tightened oversaturation floor ρswir < 0.05 (5% reflectance).
    // Below this STR exceeds ~9 and is dominated by near-saturation artifacts (see OPTRAM_SWIR_FLOOR).
    `  var str = sw < ${OPTRAM_SWIR_FLOOR} ? 0 : ((1 - sw) * (1 - sw)) / (2 * sw);`,
    `  var mask = (bad === 1 || d < 0.01 || sw < ${OPTRAM_SWIR_FLOOR}) ? 0 : 1;`,
    "  return [ndvi, str, mask];",
    "}"
  ].join("\n");

  const body = {
    input: {
      bounds: { geometry: fieldGeometry(coords), properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` } }
      }]
    },
    output: { width, height, responses: [{ identifier: "default", format: { type: "image/tiff" } }] },
    evalscript
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(SENTINEL_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "image/tiff"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);
    if (!res.ok) {
      console.warn("OPTRAM raster error:", res.status, (await res.text()).slice(0, 300));
      return [];
    }
    const tiff = decodeFloat32Tiff(Buffer.from(await res.arrayBuffer()));
    if (!tiff || tiff.samples < 3) return [];
    const { data, samples } = tiff;
    const px: PixelSample[] = [];
    for (let i = 0; i < data.length; i += samples) {
      const ndvi = data[i], str = data[i + 1], mask = data[i + 2];
      if (mask !== 1) continue;
      if (!(str > 0) || !isFinite(str)) continue;
      if (str > OPTRAM_STR_CEILING) continue; // near-zero-SWIR artifact — never real wet soil
      if (!(ndvi >= -1 && ndvi <= 1)) continue;
      px.push({ ndvi, str });
    }
    return px;
  } catch (err) {
    console.warn("OPTRAM raster fetch error:", err);
    return [];
  }
}

// Percentile of a numeric array (p in [0,1]); sorts in place. Returns 0 for an empty array.
function percentile(vals: number[], p: number): number {
  const n = vals.length;
  if (n === 0) return 0;
  vals.sort((a, b) => a - b);
  const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  return vals[idx];
}

// Fit the dry/wet trapezoid edges from a pooled per-pixel (NDVI, STR) cloud. Bins NDVI into
// OPTRAM_NDVI_BINS intervals; per (sufficiently populated) bin the dry-edge candidate is the low
// STR percentile and the wet-edge candidate the high STR percentile, then each candidate set is
// linear-regressed. Using percentiles instead of raw min/max makes the fit robust to the residual
// near-zero-SWIR outliers that previously dragged the wet edge out to STR ≈ 8–10. Falls back to
// flat percentile edges if NDVI has too little spread to fit a slope. Returns null (no soil
// moisture for this analysis) if the pool is too small or the resulting trapezoid fails a physical
// sanity check.
function fitOptramEdges(pool: PixelSample[]): { dry: { slope: number; intercept: number }; wet: { slope: number; intercept: number } } | null {
  if (pool.length < OPTRAM_MIN_BIN_PIXELS * 2) return null;
  let ndviLo = Infinity, ndviHi = -Infinity;
  for (const p of pool) {
    if (p.ndvi < ndviLo) ndviLo = p.ndvi;
    if (p.ndvi > ndviHi) ndviHi = p.ndvi;
  }
  const span = ndviHi - ndviLo;

  let dryFit: { slope: number; intercept: number } | null = null;
  let wetFit: { slope: number; intercept: number } | null = null;

  if (span > 1e-3) {
    const binW = span / OPTRAM_NDVI_BINS;
    const bins = new Map<number, { xSum: number; strs: number[] }>();
    for (const p of pool) {
      let bi = Math.floor((p.ndvi - ndviLo) / binW);
      if (bi >= OPTRAM_NDVI_BINS) bi = OPTRAM_NDVI_BINS - 1;
      const b = bins.get(bi);
      if (!b) bins.set(bi, { xSum: p.ndvi, strs: [p.str] });
      else { b.xSum += p.ndvi; b.strs.push(p.str); }
    }
    const dryPts: { x: number; y: number }[] = [];
    const wetPts: { x: number; y: number }[] = [];
    for (const b of Array.from(bins.values())) {
      if (b.strs.length < OPTRAM_MIN_BIN_PIXELS) continue; // sparse bin — percentiles unreliable
      const x = b.xSum / b.strs.length;
      dryPts.push({ x, y: percentile(b.strs, OPTRAM_DRY_PCTL) });
      wetPts.push({ x, y: percentile(b.strs, OPTRAM_WET_PCTL) });
    }
    dryFit = linearFit(dryPts);
    wetFit = linearFit(wetPts);
  }

  if (!dryFit || !wetFit) {
    // Flat-edge fallback: horizontal dry/wet edges at the pooled STR percentiles (still robust).
    const allStr = pool.map(p => p.str);
    const lo = percentile(allStr, OPTRAM_DRY_PCTL);
    const hi = percentile(allStr, OPTRAM_WET_PCTL);
    if (!(hi > lo)) return null;
    dryFit = { slope: 0, intercept: lo };
    wetFit = { slope: 0, intercept: hi };
  }

  // ── Physical sanity check on the fitted trapezoid ──
  // Evaluate both edges across the real NDVI range. The wet edge must sit above the dry edge, and —
  // because every pooled pixel already satisfies STR ≤ OPTRAM_STR_CEILING — a wet edge that
  // extrapolates far beyond that ceiling means the regression is still being distorted; refuse to
  // emit (likely-garbage) soil moisture rather than silently returning it.
  const strDry = (ndvi: number) => dryFit!.intercept + dryFit!.slope * ndvi;
  const strWet = (ndvi: number) => wetFit!.intercept + wetFit!.slope * ndvi;
  const wetLo = strWet(ndviLo), wetHi = strWet(ndviHi);
  const spanLo = wetLo - strDry(ndviLo), spanHi = wetHi - strDry(ndviHi);
  const wetMax = Math.max(wetLo, wetHi);
  if (!(spanLo > 1e-3) && !(spanHi > 1e-3)) {
    console.warn(`OPTRAM: degenerate trapezoid (wet≈dry across NDVI ${ndviLo.toFixed(3)}–${ndviHi.toFixed(3)}) — soil moisture unavailable`);
    return null;
  }
  if (wetMax > OPTRAM_STR_CEILING * 1.5) {
    console.warn(`OPTRAM: wet edge STR=${wetMax.toFixed(2)} exceeds ${(OPTRAM_STR_CEILING * 1.5).toFixed(1)} across NDVI range — fit still outlier-distorted, soil moisture unavailable`);
    return null;
  }
  console.log(`OPTRAM edges — dry: STR=${dryFit.intercept.toFixed(4)}${dryFit.slope >= 0 ? "+" : ""}${dryFit.slope.toFixed(4)}·NDVI  wet: STR=${wetFit.intercept.toFixed(4)}${wetFit.slope >= 0 ? "+" : ""}${wetFit.slope.toFixed(4)}·NDVI  |  over NDVI ${ndviLo.toFixed(3)}–${ndviHi.toFixed(3)}: STR_dry=${strDry(ndviLo).toFixed(3)}–${strDry(ndviHi).toFixed(3)}, STR_wet=${wetLo.toFixed(3)}–${wetHi.toFixed(3)}`);
  return { dry: dryFit, wet: wetFit };
}

// Given the fitted edges and a date's valid pixels, compute the mean soil-moisture W over pixels
// that pass the physical-plausibility filter. Returns null if no pixel is valid.
function optramDateMoisture(
  pixels: PixelSample[],
  edges: { dry: { slope: number; intercept: number }; wet: { slope: number; intercept: number } }
): number | null {
  let sum = 0, cnt = 0;
  for (const p of pixels) {
    const strDry = edges.dry.intercept + edges.dry.slope * p.ndvi;
    const strWet = edges.wet.intercept + edges.wet.slope * p.ndvi;
    const denom = strWet - strDry;
    if (!(denom > 1e-6)) continue; // degenerate trapezoid at this NDVI
    const w = (p.str - strDry) / denom;
    if (!(w >= 0) || w > OPTRAM_W_CEILING) continue; // drop negatives + oversaturated
    sum += w; cnt++;
  }
  if (cnt === 0) return null;
  return Math.round((sum / cnt) * 1000) / 1000;
}

// Plain-language explanation of why no image passed the 20% rule, so the user can see whether
// it is genuine cloud, cirrus/shadow flagging, missing data, or no satellite passes at all.
function explainNoQualifyingImage(daily: DailyObservation[], dateFrom: string, dateTo: string): string {
  const head = `No Sentinel-2 L2A image with ${MAX_FIELD_CLOUD_PCT}% or less cloud over this field was found between ${dateFrom} and ${dateTo}.`;
  if (daily.length === 0) {
    return `${head} The satellite service returned no passes at all for this field. Check that the field boundary is correct (inside Ghana, not a line or a single point) and that the dates are not in the future.`;
  }
  const best = [...daily].sort((a, b) => a.cloudPct - b.cloudPct)[0];
  const b = best.breakdown;
  const parts = b ? ` (cloud ${b.opaque}%, thin cirrus ${b.cirrus}%, cloud shadow ${b.shadow}%, missing data ${b.noData}%)` : "";
  const noClearLand = best.cloudPct <= MAX_FIELD_CLOUD_PCT && best.ndvi === null
    ? " That pass had no clear land pixels left after removing water." : "";
  return `${head} ${daily.length} satellite passes were checked. The clearest was ${best.date} with ${best.cloudPct}% of the field flagged${parts}.${noClearLand} Try a longer date range or a drier season.`;
}

// ─── Main analysis: pick one qualifying image per 14-day window ─────────────
type SeriesPoint = {
  date: string; ndvi: number | null; ndwi: number | null; soilMoisture: number | null;
  cloudCover: number | null; isWater: boolean; dataSource: string; excluded?: boolean;
  windowFrom: string; windowTo: string;
};

async function fetchSentinelHubData(coordinates: LatLng[], dateFrom: string, dateTo: string): Promise<SeriesPoint[]> {
  // Satellite data only — there is no simulated fallback.
  const token = await getSentinelToken();
  if (!token) {
    throw new Error("Could not connect to the Copernicus satellite service. Check the Copernicus credentials (COPERNICUS_USER_ID / COPERNICUS_ACCOUNT_ID) and try again.");
  }

  const windows = biweeklyWindows(dateFrom, dateTo);
  // Look FALLBACK_DAYS beyond the range so the first/last windows can also borrow a nearby image.
  const today = new Date().toISOString().slice(0, 10);
  const fetchTo = addDays(dateTo, FALLBACK_DAYS) > today ? today : addDays(dateTo, FALLBACK_DAYS);
  const daily = await fetchDailyObservations(token, coordinates, addDays(dateFrom, -FALLBACK_DAYS), fetchTo);
  const picks = selectImagesForWindows(windows, daily);
  for (const d of daily) {
    const b = d.breakdown;
    console.log(`  pass ${d.date}: field cloud ${d.cloudPct}%` + (b ? ` [cloud ${b.opaque} cirrus ${b.cirrus} shadow ${b.shadow} missing ${b.noData}]` : "") + ` water ${d.waterPct}% ndvi ${d.ndvi}`);
  }
  console.log(`Sentinel-2: ${daily.length} acquisitions found, ${daily.filter(d => d.cloudPct <= MAX_FIELD_CLOUD_PCT).length} with ≤${MAX_FIELD_CLOUD_PCT}% field cloud; ${picks.filter(p => p.obs).length}/${windows.length} windows filled`);

  const results: SeriesPoint[] = picks.map(({ window, obs, fallback }) => {
    if (!obs) {
      return {
        date: window.mid, ndvi: null, ndwi: null, soilMoisture: null, cloudCover: null,
        isWater: false, excluded: true, dataSource: `No image ≤${MAX_FIELD_CLOUD_PCT}% cloud`,
        windowFrom: window.from, windowTo: window.to,
      };
    }
    return {
      date: obs.date, ndvi: obs.ndvi, ndwi: obs.msi, soilMoisture: null, cloudCover: obs.cloudPct,
      // A field that is mostly open water on this date is kept in the log but left out of stress analysis.
      isWater: obs.waterPct >= 50,
      dataSource: fallback ? `Sentinel-2 L2A (nearest image, outside window)` : "Sentinel-2 L2A",
      windowFrom: window.from, windowTo: window.to,
    };
  });

  if (!results.some(r => !r.excluded)) {
    throw new Error(explainNoQualifyingImage(daily, dateFrom, dateTo));
  }

  // ── OPTRAM per-pixel calibration across all selected images ──
  const rasters = await Promise.all(
    results.map(r => (!r.excluded && !r.isWater ? fetchOptramRaster(token, coordinates, r.date) : Promise.resolve([] as PixelSample[])))
  );
  const pool: PixelSample[] = [];
  for (const px of rasters) for (const p of px) pool.push(p);
  console.log(`OPTRAM pooled ${pool.length} valid per-pixel (NDVI,STR) pairs across ${rasters.filter(p => p.length).length} dates`);
  const edges = fitOptramEdges(pool);
  if (edges) {
    results.forEach((r, i) => { r.soilMoisture = rasters[i].length ? optramDateMoisture(rasters[i], edges) : null; });
  } else {
    console.warn("OPTRAM: could not fit valid trapezoid edges — soil moisture unavailable");
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Compute aggregated metrics from time-series data ──────────────────────
function computeAggregates(timeSeriesData: any[]) {
  const valid = timeSeriesData.filter(d => !d.excluded && !d.isWater && d.ndvi !== null);
  if (valid.length === 0) return { ndvi: null, ndwi: null, healthScore: null };
  const latest = valid[valid.length - 1];
  const ndvi = latest.ndvi;
  const ndwi = latest.ndwi;
  // Health score: NDVI 70% + MSI adequacy 30%
  const ndviScore = Math.max(0, ((ndvi - 0.05) / 0.9)) * 100;
  // MSI score: lower MSI = better moisture. Invert for health score.
  // MSI < 0.4 = excellent, 0.4-0.6 = good, 0.6-1.0 = ok, 1.0-1.2 = poor, >1.2 = critical
  const ndwiScore = ndwi !== null
    ? (ndwi < 0.4 ? 95 : ndwi < 0.6 ? 80 : ndwi < 1.0 ? 60 : ndwi < 1.2 ? 35 : 10)
    : 50;
  const healthScore = Math.round(Math.max(0, Math.min(100, ndviScore * 0.7 + ndwiScore * 0.3)));
  return { ndvi, ndwi, healthScore };
}

// ─── Alert generation ──────────────────────────────────────────────────────
function generateAlerts(fieldId: number, ndvi: number | null, ndwi: number | null, fieldName: string) {
  const now = new Date().toISOString();
  const list: any[] = [];
  if (ndvi === null) return list;
  if (ndvi < 0.2) {
    list.push({ fieldId, type: "ndvi_critical", severity: "critical", createdAt: now,
      message: `${fieldName}: NDVI critically low (${ndvi.toFixed(3)}). Possible crop failure or bare soil.` });
  } else if (ndvi < 0.35) {
    list.push({ fieldId, type: "ndvi_low", severity: "warning", createdAt: now,
      message: `${fieldName}: Low vegetation density (NDVI ${ndvi.toFixed(3)}). Check for nutrient or pest stress.` });
  }
  if (ndwi !== null) {
    // MSI > 1.2 = severe stress, 1.0-1.2 = moderate (MSI increases with dryness)
    if (ndwi > 1.2) {
      list.push({ fieldId, type: "drought", severity: "critical", createdAt: now,
        message: `${fieldName}: Severe water stress detected (MSI ${ndwi.toFixed(3)}). Immediate irrigation recommended.` });
    } else if (ndwi > 1.0) {
      list.push({ fieldId, type: "water_stress", severity: "warning", createdAt: now,
        message: `${fieldName}: Moderate water stress detected (MSI ${ndwi.toFixed(3)}). Consider supplemental irrigation.` });
    }
  }
  if (ndvi > 0.7 && ndwi !== null && ndwi < 0.6) {
    list.push({ fieldId, type: "optimal", severity: "info", createdAt: now,
      message: `${fieldName}: Excellent crop health — NDVI ${ndvi.toFixed(3)}, MSI ${ndwi.toFixed(3)} (good moisture).` });
  }
  return list;
}

// ─── Check if bi-weekly notification is due ───────────────────────────────
function isBiweeklyDue(lastNotifiedAt: string | null): boolean {
  if (!lastNotifiedAt) return true;
  const last = new Date(lastNotifiedAt);
  const now = new Date();
  const diffMs = now.getTime() - last.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);
  return diffDays >= 14;
}

// ─── Async analysis job store ──────────────────────────────────────────────
// The satellite analysis (token + multi-window raster fetches + NDVI/MSI/OPTRAM
// computation) can take longer than Render's ~30s HTTP proxy timeout. To avoid a
// killed connection + garbled 502, the POST /analyze endpoint kicks the work off
// as a background job and the client polls for the result. Single-instance app,
// so a plain in-memory Map is sufficient (no Redis/queue).
type AnalyzeJob =
  | { status: "processing"; createdAt: number }
  | { status: "done"; createdAt: number; result: unknown }
  | { status: "error"; createdAt: number; error: string };

const analyzeJobs = new Map<string, AnalyzeJob>();
const ANALYZE_JOB_TTL_MS = 45 * 60 * 1000; // evict finished/stale jobs after 45 min

function sweepAnalyzeJobs() {
  const cutoff = Date.now() - ANALYZE_JOB_TTL_MS;
  analyzeJobs.forEach((job, id) => {
    if (job.createdAt < cutoff) analyzeJobs.delete(id);
  });
}
setInterval(sweepAnalyzeJobs, 10 * 60 * 1000).unref?.();

// The actual analysis work, extracted so it can run outside the request lifecycle.
// Returns the exact shape the old synchronous endpoint used to return.
async function runFieldAnalysis(
  fieldId: number,
  opts: { dateFrom: string; dateTo: string },
) {
  const field = storage.getField(fieldId);
  if (!field) throw new Error("Field not found");

  const { dateFrom, dateTo } = opts;
  const coords = JSON.parse(field.coordinates);
  const timeSeriesData = await fetchSentinelHubData(coords, dateFrom, dateTo);
  const { ndvi, ndwi, healthScore } = computeAggregates(timeSeriesData);

  const updated = storage.updateField(field.id, {
    ndvi: ndvi ?? undefined,
    ndwi: ndwi ?? undefined,
    healthScore: healthScore ?? undefined,
    status: healthScore !== null ? (healthScore < 45 ? "alert" : "analyzed") : "analyzed", // Health score bands: >=70 Healthy, 45-69 Monitor, <45 Alert
    timeSeriesData: JSON.stringify(timeSeriesData),
    dateFrom,
    dateTo,
    cloudCoverMax: MAX_FIELD_CLOUD_PCT,
    analyzedAt: new Date().toISOString(),
  });

  // Generate alerts (only if bi-weekly is due)
  const notifyDue = isBiweeklyDue(field.lastNotifiedAt ?? null);
  storage.deleteAlertsByField(field.id);
  const newAlerts = generateAlerts(field.id, ndvi, ndwi, field.name);
  newAlerts.forEach(a => storage.createAlert(a));

  if (notifyDue) {
    storage.updateField(field.id, { lastNotifiedAt: new Date().toISOString() });
  }

  return { field: updated, timeSeriesData, notificationSent: notifyDue };
}

// ─── Express routes ────────────────────────────────────────────────────────
export function registerRoutes(httpServer: Server, app: Express) {
  // Keep-alive ping — no auth, just confirms server is up
  app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Satellite connection status: actually attempts (or reuses a cached) Copernicus OAuth2 token
  app.get("/api/settings/sentinel-status", async (_req, res) => {
    const token = await getSentinelToken();
    res.json({ connected: !!token, mode: "Copernicus SentinelHub API" });
  });

  // Get all fields
  app.get("/api/fields", requireAuth, (req, res) => {
    res.json(storage.getFields());
  });

  // Get single field
  app.get("/api/fields/:id", requireAuth, (req, res) => {
    const field = storage.getField(Number(req.params.id));
    if (!field) return res.status(404).json({ error: "Not found" });
    res.json(field);
  });

  // Create field
  app.post("/api/fields", requireAuth, (req, res) => {
    try {
      const data = insertFieldSchema.parse(req.body);
      res.json(storage.createField(data));
    } catch (e) {
      res.status(400).json({ error: "Invalid data", details: String(e) });
    }
  });

  // Analyze field: compute time-series NDVI/MSI over date range.
  // Async pattern: validate + kick off the (potentially slow) satellite work in the
  // background and immediately return a jobId. The client polls GET /api/analyze-jobs/:jobId.
  // This keeps every HTTP request short so Render's proxy never times out mid-analysis.
  app.post("/api/fields/:id/analyze", requireAuth, (req, res) => {
    const field = storage.getField(Number(req.params.id));
    if (!field) return res.status(404).json({ error: "Not found" });

    const {
      dateFrom = field.dateFrom || new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      dateTo = field.dateTo || new Date().toISOString().split("T")[0],
    } = req.body || {};

    const jobId = randomUUID();
    analyzeJobs.set(jobId, { status: "processing", createdAt: Date.now() });

    // Fire-and-forget: run the analysis outside the request lifecycle. Any rejection is
    // captured as a job error so it never becomes an unhandled rejection / process crash.
    runFieldAnalysis(field.id, { dateFrom, dateTo })
      .then(result => {
        analyzeJobs.set(jobId, { status: "done", createdAt: Date.now(), result });
      })
      .catch(err => {
        console.error("Analyze job error:", err);
        analyzeJobs.set(jobId, { status: "error", createdAt: Date.now(), error: String(err?.message || err) });
      });

    res.status(202).json({ jobId, status: "processing" });
  });

  // Poll the status/result of an analysis job started via POST /api/fields/:id/analyze.
  // Returns { status: "processing" } | { status: "done", result } | { status: "error", error }.
  app.get("/api/analyze-jobs/:jobId", requireAuth, (req, res) => {
    sweepAnalyzeJobs(); // lazy cleanup on access, in addition to the periodic sweep
    const job = analyzeJobs.get(req.params.jobId);
    if (!job) return res.status(404).json({ error: "Job not found or expired" });
    if (job.status === "done") return res.json({ status: "done", result: job.result });
    if (job.status === "error") return res.json({ status: "error", error: job.error });
    res.json({ status: "processing" });
  });

  // Get time-series for a field (with optional date filter)
  app.get("/api/fields/:id/timeseries", requireAuth, (req, res) => {
    const field = storage.getField(Number(req.params.id));
    if (!field) return res.status(404).json({ error: "Not found" });
    const data = field.timeSeriesData ? JSON.parse(field.timeSeriesData) : [];
    const { from, to } = req.query;
    const filtered = data.filter((d: any) => {
      if (from && d.date < String(from)) return false;
      if (to && d.date > String(to)) return false;
      return true;
    });
    res.json(filtered);
  });

  // Update field
  app.patch("/api/fields/:id", requireAuth, (req, res) => {
    const field = storage.getField(Number(req.params.id));
    if (!field) return res.status(404).json({ error: "Not found" });
    try {
      const data = insertFieldSchema.partial().parse(req.body);
      res.json(storage.updateField(Number(req.params.id), data));
    } catch (e) {
      res.status(400).json({ error: "Invalid data", details: String(e) });
    }
  });

  // Delete field
  app.delete("/api/fields/:id", requireAuth, (req, res) => {
    storage.deleteAlertsByField(Number(req.params.id));
    storage.deleteField(Number(req.params.id));
    res.json({ success: true });
  });

  // Bi-weekly check: run analysis for all fields where notification is due
  app.post("/api/notify/check", requireAdmin, async (req, res) => {
    const allFields = storage.getFields();
    const due = allFields.filter(f =>
      f.notificationsEnabled && isBiweeklyDue(f.lastNotifiedAt ?? null)
    );
    const results = [];
    for (const field of due) {
      try {
        const coords = JSON.parse(field.coordinates);
        const dateFrom = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
        const dateTo = new Date().toISOString().split("T")[0];
        const fresh = await fetchSentinelHubData(coords, dateFrom, dateTo);
        // Add the new observation to the field's existing history instead of replacing it.
        const previous: any[] = field.timeSeriesData ? JSON.parse(field.timeSeriesData) : [];
        const freshDates = new Set(fresh.map(p => p.date));
        const ts = [...previous.filter(p => !freshDates.has(p.date) && !(p.excluded && p.date >= dateFrom)), ...fresh]
          .sort((a, b) => a.date.localeCompare(b.date));
        const { ndvi, ndwi, healthScore } = computeAggregates(ts);
        storage.deleteAlertsByField(field.id);
        generateAlerts(field.id, ndvi, ndwi, field.name).forEach(a => storage.createAlert(a));
        storage.updateField(field.id, {
          ndvi: ndvi ?? undefined, ndwi: ndwi ?? undefined, healthScore: healthScore ?? undefined,
          status: healthScore !== null ? (healthScore < 45 ? "alert" : "analyzed") : "analyzed",
          timeSeriesData: JSON.stringify(ts), dateTo, cloudCoverMax: MAX_FIELD_CLOUD_PCT,
          analyzedAt: new Date().toISOString(), lastNotifiedAt: new Date().toISOString()
        });
        results.push({ fieldId: field.id, name: field.name, ndvi, ndwi });
      } catch (err: any) {
        // No satellite data for this field this cycle — keep its previous results and report why.
        results.push({ fieldId: field.id, name: field.name, error: String(err?.message || err) });
      }
    }
    res.json({ checked: due.length, results });
  });

  // Alerts
  app.get("/api/alerts", requireAuth, (req, res) => { res.json(storage.getAlerts()); });
  app.get("/api/alerts/field/:fieldId", requireAuth, (req, res) => {
    res.json(storage.getAlertsByField(Number(req.params.fieldId)));
  });
  app.patch("/api/alerts/:id/acknowledge", requireAuth, (req, res) => {
    storage.acknowledgeAlert(Number(req.params.id));
    res.json({ success: true });
  });

  // Maps and stress zones may only use images that passed the ≤20% field-cloud rule, i.e. dates
  // that appear as valid observations in the field's stored time series.
  function qualifyingDate(field: { timeSeriesData: string | null }, date: string): boolean {
    const ts: any[] = field.timeSeriesData ? JSON.parse(field.timeSeriesData) : [];
    return ts.some(d => d.date === date && !d.excluded && d.ndvi !== null);
  }
  const NOT_QUALIFYING = `This date is not one of the field's qualifying images (${MAX_FIELD_CLOUD_PCT}% or less cloud over the field). Re-run the analysis and choose a date from the time series.`;
  const SCL_MASK_JS = `[${SCL_CLOUD_CLASSES.join(",")}].indexOf(s.SCL)>=0||s.SCL===0||s.SCL===1||s.dataMask===0`;

  // ─── Spatial map: render NDVI or MSI PNG for a field on one qualifying image date ──
  app.get("/api/fields/:id/map", requireAuth, async (req, res) => {
    try {
      const field = storage.getField(Number(req.params.id));
      if (!field) return res.status(404).json({ error: "Not found" });

      const { date, type = "ndvi" } = req.query as { date?: string; type?: string };
      if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
      if (type !== "ndvi" && type !== "msi") return res.status(400).json({ error: "type must be ndvi or msi" });
      if (!qualifyingDate(field, date)) return res.status(400).json({ error: NOT_QUALIFYING });

      const coords = JSON.parse(field.coordinates) as { lat: number; lng: number }[];
      // Small buffer (~500m) so the field isn't clipped at the edge
      const bbox = bboxOf(coords, 0.005);

      const token = await getSentinelToken();
      if (!token) {
        return res.status(503).json({ error: "No Sentinel Hub token — check credentials" });
      }

      // NDVI: red → yellow → green ramp.  MSI: blue (moist) → yellow → red (stressed).
      // Cloud, cirrus, cloud shadow and no-data pixels → grey; water → blue.
      let evalscript: string;
      if (type === "ndvi") {
        evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B04','B08','SCL','dataMask']}],output:{bands:3}};}",
            "function evaluatePixel(s){",
            `  if(${SCL_MASK_JS})return[0.6,0.6,0.7];`,
            `  if(s.SCL===${SCL_WATER_CLASS})return[0.1,0.3,0.7];`,
            "  var n=(s.B08-s.B04)/(s.B08+s.B04+0.0001);",
            "  var v=Math.max(0,Math.min(1,(n+0.2)/1.0));",
            "  if(v<0.33)return[0.8+v*0.6, v*1.2, 0.05];",
            "  if(v<0.66)return[0.8-v*0.4, 0.7+v*0.3, 0.05];",
            "  return[0.05, 0.4+v*0.5, 0.1];",
            "}"
          ].join("\n");
      } else {
        evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B8A','B11','SCL','dataMask']}],output:{bands:3}};}",
            "function evaluatePixel(s){",
            `  if(${SCL_MASK_JS})return[0.6,0.6,0.7];`,
            `  if(s.SCL===${SCL_WATER_CLASS})return[0.1,0.3,0.7];`,
            "  var msi=(s.B11/(s.B8A+0.001));",
            "  var v=Math.max(0,Math.min(1,(msi-0.1)/1.5));",
            "  if(v<0.33)return[0.05,0.5,0.85];",
            "  if(v<0.66)return[0.95,0.85,0.1];",
            "  return[0.9,0.1,0.05];",
            "}"
          ].join("\n");
      }

      const body = {
        input: {
          bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
          data: [{
            type: "sentinel-2-l2a",
            dataFilter: { timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` } }
          }]
        },
        output: { width: 256, height: 256, responses: [{ identifier: "default", format: { type: "image/png" } }] },
        evalscript
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const imgRes = await fetch(SENTINEL_API, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "image/png"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!imgRes.ok) {
        const err = await imgRes.text();
        console.warn("Map render error:", imgRes.status, err.slice(0, 200));
        return res.status(imgRes.status).json({ error: "Map rendering failed", detail: err.slice(0, 200) });
      }

      // Make every pixel outside the field boundary transparent, so the map shows only the field.
      const rendered = decodePNG(Buffer.from(await imgRes.arrayBuffer()));
      const clipped = clipPngToField(rendered, bbox, coords);
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400"); // cache 24h — same date always gives same image
      res.send(clipped);
    } catch (err) {
      console.error("Map route error:", err);
      res.status(500).json({ error: "Map rendering failed", detail: String(err) });
    }
  });


  // ─── Clip a rendered map to the field boundary (RGBA PNG, transparent outside) ──
  function clipPngToField(
    png: { width: number; height: number; channels: number; pixels: Buffer },
    bbox: number[], coords: { lat: number; lng: number }[],
  ): Buffer {
    const { width, height, channels, pixels } = png;
    const [minLng, minLat, maxLng, maxLat] = bbox;
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const lat = maxLat - ((y + 0.5) / height) * (maxLat - minLat);
      for (let x = 0; x < width; x++) {
        const lng = minLng + ((x + 0.5) / width) * (maxLng - minLng);
        const src = (y * width + x) * channels, dst = (y * width + x) * 4;
        const gray = channels < 3;
        rgba[dst] = pixels[src];
        rgba[dst + 1] = gray ? pixels[src] : pixels[src + 1];
        rgba[dst + 2] = gray ? pixels[src] : pixels[src + 2];
        rgba[dst + 3] = pointInPolygon(lat, lng, coords) ? 255 : 0;
      }
    }
    return encodePNG(width, height, rgba);
  }

  // Minimal RGBA PNG encoder (filter 0, zlib deflate) — avoids an image dependency.
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(buf: Buffer): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function encodePNG(width: number, height: number, rgba: Buffer): Buffer {
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
      return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGBA
    const raw = Buffer.alloc(height * (width * 4 + 1));
    for (let y = 0; y < height; y++) {
      raw[y * (width * 4 + 1)] = 0;
      rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
  }

  // ─── Minimal dependency-free PNG decoder (grayscale/RGB, 8-bit) ────────────
  // Decodes IHDR + IDAT chunks manually via zlib.inflateSync — avoids adding
  // an image-decoding dependency just to read back raw index values.
  function decodePNG(buf: Buffer): { width: number; height: number; channels: number; pixels: Buffer } {
    let offset = 8; // skip PNG signature
    let width = 0, height = 0, bitDepth = 8, colorType = 0;
    const idatChunks: Buffer[] = [];
    while (offset < buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString("ascii", offset + 4, offset + 8);
      const dataStart = offset + 8;
      if (type === "IHDR") {
        width = buf.readUInt32BE(dataStart);
        height = buf.readUInt32BE(dataStart + 4);
        bitDepth = buf.readUInt8(dataStart + 8);
        colorType = buf.readUInt8(dataStart + 9);
      } else if (type === "IDAT") {
        idatChunks.push(buf.subarray(dataStart, dataStart + len));
      } else if (type === "IEND") {
        break;
      }
      offset = dataStart + len + 4; // skip CRC
    }
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const channelsMap: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
    const channels = channelsMap[colorType] || 1;
    const bytesPerPixel = Math.ceil((channels * bitDepth) / 8);
    const stride = Math.ceil((width * channels * bitDepth) / 8);
    const pixels = Buffer.alloc(height * stride);
    let prevRow = Buffer.alloc(stride);
    let pos = 0;
    for (let y = 0; y < height; y++) {
      const filterType = raw[pos]; pos++;
      const row = raw.subarray(pos, pos + stride);
      pos += stride;
      const outRow = pixels.subarray(y * stride, (y + 1) * stride);
      for (let x = 0; x < stride; x++) {
        const a = x >= bytesPerPixel ? outRow[x - bytesPerPixel] : 0;
        const b = prevRow[x];
        const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;
        let val: number;
        switch (filterType) {
          case 0: val = row[x]; break;
          case 1: val = (row[x] + a) & 0xff; break;
          case 2: val = (row[x] + b) & 0xff; break;
          case 3: val = (row[x] + Math.floor((a + b) / 2)) & 0xff; break;
          case 4: {
            const p = a + b - c;
            const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
            const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
            val = (row[x] + pr) & 0xff;
            break;
          }
          default: val = row[x];
        }
        outRow[x] = val;
      }
      prevRow = outRow;
    }
    return { width, height, channels, pixels };
  }

  // Point-in-polygon test (ray casting) — coords is [{lat,lng}, ...]
  function pointInPolygon(lat: number, lng: number, coords: { lat: number; lng: number }[]): boolean {
    let inside = false;
    for (let i = 0, j = coords.length - 1; i < coords.length; j = i++) {
      const xi = coords[i].lng, yi = coords[i].lat;
      const xj = coords[j].lng, yj = coords[j].lat;
      const intersect = ((yi > lat) !== (yj > lat)) &&
        (lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // ─── DBSCAN clustering over grid cells ──────────────────────────────────────
  // Groups density-connected stressed cells into irregularly-shaped clusters
  // instead of anchoring one pin per isolated worst pixel. Distance metric is
  // Chebyshev (8-connected) grid distance, so eps=1.5 means "touches one of my
  // 8 neighbors". minPts=1 means a single isolated stressed cell still forms
  // its own valid cluster (coarse 40x40 grids can have real but small hotspots).
  type GridCell = { row: number; col: number; lat: number; lng: number; value: number };
  function dbscanCluster<T extends GridCell>(points: T[], eps = 1.5, minPts = 1): T[][] {
    const n = points.length;
    const visited = new Array(n).fill(false);
    const clustered = new Array(n).fill(false);
    const clusters: T[][] = [];

    const regionQuery = (i: number): number[] => {
      const neighbors: number[] = [];
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dRow = Math.abs(points[i].row - points[j].row);
        const dCol = Math.abs(points[i].col - points[j].col);
        if (Math.max(dRow, dCol) <= eps) neighbors.push(j);
      }
      return neighbors;
    };

    for (let i = 0; i < n; i++) {
      if (visited[i]) continue;
      visited[i] = true;
      const neighbors = regionQuery(i);
      if (neighbors.length + 1 < minPts) continue; // noise — too isolated even for minPts=1 edge case

      const cluster: T[] = [points[i]];
      clustered[i] = true;
      const seeds = [...neighbors];
      while (seeds.length > 0) {
        const j = seeds.shift()!;
        if (!visited[j]) {
          visited[j] = true;
          const jNeighbors = regionQuery(j);
          if (jNeighbors.length + 1 >= minPts) seeds.push(...jNeighbors);
        }
        if (!clustered[j]) {
          clustered[j] = true;
          cluster.push(points[j]);
        }
      }
      clusters.push(cluster);
    }
    return clusters;
  }

  // ─── Stress zones: find worst sub-areas within a field and return GPS pins ──
  // Requests a coarse grayscale grid from Sentinel Hub where pixel intensity
  // directly encodes the normalized index value (0-255), decodes it locally,
  // filters to cells inside the actual field polygon (not just its bbox),
  // then clusters the worst cells into a handful of navigable zones.
  app.get("/api/fields/:id/stress-zones", requireAuth, async (req, res) => {
    try {
      const field = storage.getField(Number(req.params.id));
      if (!field) return res.status(404).json({ error: "Not found" });

      const { date, index = "ndvi", maxZones = "5" } = req.query as { date?: string; index?: string; maxZones?: string };
      if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });
      if (index !== "ndvi" && index !== "msi") return res.status(400).json({ error: "index must be ndvi or msi" });
      if (!qualifyingDate(field, date)) return res.status(400).json({ error: NOT_QUALIFYING });
      const limit = Math.max(1, Math.min(10, parseInt(maxZones) || 5));

      const coords = JSON.parse(field.coordinates) as { lat: number; lng: number }[];
      const lats = coords.map(c => c.lat);
      const lngs = coords.map(c => c.lng);
      const buf = 0.002; // smaller buffer than the display map — we want the grid tight to the field
      const minLng = Math.min(...lngs) - buf, minLat = Math.min(...lats) - buf;
      const maxLng = Math.max(...lngs) + buf, maxLat = Math.max(...lats) + buf;
      const bbox = [minLng, minLat, maxLng, maxLat];

      const token = await getSentinelToken();
      if (!token) {
        return res.status(503).json({ error: "No Sentinel Hub token — check credentials" });
      }

      const GRID = 40; // 40x40 grid — fine enough for sub-field zones, coarse enough to be fast

      // Evalscript encodes the raw index value directly as an 8-bit grayscale value.
      // Cloud, cirrus, cloud shadow, no-data and water pixels are encoded as 255 and excluded.
      let evalscript: string;
      let isStressHigh: boolean; // true = higher raw value means MORE stress (MSI)
      if (index === "msi") {
        isStressHigh = true;
        evalscript = [
          "//VERSION=3",
          "function setup(){return{input:[{bands:['B8A','B11','SCL','dataMask']}],output:{bands:1,sampleType:'UINT8'}};}",
          "function evaluatePixel(s){",
          `  if(${SCL_MASK_JS}||s.SCL===${SCL_WATER_CLASS})return[255];`,
          "  var msi=(s.B11/(s.B8A+0.001));",
          "  var v=Math.max(0,Math.min(1,(msi-0.1)/1.5));",
          "  return[Math.round(v*254)];",
          "}"
        ].join("\n");
      } else {
        isStressHigh = false; // low NDVI = more stress
        evalscript = [
          "//VERSION=3",
          "function setup(){return{input:[{bands:['B04','B08','SCL','dataMask']}],output:{bands:1,sampleType:'UINT8'}};}",
          "function evaluatePixel(s){",
          `  if(${SCL_MASK_JS}||s.SCL===${SCL_WATER_CLASS})return[255];`,
          "  var n=(s.B08-s.B04)/(s.B08+s.B04+0.0001);",
          "  var v=Math.max(0,Math.min(1,(n+0.2)/1.0));",
          "  return[Math.round(v*254)];",
          "}"
        ].join("\n");
      }

      const body = {
        input: {
          bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
          data: [{
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: { from: `${date}T00:00:00Z`, to: `${date}T23:59:59Z` }
            }
          }]
        },
        output: { width: GRID, height: GRID, responses: [{ identifier: "default", format: { type: "image/png" } }] },
        evalscript
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const imgRes = await fetch(SENTINEL_API, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "image/png"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!imgRes.ok) {
        const err = await imgRes.text();
        console.warn("Stress-zones render error:", imgRes.status, err.slice(0, 200));
        return res.status(imgRes.status).json({ error: "Stress zone analysis failed", detail: err.slice(0, 200) });
      }

      const pngBuf = Buffer.from(await imgRes.arrayBuffer());
      const decoded = decodePNG(pngBuf);

      // Build candidate cells: grid position → lat/lng → raw value
      type Cell = { row: number; col: number; lat: number; lng: number; value: number; raw: number };
      const cells: Cell[] = [];
      const lngStep = (maxLng - minLng) / decoded.width;
      const latStep = (maxLat - minLat) / decoded.height;
      for (let row = 0; row < decoded.height; row++) {
        for (let col = 0; col < decoded.width; col++) {
          const raw = decoded.pixels[row * decoded.width * decoded.channels + col * decoded.channels];
          if (raw === 255) continue; // cloud/water excluded
          // Cell center lat/lng (image row 0 = top = maxLat)
          const lng = minLng + (col + 0.5) * lngStep;
          const lat = maxLat - (row + 0.5) * latStep;
          if (!pointInPolygon(lat, lng, coords)) continue; // only keep cells inside the actual field shape
          const value = raw / 254; // normalized 0-1
          cells.push({ row, col, lat, lng, value, raw });
        }
      }

      if (cells.length === 0) {
        return res.json({ zones: [], message: "No valid pixels found inside field boundary for this date (cloud cover or field too small)." });
      }

      // Compute overall field stats for context (mean value of valid cells)
      const meanValue = cells.reduce((s, c) => s + c.value, 0) / cells.length;
      const deviationOf = (v: number) => isStressHigh ? v - meanValue : meanValue - v;

      // Only cluster cells that actually qualify as stressed ("moderate" threshold
      // or worse) — clustering the whole field would just produce one giant blob.
      const STRESS_QUALIFY_DEVIATION = 0.12;
      const stressedCells = cells.filter(c => deviationOf(c.value) > STRESS_QUALIFY_DEVIATION);

      if (stressedCells.length === 0) {
        return res.json({
          index: index.toLowerCase(),
          date,
          fieldMean: Math.round(meanValue * 1000) / 1000,
          zones: [],
          message: "No distinct stress zones — field looks fairly uniform for this date.",
        });
      }

      // DBSCAN groups density-connected stressed cells into irregularly-shaped
      // clusters (handles the "2 bad pixels on the left, 2 on the right" case
      // correctly — those become two separate clusters since they're far apart,
      // while adjacent bad pixels within the same patch merge into one cluster).
      const rawClusters = dbscanCluster(stressedCells, 1.5, 1);

      // For each cluster: pin location = severity-weighted centroid (pulls the
      // pin toward the worst part of an irregular blob rather than its plain
      // geometric center); reported value/severity = the single worst cell in
      // that cluster (so the number shown matches what's physically near the pin).
      type ClusterSummary = {
        lat: number; lng: number; worstValue: number; cellCount: number; deviation: number;
      };
      const clusterSummaries: ClusterSummary[] = rawClusters.map(cluster => {
        let worst = cluster[0];
        for (const c of cluster) {
          if (deviationOf(c.value) > deviationOf(worst.value)) worst = c;
        }
        let wSum = 0, latSum = 0, lngSum = 0;
        for (const c of cluster) {
          const w = Math.max(deviationOf(c.value), 0.001); // weight by stress severity
          wSum += w;
          latSum += c.lat * w;
          lngSum += c.lng * w;
        }
        return {
          lat: latSum / wSum,
          lng: lngSum / wSum,
          worstValue: worst.value,
          cellCount: cluster.length,
          deviation: deviationOf(worst.value),
        };
      });

      // Rank clusters by their worst-cell severity, cap at the requested limit.
      clusterSummaries.sort((a, b) => b.deviation - a.deviation);
      const topClusters = clusterSummaries.slice(0, limit);

      const result = topClusters.map((z, i) => {
        let severity: "critical" | "warning" | "moderate";
        if (z.deviation > 0.25) severity = "critical";
        else if (z.deviation > 0.12) severity = "warning";
        else severity = "moderate";
        return {
          id: i + 1,
          label: `Zone ${String.fromCharCode(65 + i)}`, // Zone A, B, C...
          lat: Math.round(z.lat * 1e6) / 1e6,
          lng: Math.round(z.lng * 1e6) / 1e6,
          value: Math.round(z.worstValue * 1000) / 1000,
          severity,
          cellCount: z.cellCount,
          navigateUrl: `https://www.google.com/maps/dir/?api=1&destination=${z.lat.toFixed(6)},${z.lng.toFixed(6)}&travelmode=walking`,
        };
      });

      res.json({
        index: index.toLowerCase(),
        date,
        fieldMean: Math.round(meanValue * 1000) / 1000,
        zones: result,
      });
    } catch (err) {
      console.error("Stress-zones route error:", err);
      res.status(500).json({ error: "Stress zone analysis failed", detail: String(err) });
    }
  });

  // ── PDF Report endpoint ─────────────────────────────────────────────────
  app.get("/api/fields/:id/report", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const field = storage.getField(id);
      if (!field) return res.status(404).json({ error: "Field not found" });
      const fieldAlerts = storage.getAlertsByField(id);
      const pdfBuffer = await generateFieldReport(field, fieldAlerts);
      const safeName = field.name.replace(/[^a-zA-Z0-9-_]/g, "-").slice(0, 40);
      const filename = `narrowtech-gs_${safeName}_${new Date().toISOString().slice(0,10)}.pdf`;
      res.set("Content-Type", "application/pdf");
      res.set("Content-Disposition", `attachment; filename="${filename}"`);
      res.set("Cache-Control", "no-store");
      res.send(pdfBuffer);
    } catch (err) {
      console.error("Report generation error:", err);
      res.status(500).json({ error: "Report generation failed", detail: String(err) });
    }
  });

  // ── WhatsApp notification endpoint ──────────────────────────────────────
  app.post("/api/fields/:id/notify-whatsapp", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const field = storage.getField(id);
      if (!field) return res.status(404).json({ error: "Field not found" });
      const fieldAlerts = storage.getAlertsByField(id);
      const result = await sendWhatsAppNotification(field, fieldAlerts);
      res.json({
        ...result,
        preview: buildWhatsAppMessage(field, fieldAlerts).slice(0, 300),
      });
    } catch (err) {
      console.error("WhatsApp error:", err);
      res.status(500).json({ error: "WhatsApp notification failed", detail: String(err) });
    }
  });

  // ── Get WhatsApp message preview ────────────────────────────────────────
  app.get("/api/fields/:id/whatsapp-preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id);
      const field = storage.getField(id);
      if (!field) return res.status(404).json({ error: "Field not found" });
      const fieldAlerts = storage.getAlertsByField(id);
      res.json({ message: buildWhatsAppMessage(field, fieldAlerts) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return httpServer;
}
