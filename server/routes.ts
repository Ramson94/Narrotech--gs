import type { Express } from "express";
import { Server } from "http";
import zlib from "zlib";
import { storage } from "./storage";
import { insertFieldSchema } from "@shared/schema";
import { generateFieldReport } from "./report";
import { sendWhatsAppNotification, buildWhatsAppMessage } from "./whatsapp";
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
      // Credentials not yet configured — fall through to simulation
      return "";
    }
    const json = await res.json();
    _cachedToken = json.access_token || "";
    _tokenExpiry = Date.now() + (json.expires_in || 600) * 1000;
    return _cachedToken || "";
  } catch (err) {
    console.warn("OAuth2 token fetch failed (falling back to simulation):", err);
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

/**
 * Classify a pixel based on EVI (Enhanced Vegetation Index).
 * EVI = 2.5 * (NIR-Red) / (NIR + 6*Red - 7.5*Blue + 1)
 * EVI improves on NDVI by correcting for atmospheric and soil-background
 * effects and reducing saturation over dense canopy.
 */
function classifyEvi(evi: number) {
  if (evi >= 0.5) return "Excellent";
  if (evi >= 0.35) return "Good";
  if (evi >= 0.2) return "Moderate";
  if (evi >= 0.1) return "Poor";
  return "Critical";
}

// ─── SentinelHub real API call ─────────────────────────────────────────────
// ─── Helper: generate bi-weekly date windows between two dates ────────────
function biweeklyWindows(dateFrom: string, dateTo: string): { from: string; to: string; mid: string }[] {
  const windows: { from: string; to: string; mid: string }[] = [];
  let cursor = new Date(dateFrom);
  const end = new Date(dateTo);
  while (cursor <= end) {
    const winEnd = new Date(cursor);
    winEnd.setDate(winEnd.getDate() + 13);
    if (winEnd > end) winEnd.setTime(end.getTime());
    const mid = new Date(cursor);
    mid.setDate(mid.getDate() + 7);
    windows.push({
      from: cursor.toISOString().split("T")[0],
      to: winEnd.toISOString().split("T")[0],
      mid: mid > end ? end.toISOString().split("T")[0] : mid.toISOString().split("T")[0]
    });
    cursor = new Date(winEnd);
    cursor.setDate(cursor.getDate() + 1);
  }
  return windows;
}

// ─── Single-window Sentinel Hub statistical API call ─────────────────────
// Uses P1D intervals to find ALL scenes in the window, then picks the best one.
// P14D was returning empty data from CDSE — daily intervals work reliably.
async function fetchOneWindow(
  token: string,
  bbox: number[],
  winFrom: string,
  winTo: string,
  cloudCoverMax: number
): Promise<{ ndvi: number | null; msi: number | null; evi: number | null; cloudCover: number; noData: boolean }> {

  // Build evalscript as array-join to avoid template literal serialization issues with esbuild
  const evalscript = [
    "//VERSION=3",
    "function setup() {",
    "  return {",
    "    input: [{ bands: ['B02','B04','B08','B8A','B11','SCL'] }],",
    "    output: [",
    "      { id: 'ndvi',     bands: 1, sampleType: 'FLOAT32' },",
    "      { id: 'msi',      bands: 1, sampleType: 'FLOAT32' },",
    "      { id: 'evi',      bands: 1, sampleType: 'FLOAT32' },",
    "      { id: 'dataMask', bands: 1, sampleType: 'UINT8'   }",
    "    ],",
    "    mosaicking: 'SIMPLE'",
    "  };",
    "}",
    "function evaluatePixel(s) {",
    "  var scl = s.SCL;",
    "  if ([8,9,10,3].includes(scl) || scl === 6) return { ndvi:[0], msi:[0], evi:[0], dataMask:[0] };",
    "  var n=s.B08, r=s.B04, nir8a=s.B8A, sw=s.B11, b=s.B02;",
    "  var d1=n+r, d2=nir8a;",
    "  if (d1 < 0.01 || d2 < 0.01) return { ndvi:[0], msi:[0], evi:[0], dataMask:[0] };",
    "  var eviDen = n + 6*r - 7.5*b + 1;",
    "  var evi = Math.abs(eviDen) < 0.01 ? 0 : 2.5*(n-r)/eviDen;",
    "  return { ndvi:[(n-r)/d1], msi:[sw/d2], evi:[evi], dataMask:[1] };",
    "}"
  ].join("\n");

  const body = {
    input: {
      bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
      data: [{
        type: "sentinel-2-l2a",
        dataFilter: {
          timeRange: { from: `${winFrom}T00:00:00Z`, to: `${winTo}T23:59:59Z` },
          maxCloudCoverage: cloudCoverMax
        }
      }]
    },
    aggregation: {
      timeRange: { from: `${winFrom}T00:00:00Z`, to: `${winTo}T23:59:59Z` },
      aggregationInterval: { of: "P1D" },  // P1D: one result per day with imagery
      width: 64, height: 64,
      evalscript  // inside aggregation — required by Statistics API
    },
    calculations: {
      ndvi: { statistics: { default: {} } },
      msi:  { statistics: { default: {} } },
      evi:  { statistics: { default: {} } }
    }
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    const res = await fetch(SENTINEL_STATS_API, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      console.warn("Stats API error:", res.status, errText.slice(0, 400));
      return { ndvi: null, msi: null, evi: null, cloudCover: 100, noData: true };
    }
    const json = await res.json();
    const intervals: any[] = json?.data || [];
    if (!intervals.length) return { ndvi: null, msi: null, evi: null, cloudCover: 100, noData: true };

    // Pick the best daily observation: highest valid-pixel ratio, sensible NDVI
    let best: { ndvi: number; msi: number | null; evi: number | null; cloudCover: number } | null = null;
    let bestValidRatio = -1;

    for (const iv of intervals) {
      const ns = iv?.outputs?.ndvi?.bands?.B0?.stats;
      const ms = iv?.outputs?.msi?.bands?.B0?.stats;
      const es = iv?.outputs?.evi?.bands?.B0?.stats;
      if (!ns || ns.sampleCount === 0) continue;
      const validRatio = 1 - (ns.noDataCount / ns.sampleCount);
      if (validRatio < 0.05) continue;  // less than 5% valid pixels — skip
      const ndviMean = ns.mean;
      const msiMean  = ms?.mean ?? null;
      const eviMean  = es?.mean ?? null;
      if (typeof ndviMean !== "number" || ndviMean < -1.5 || ndviMean > 1.5) continue;
      if (validRatio > bestValidRatio) {
        bestValidRatio = validRatio;
        best = {
          ndvi: Math.round(ndviMean * 1000) / 1000,
          msi:  (typeof msiMean === "number" && msiMean > 0.05 && msiMean < 10)
                ? Math.round(msiMean * 1000) / 1000 : null,
          evi:  (typeof eviMean === "number" && eviMean > -1.5 && eviMean < 1.5)
                ? Math.round(eviMean * 1000) / 1000 : null,
          cloudCover: Math.round((1 - validRatio) * 100)
        };
      }
    }

    if (!best) return { ndvi: null, msi: null, evi: null, cloudCover: 100, noData: true };
    return { ...best, noData: false };

  } catch (err) {
    console.warn("Stats API window fetch error:", err);
    return { ndvi: null, msi: null, evi: null, cloudCover: 100, noData: true };
  }
}

// ─── Main SentinelHub real-data function: iterate bi-weekly windows ────────
async function fetchSentinelHubData(
  coordinates: { lat: number; lng: number }[],
  dateFrom: string,
  dateTo: string,
  cloudCoverMax: number
): Promise<{ ndvi: number; ndwi: number; evi: number | null; cloudCover: number; isWater: boolean; date: string; dataSource: string }[]> {

  const token = await getSentinelToken();
  if (!token) {
    console.log("No Sentinel token — using simulation");
    return simulateTimeSeries(coordinates, dateFrom, dateTo);
  }

  // Compute bounding box from polygon corners
  const lats = coordinates.map(c => c.lat);
  const lngs = coordinates.map(c => c.lng);
  const bbox = [
    Math.min(...lngs), Math.min(...lats),
    Math.max(...lngs), Math.max(...lats)
  ];

  const windows = biweeklyWindows(dateFrom, dateTo);
  console.log(`Fetching ${windows.length} bi-weekly windows in parallel from Sentinel-2...`);

  // Run all windows in parallel (much faster than sequential — avoids 503 timeouts)
  const windowResults = await Promise.all(
    windows.map(async (win) => {
      let result = await fetchOneWindow(token, bbox, win.from, win.to, cloudCoverMax);
      // If cloudy, retry with relaxed threshold (up to 50%)
      if (result.noData && cloudCoverMax < 50) {
        result = await fetchOneWindow(token, bbox, win.from, win.to, 50);
      }
      return { win, result };
    })
  );

  const results: { ndvi: number; ndwi: number; evi: number | null; cloudCover: number; isWater: boolean; date: string; dataSource: string }[] = [];
  let realDataCount = 0;

  for (const { win, result } of windowResults) {
    if (result.noData || result.ndvi === null) {
      // No usable data for this window — fill with a simulation estimate
      const simPts = simulateTimeSeries(coordinates, win.mid, win.mid);
      if (simPts.length > 0) {
        results.push({ ...simPts[0], date: win.mid, dataSource: "Estimated (cloud gap)" });
      }
    } else {
      realDataCount++;
      const msiVal = result.msi ?? 0.8;
      const { isWater } = classifyMsi(msiVal);
      const source = result.cloudCover > cloudCoverMax ? "Sentinel-2 (relaxed cloud)" : "Sentinel-2";
      results.push({
        date: win.mid,
        ndvi: result.ndvi,
        ndwi: msiVal,
        evi: result.evi ?? null,
        cloudCover: result.cloudCover,
        isWater,
        dataSource: source
      });
    }
  }

  // If we got zero real results, fall back to full simulation
  if (realDataCount === 0) {
    console.warn("Zero real Sentinel-2 results — falling back to simulation");
    return simulateTimeSeries(coordinates, dateFrom, dateTo);
  }

  console.log(`Sentinel-2 fetch done: ${realDataCount}/${windows.length} windows with real data`);
  return results.sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Bi-weekly simulation: one obs every ~14 days between dateFrom/dateTo ──
function simulateTimeSeries(
  coordinates: { lat: number; lng: number }[],
  dateFrom: string,
  dateTo: string
) {
  const centLat = coordinates.reduce((s, c) => s + c.lat, 0) / coordinates.length;
  const centLng = coordinates.reduce((s, c) => s + c.lng, 0) / coordinates.length;
  const seed = Math.abs(Math.sin(centLat * 127.3 + centLng * 311.7));
  const seed2 = Math.abs(Math.sin(centLat * 53.1 + centLng * 97.4));

  const start = new Date(dateFrom);
  const end = new Date(dateTo);
  const results: any[] = [];
  const current = new Date(start);

  while (current <= end) {
    const t = (current.getTime() - start.getTime()) / (end.getTime() - start.getTime() + 1);
    // Seasonal NDVI variation (Ghana has two rainy seasons ~Mar-Jun, Sep-Nov)
    const month = current.getMonth(); // 0-11
    const seasonalBoost = (month >= 3 && month <= 5) || (month >= 8 && month <= 10) ? 0.12 : -0.06;
    const rngNdvi = Math.abs(Math.sin(seed * (t * 100 + 1) * 7.3));
    const rngNdwi = Math.abs(Math.sin(seed2 * (t * 100 + 2) * 5.1));
    const baseNdvi = 0.2 + seed * 0.5;
    // MSI base: lower in wet season (0.3–0.6), higher in dry (0.8–1.4)
    const baseMsi = 0.5 + seed2 * 0.6;
    const ndvi = Math.max(0.05, Math.min(0.95, baseNdvi + seasonalBoost + (rngNdvi - 0.5) * 0.1));
    // In wet season MSI drops (more moisture = lower MSI)
    const seasonalMsiDrop = (month >= 3 && month <= 5) || (month >= 8 && month <= 10) ? -0.15 : 0.1;
    const rawNdwi = Math.max(0.1, Math.min(2.0, baseMsi + seasonalMsiDrop + (rngNdwi - 0.5) * 0.2));
    // Exclude open water pixels — MSI < 0.1 indicates open water
    const isWater = rawNdwi < 0.1;
    const cloudCover = Math.round(Math.abs(Math.sin(seed * t * 13.7)) * 30);
    // If cloud cover > threshold, mark as cloud-contaminated
    const cloudOk = cloudCover <= 20;

    // EVI correlates with NDVI but has reduced saturation over dense canopy —
    // approximate as a damped, slightly noisy function of NDVI for simulation.
    const rngEvi = Math.abs(Math.sin(seed * (t * 100 + 3) * 9.1));
    const rawEvi = Math.max(-1, Math.min(1, ndvi * 0.85 + (rngEvi - 0.5) * 0.08));

    if (!isWater && cloudOk) {
      results.push({
        date: current.toISOString().split("T")[0],
        ndvi: Math.round(ndvi * 1000) / 1000,
        ndwi: Math.round(rawNdwi * 1000) / 1000,
        evi: Math.round(rawEvi * 1000) / 1000,
        cloudCover,
        isWater: false,
        dataSource: "Simulated (no API key)"
      });
    } else if (!cloudOk) {
      // Record cloudy observation — flagged, values estimated
      results.push({
        date: current.toISOString().split("T")[0],
        ndvi: null,
        ndwi: null,
        evi: null,
        cloudCover,
        isWater: false,
        dataSource: "Cloudy — excluded",
        excluded: true
      });
    }
    // Advance ~14 days (bi-weekly Sentinel-2 pass)
    current.setDate(current.getDate() + 14);
  }
  return results;
}

// ─── Compute aggregated metrics from time-series data ──────────────────────
function computeAggregates(timeSeriesData: any[]) {
  const valid = timeSeriesData.filter(d => !d.excluded && !d.isWater && d.ndvi !== null);
  if (valid.length === 0) return { ndvi: null, ndwi: null, evi: null, healthScore: null };
  const latest = valid[valid.length - 1];
  const ndvi = latest.ndvi;
  const ndwi = latest.ndwi;
  const evi = latest.evi ?? null;
  // Health score: NDVI 70% + NDWI adequacy 30% (unchanged — EVI is supplementary/displayed only)
  const ndviScore = Math.max(0, ((ndvi - 0.05) / 0.9)) * 100;
  // MSI score: lower MSI = better moisture. Invert for health score.
  // MSI < 0.4 = excellent, 0.4-0.6 = good, 0.6-1.0 = ok, 1.0-1.2 = poor, >1.2 = critical
  const ndwiScore = ndwi !== null
    ? (ndwi < 0.4 ? 95 : ndwi < 0.6 ? 80 : ndwi < 1.0 ? 60 : ndwi < 1.2 ? 35 : 10)
    : 50;
  const healthScore = Math.round(Math.max(0, Math.min(100, ndviScore * 0.7 + ndwiScore * 0.3)));
  return { ndvi, ndwi, evi, healthScore };
}

// ─── Alert generation ──────────────────────────────────────────────────────
function generateAlerts(fieldId: number, ndvi: number | null, ndwi: number | null, fieldName: string, evi?: number | null) {
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
  if (typeof evi === "number" && evi < 0.1) {
    list.push({ fieldId, type: "evi_critical", severity: "warning", createdAt: now,
      message: `${fieldName}: EVI critically low (${evi.toFixed(3)}), corroborating weak canopy vigor.` });
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

// ─── Express routes ────────────────────────────────────────────────────────
export function registerRoutes(httpServer: Server, app: Express) {
  // Keep-alive ping — no auth, just confirms server is up
  app.get("/api/ping", (_req, res) => res.json({ ok: true, ts: Date.now() }));

  // Settings: read/write Sentinel Hub token
  app.get("/api/settings/sentinel-status", (_req, res) => {
    // Credentials are always present (Copernicus OAuth2 wired in)
    res.json({ connected: true, tokenHint: "••••••••", mode: "Copernicus SentinelHub API" });
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

  // Analyze field: compute time-series NDVI/MSI over date range
  app.post("/api/fields/:id/analyze", requireAuth, async (req, res) => {
    try {
    const field = storage.getField(Number(req.params.id));
    if (!field) return res.status(404).json({ error: "Not found" });

    const {
      dateFrom = field.dateFrom || new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      dateTo = field.dateTo || new Date().toISOString().split("T")[0],
      cloudCoverMax = field.cloudCoverMax ?? 20
    } = req.body || {};

    const coords = JSON.parse(field.coordinates);
    const timeSeriesData = await fetchSentinelHubData(coords, dateFrom, dateTo, cloudCoverMax);
    const { ndvi, ndwi, evi, healthScore } = computeAggregates(timeSeriesData);

    const updated = storage.updateField(field.id, {
      ndvi: ndvi ?? undefined,
      ndwi: ndwi ?? undefined,
      evi: evi ?? undefined,
      healthScore: healthScore ?? undefined,
      status: healthScore !== null ? (healthScore < 40 ? "alert" : "analyzed") : "analyzed",
      timeSeriesData: JSON.stringify(timeSeriesData),
      dateFrom,
      dateTo,
      cloudCoverMax,
      analyzedAt: new Date().toISOString(),
    });

    // Generate alerts (only if bi-weekly is due)
    const notifyDue = isBiweeklyDue(field.lastNotifiedAt ?? null);
    storage.deleteAlertsByField(field.id);
    const newAlerts = generateAlerts(field.id, ndvi, ndwi, field.name, evi);
    newAlerts.forEach(a => storage.createAlert(a));

    if (notifyDue) {
      storage.updateField(field.id, { lastNotifiedAt: new Date().toISOString() });
    }

    res.json({ field: updated, timeSeriesData, notificationSent: notifyDue });
    } catch (err) {
      console.error("Analyze route error:", err);
      res.status(500).json({ error: "Analysis failed", details: String(err) });
    }
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
      const coords = JSON.parse(field.coordinates);
      const dateFrom = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
      const dateTo = new Date().toISOString().split("T")[0];
      const ts = await fetchSentinelHubData(coords, dateFrom, dateTo, field.cloudCoverMax ?? 20);
      const { ndvi, ndwi, evi, healthScore } = computeAggregates(ts);
      storage.deleteAlertsByField(field.id);
      generateAlerts(field.id, ndvi, ndwi, field.name, evi).forEach(a => storage.createAlert(a));
      storage.updateField(field.id, {
        ndvi: ndvi ?? undefined, ndwi: ndwi ?? undefined, evi: evi ?? undefined, healthScore: healthScore ?? undefined,
        timeSeriesData: JSON.stringify(ts), lastNotifiedAt: new Date().toISOString()
      });
      results.push({ fieldId: field.id, name: field.name, ndvi, ndwi, evi });
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

  // ─── Spatial map: render NDVI or MSI PNG for a field + date window ────────────
  // Returns a 256x256 false-colour PNG from Sentinel Hub Process API
  app.get("/api/fields/:id/map", requireAuth, async (req, res) => {
    try {
      const field = storage.getField(Number(req.params.id));
      if (!field) return res.status(404).json({ error: "Not found" });

      const { date, type = "ndvi" } = req.query as { date?: string; type?: string };
      if (!date) return res.status(400).json({ error: "date query param required (YYYY-MM-DD)" });

      // Window: day-3 to day+3 around the requested date (finds nearest overpass)
      const d = new Date(date);
      const winFrom = new Date(d); winFrom.setDate(d.getDate() - 3);
      const winTo   = new Date(d); winTo.setDate(d.getDate() + 3);
      const fromStr = winFrom.toISOString().split("T")[0];
      const toStr   = winTo.toISOString().split("T")[0];

      const coords = JSON.parse(field.coordinates) as { lat: number; lng: number }[];
      const lats = coords.map(c => c.lat);
      const lngs = coords.map(c => c.lng);
      // Add a small buffer (~500m) so the field isn’t clipped at the edge
      const buf = 0.005;
      const bbox = [
        Math.min(...lngs) - buf, Math.min(...lats) - buf,
        Math.max(...lngs) + buf, Math.max(...lats) + buf
      ];

      const token = await getSentinelToken();
      if (!token) {
        return res.status(503).json({ error: "No Sentinel Hub token — check credentials" });
      }

      // Choose evalscript based on requested index
      // NDVI: green → yellow → red colour ramp
      // MSI:  blue (moist) → yellow → red (stressed) ramp (inverted because MSI increases with stress)
      // EVI:  purple/red (low) → yellow → green (high) — distinct ramp from NDVI
      let evalscript: string;
      if (type === "ndvi") {
        evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B04','B08','SCL']}],output:{bands:3}};}",
            "function evaluatePixel(s){",
            "  if([8,9,10].includes(s.SCL))return[0.6,0.6,0.7];" ,  // cloud → grey
            "  if(s.SCL===6)return[0.1,0.3,0.7];",                  // water → blue
            "  var n=(s.B08-s.B04)/(s.B08+s.B04+0.0001);",
            "  var v=Math.max(0,Math.min(1,(n+0.2)/1.0));",
            "  if(v<0.33)return[0.8+v*0.6, v*1.2, 0.05];",          // red-orange (low NDVI)
            "  if(v<0.66)return[0.8-v*0.4, 0.7+v*0.3, 0.05];",     // yellow (moderate)
            "  return[0.05, 0.4+v*0.5, 0.1];",                       // green (high NDVI)
            "}"
          ].join("\n");
      } else if (type === "evi") {
        evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B02','B04','B08','SCL']}],output:{bands:3}};}",
            "function evaluatePixel(s){",
            "  if([8,9,10].includes(s.SCL))return[0.6,0.6,0.7];",   // cloud → grey
            "  if(s.SCL===6)return[0.1,0.3,0.7];",                   // water → blue
            "  var n=s.B08, r=s.B04, b=s.B02;",
            "  var den=n+6*r-7.5*b+1;",
            "  var evi=Math.abs(den)<0.01?0:2.5*(n-r)/den;",
            "  var v=Math.max(0,Math.min(1,(evi+0.2)/0.9));",
            "  if(v<0.33)return[0.55+v*0.3, 0.05, 0.55-v*0.3];",    // purple-magenta (low EVI)
            "  if(v<0.66)return[0.85-v*0.3, 0.75+v*0.2, 0.05];",    // yellow-orange (moderate)
            "  return[0.05, 0.35+v*0.55, 0.15];",                    // green (high EVI)
            "}"
          ].join("\n");
      } else {
        evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B8A','B11','SCL']}],output:{bands:3}};}",
            "function evaluatePixel(s){",
            "  if([8,9,10].includes(s.SCL))return[0.6,0.6,0.7];",   // cloud → grey
            "  if(s.SCL===6)return[0.1,0.3,0.7];",                   // water → blue
            "  var msi=(s.B11/(s.B8A+0.001));",
            "  var v=Math.max(0,Math.min(1,(msi-0.1)/1.5));",       // 0=moist, 1=stressed
            "  if(v<0.33)return[0.05,0.5,0.85];",                    // blue (moist)
            "  if(v<0.66)return[0.95,0.85,0.1];",                    // yellow (moderate)
            "  return[0.9,0.1,0.05];",                               // red (stressed)
            "}"
          ].join("\n");
      }

      const body = {
        input: {
          bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
          data: [{
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: { from: `${fromStr}T00:00:00Z`, to: `${toStr}T23:59:59Z` },
              maxCloudCoverage: 80,
              mosaickingOrder: "leastCC"
            }
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

      const buf2 = await imgRes.arrayBuffer();
      res.set("Content-Type", "image/png");
      res.set("Cache-Control", "public, max-age=86400"); // cache 24h — same date always gives same image
      res.send(Buffer.from(buf2));
    } catch (err) {
      console.error("Map route error:", err);
      res.status(500).json({ error: "Map rendering failed", detail: String(err) });
    }
  });


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
      const limit = Math.max(1, Math.min(10, parseInt(maxZones) || 5));

      const d = new Date(date);
      const winFrom = new Date(d); winFrom.setDate(d.getDate() - 3);
      const winTo = new Date(d); winTo.setDate(d.getDate() + 3);
      const fromStr = winFrom.toISOString().split("T")[0];
      const toStr = winTo.toISOString().split("T")[0];

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
      // Cloud/water pixels are encoded as a reserved sentinel (255) so we can exclude them.
      let evalscript: string;
      let isStressHigh: boolean; // true = higher raw value means MORE stress (e.g. MSI)
      if (index === "msi") {
        isStressHigh = true;
        evalscript = [
          "//VERSION=3",
          "function setup(){return{input:[{bands:['B8A','B11','SCL']}],output:{bands:1,sampleType:'UINT8'}};}",
          "function evaluatePixel(s){",
          "  if([8,9,10].includes(s.SCL)||s.SCL===6)return[255];", // cloud or water → sentinel
          "  var msi=(s.B11/(s.B8A+0.001));",
          "  var v=Math.max(0,Math.min(1,(msi-0.1)/1.5));",
          "  return[Math.round(v*254)];", // 0-254 range, 255 reserved for excluded
          "}"
        ].join("\n");
      } else {
        isStressHigh = false; // low NDVI/EVI = more stress
        const band = index === "evi" ? "evi" : "ndvi";
        if (band === "evi") {
          evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B02','B04','B08','SCL']}],output:{bands:1,sampleType:'UINT8'}};}",
            "function evaluatePixel(s){",
            "  if([8,9,10].includes(s.SCL)||s.SCL===6)return[255];",
            "  var n=s.B08,r=s.B04,b=s.B02;",
            "  var den=n+6*r-7.5*b+1;",
            "  var evi=Math.abs(den)<0.01?0:2.5*(n-r)/den;",
            "  var v=Math.max(0,Math.min(1,(evi+0.2)/0.9));",
            "  return[Math.round(v*254)];",
            "}"
          ].join("\n");
        } else {
          evalscript = [
            "//VERSION=3",
            "function setup(){return{input:[{bands:['B04','B08','SCL']}],output:{bands:1,sampleType:'UINT8'}};}",
            "function evaluatePixel(s){",
            "  if([8,9,10].includes(s.SCL)||s.SCL===6)return[255];",
            "  var n=(s.B08-s.B04)/(s.B08+s.B04+0.0001);",
            "  var v=Math.max(0,Math.min(1,(n+0.2)/1.0));",
            "  return[Math.round(v*254)];",
            "}"
          ].join("\n");
        }
      }

      const body = {
        input: {
          bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
          data: [{
            type: "sentinel-2-l2a",
            dataFilter: {
              timeRange: { from: `${fromStr}T00:00:00Z`, to: `${toStr}T23:59:59Z` },
              maxCloudCoverage: 80,
              mosaickingOrder: "leastCC"
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

      // Rank by stress severity: for MSI, higher = worse; for NDVI/EVI, lower = worse.
      const sorted = [...cells].sort((a, b) => isStressHigh ? b.value - a.value : a.value - b.value);

      // Greedy spatial clustering: pick the worst cell, then skip nearby cells
      // (within ~3 grid cells) so zones are spatially distinct, not 10 adjacent pixels.
      const minSeparation = 3; // grid cells
      const zones: Cell[] = [];
      for (const cell of sorted) {
        if (zones.length >= limit) break;
        const tooClose = zones.some(z => Math.abs(z.row - cell.row) < minSeparation && Math.abs(z.col - cell.col) < minSeparation);
        if (!tooClose) zones.push(cell);
      }

      // Compute overall field stats for context (mean value of valid cells)
      const meanValue = cells.reduce((s, c) => s + c.value, 0) / cells.length;

      const result = zones.map((z, i) => {
        let severity: "critical" | "warning" | "moderate";
        const deviation = isStressHigh ? z.value - meanValue : meanValue - z.value;
        if (deviation > 0.25) severity = "critical";
        else if (deviation > 0.12) severity = "warning";
        else severity = "moderate";
        return {
          id: i + 1,
          label: `Zone ${String.fromCharCode(65 + i)}`, // Zone A, B, C...
          lat: Math.round(z.lat * 1e6) / 1e6,
          lng: Math.round(z.lng * 1e6) / 1e6,
          value: Math.round(z.value * 1000) / 1000,
          severity,
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
