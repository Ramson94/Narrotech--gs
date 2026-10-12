import { useState, useEffect, useRef, useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, runAnalyzeJob } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useLocation } from "wouter";
import {
  MapPin, SatelliteDish, Info, CheckCircle2, CalendarRange, Cloud,
  PencilLine, Upload, KeyboardIcon, Trash2, Undo2
} from "lucide-react";
import { useAuth } from "@/lib/auth";

// ── Constants ──────────────────────────────────────────────────────────────
const GHANA_REGIONS = [
  { label: "Ashanti Region", value: "ashanti" },
  { label: "Brong-Ahafo Region", value: "brong-ahafo" },
  { label: "Central Region", value: "central" },
  { label: "Eastern Region", value: "eastern" },
  { label: "Greater Accra Region", value: "greater-accra" },
  { label: "Northern Region", value: "northern" },
  { label: "Upper East Region", value: "upper-east" },
  { label: "Upper West Region", value: "upper-west" },
  { label: "Volta Region", value: "volta" },
  { label: "Western Region", value: "western" },
  { label: "Bono East Region", value: "bono-east" },
  { label: "Ahafo Region", value: "ahafo" },
  { label: "Savannah Region", value: "savannah" },
  { label: "North East Region", value: "north-east" },
  { label: "Oti Region", value: "oti" },
  { label: "Western North Region", value: "western-north" },
];

const CROP_TYPES = [
  { label: "Maize / Corn", value: "maize" },
  { label: "Cocoa", value: "cocoa" },
  { label: "Cassava", value: "cassava" },
  { label: "Yam", value: "yam" },
  { label: "Plantain", value: "plantain" },
  { label: "Rice", value: "rice" },
  { label: "Groundnut", value: "groundnut" },
  { label: "Sorghum", value: "sorghum" },
  { label: "Tomato", value: "tomato" },
  { label: "Pepper", value: "pepper" },
  { label: "Other", value: "other" },
];

const QUICK_FILL = [
  {
    name: "Kumasi Maize Plot",
    region: "ashanti", cropType: "maize",
    coords: [{ lat: 6.6885, lng: -1.6244 }, { lat: 6.6885, lng: -1.6194 }, { lat: 6.6835, lng: -1.6194 }, { lat: 6.6835, lng: -1.6244 }],
  },
  {
    name: "Volta Cocoa Farm",
    region: "volta", cropType: "cocoa",
    coords: [{ lat: 6.9, lng: 0.31 }, { lat: 6.9, lng: 0.32 }, { lat: 6.91, lng: 0.32 }, { lat: 6.91, lng: 0.31 }],
  },
  {
    name: "Northern Rice Field",
    region: "northern", cropType: "rice",
    coords: [{ lat: 9.4075, lng: -0.8533 }, { lat: 9.4075, lng: -0.8483 }, { lat: 9.4025, lng: -0.8483 }, { lat: 9.4025, lng: -0.8533 }],
  },
];

const CORNER_LABELS = ["NW (Top-Left)", "NE (Top-Right)", "SE (Bottom-Right)", "SW (Bottom-Left)"];

type InputMode = "manual" | "draw" | "upload";
type LatLng = { lat: number; lng: number };
type CoordStr = { lat: string; lng: string };

function getDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  return { from: from.toISOString().split("T")[0], to: to.toISOString().split("T")[0] };
}

// ── GeoJSON → flat coordinate array ────────────────────────────────────────
function extractCoordsFromGeoJSON(gj: any): LatLng[] | null {
  try {
    let features: any[] = [];
    if (gj.type === "FeatureCollection") features = gj.features;
    else if (gj.type === "Feature") features = [gj];
    else if (gj.type === "Polygon" || gj.type === "MultiPolygon") features = [{ geometry: gj }];

    // find first polygon geometry
    for (const f of features) {
      const geom = f.geometry || f;
      if (!geom) continue;
      let ring: number[][] | null = null;
      if (geom.type === "Polygon") ring = geom.coordinates[0];
      else if (geom.type === "MultiPolygon") ring = geom.coordinates[0][0];
      if (ring && ring.length >= 3) {
        // GeoJSON is [lng, lat] — convert, drop closing duplicate
        const pts = ring.slice(0, ring[0][0] === ring[ring.length-1][0] && ring[0][1] === ring[ring.length-1][1]
          ? ring.length - 1 : ring.length)
          .map(([lng, lat]) => ({ lat, lng }));
        return pts;
      }
    }
  } catch {}
  return null;
}

export default function FieldAnalysis() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { user } = useAuth();

  const mapRef = useRef<any>(null);
  const polygonLayerRef = useRef<any>(null);
  const drawnLayerRef = useRef<any>(null); // Leaflet.Draw drawn items group
  const fileInputRef = useRef<HTMLInputElement>(null);

  const defaults = getDefaultDates();
  const [inputMode, setInputMode] = useState<InputMode>("manual");
  const [fieldName, setFieldName] = useState("");
  const [region, setRegion] = useState("");
  const [cropType, setCropType] = useState("");
  const [notes, setNotes] = useState("");
  const [dateFrom, setDateFrom] = useState(defaults.from);
  const [dateTo, setDateTo] = useState(defaults.to);

  // Shared polygon state — array of LatLng (the "truth")
  const [polygon, setPolygon] = useState<LatLng[]>([]);

  // Manual mode: 4 corner string inputs
  const [coords, setCoords] = useState<CoordStr[]>([
    { lat: "", lng: "" }, { lat: "", lng: "" }, { lat: "", lng: "" }, { lat: "", lng: "" },
  ]);

  const [mapReady, setMapReady] = useState(false);
  const [drawMode, setDrawMode] = useState(false); // draw mode active in Leaflet.Draw
  const [uploadFileName, setUploadFileName] = useState<string>("");
  const [uploadError, setUploadError] = useState<string>("");
  const [uploadLoading, setUploadLoading] = useState(false);

  // ── Map init ────────────────────────────────────────────────────────────
  useEffect(() => {
    // Load Leaflet CSS
    if (!document.getElementById("leaflet-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-css";
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      document.head.appendChild(link);
    }
    // Load Leaflet.Draw CSS
    if (!document.getElementById("leaflet-draw-css")) {
      const link = document.createElement("link");
      link.id = "leaflet-draw-css";
      link.rel = "stylesheet";
      link.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.css";
      document.head.appendChild(link);
    }

    const loadScript = (src: string, id: string): Promise<void> => new Promise((resolve) => {
      if (document.getElementById(id)) { resolve(); return; }
      const s = document.createElement("script");
      s.id = id; s.src = src;
      s.onload = () => resolve();
      document.head.appendChild(s);
    });

    // Load Leaflet then Leaflet.Draw sequentially
    loadScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "leaflet-js")
      .then(() => loadScript("https://cdnjs.cloudflare.com/ajax/libs/leaflet.draw/1.0.4/leaflet.draw.js", "leaflet-draw-js"))
      .then(() => setMapReady(true));
  }, []);

  useEffect(() => {
    if (!mapReady) return;
    const L = (window as any).L;
    if (!L || mapRef.current) return;

    const map = L.map("field-map", { center: [7.9528, -1.0307], zoom: 7 });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
    }).addTo(map);

    // Drawn items layer
    const drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);
    drawnLayerRef.current = drawnItems;

    // Listen for drawn polygon
    map.on(L.Draw.Event.CREATED, (e: any) => {
      drawnItems.clearLayers();
      drawnItems.addLayer(e.layer);
      const latlngs: any[] = e.layer.getLatLngs()[0];
      const pts: LatLng[] = latlngs.map((ll: any) => ({ lat: ll.lat, lng: ll.lng }));
      setPolygon(pts);
      setDrawMode(false);
      toast({ title: `Polygon drawn — ${pts.length} vertices captured` });
    });

    // Listen for edit
    map.on(L.Draw.Event.EDITED, (e: any) => {
      e.layers.eachLayer((layer: any) => {
        const latlngs: any[] = layer.getLatLngs()[0];
        setPolygon(latlngs.map((ll: any) => ({ lat: ll.lat, lng: ll.lng })));
      });
    });

    map.on(L.Draw.Event.DELETED, () => {
      setPolygon([]);
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      drawnLayerRef.current = null;
    };
  }, [mapReady]);

  // ── Sync polygon display on map ──────────────────────────────────────────
  useEffect(() => {
    const L = (window as any).L;
    const map = mapRef.current;
    if (!L || !map) return;

    // Remove old static polygon preview
    if (polygonLayerRef.current) {
      map.removeLayer(polygonLayerRef.current);
      polygonLayerRef.current = null;
    }

    if (polygon.length < 3) return;

    const latlngs = polygon.map(p => [p.lat, p.lng]);
    const poly = L.polygon(latlngs, {
      color: "#1E6FA3", weight: 2.5, fillColor: "#1E6FA3", fillOpacity: 0.18,
      dashArray: inputMode === "upload" ? "6 3" : undefined,
    }).addTo(map);
    polygonLayerRef.current = poly;
    map.fitBounds(poly.getBounds(), { padding: [32, 32] });
  }, [polygon, inputMode]);

  // ── Sync manual coords → polygon ─────────────────────────────────────────
  useEffect(() => {
    if (inputMode !== "manual") return;
    const valid = coords.every(c =>
      c.lat && c.lng && !isNaN(parseFloat(c.lat)) && !isNaN(parseFloat(c.lng))
    );
    if (valid) {
      setPolygon(coords.map(c => ({ lat: parseFloat(c.lat), lng: parseFloat(c.lng) })));
    } else {
      setPolygon([]);
    }
  }, [coords, inputMode]);

  // ── Draw polygon helper ───────────────────────────────────────────────────
  const startDraw = useCallback(() => {
    const L = (window as any).L;
    const map = mapRef.current;
    if (!L || !map || !L.Draw) return;
    setDrawMode(true);
    // Clear previous drawn items
    if (drawnLayerRef.current) drawnLayerRef.current.clearLayers();
    setPolygon([]);
    const drawHandler = new L.Draw.Polygon(map, {
      shapeOptions: { color: "#1E6FA3", fillOpacity: 0.18 },
      showArea: true,
      metric: true,
    });
    drawHandler.enable();
  }, []);

  const clearDraw = useCallback(() => {
    if (drawnLayerRef.current) drawnLayerRef.current.clearLayers();
    if (polygonLayerRef.current) {
      mapRef.current?.removeLayer(polygonLayerRef.current);
      polygonLayerRef.current = null;
    }
    setPolygon([]);
    setDrawMode(false);
  }, []);

  // ── File upload: GeoJSON / Shapefile / GeoPackage ────────────────────────
  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadError("");
    setUploadLoading(true);
    setUploadFileName(file.name);

    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";

    try {
      let pts: LatLng[] | null = null;

      if (ext === "geojson" || ext === "json") {
        // ── GeoJSON ───────────────────────────────────────────────────────
        const text = await file.text();
        const gj = JSON.parse(text);
        pts = extractCoordsFromGeoJSON(gj);
      } else if (ext === "zip" || ext === "shp") {
        // ── Shapefile (as .zip containing .shp/.dbf/.prj, or raw .shp) ───
        const shpjs = await import("shpjs");
        const buf = await file.arrayBuffer();
        const gj = await (shpjs.default || shpjs)(buf);
        pts = extractCoordsFromGeoJSON(gj);
      } else if (ext === "gpkg") {
        // ── GeoPackage — parse via SQLite WASM ────────────────────────────
        // GeoPackage is an SQLite file; we can't run SQLite in browser without
        // a heavy WASM lib. We handle by instructing the user to export to GeoJSON first.
        setUploadError("GeoPackage files require conversion to GeoJSON first. In QGIS: right-click layer → Export → Save Features As → GeoJSON. Or in ArcGIS: export to GeoJSON.");
        setUploadLoading(false);
        return;
      } else {
        setUploadError("Unsupported file type. Use .geojson, .zip (Shapefile), or export .gpkg to GeoJSON first.");
        setUploadLoading(false);
        return;
      }

      if (!pts || pts.length < 3) {
        setUploadError("No valid polygon found in this file. Make sure it contains at least one Polygon geometry.");
        setUploadLoading(false);
        return;
      }

      // Clamp to reasonable vertex count (keep every Nth point if > 50)
      let finalPts = pts;
      if (pts.length > 50) {
        const step = Math.ceil(pts.length / 30);
        finalPts = pts.filter((_, i) => i % step === 0);
        toast({ title: `Large polygon simplified to ${finalPts.length} vertices` });
      }

      setPolygon(finalPts);
      toast({ title: `${file.name} loaded — ${finalPts.length} vertices` });
    } catch (err: any) {
      console.error("[FileUpload]", err);
      setUploadError(`Failed to parse file: ${err?.message ?? "unknown error"}. Make sure Shapefiles are in a .zip archive.`);
    }

    setUploadLoading(false);
    // reset input so re-uploading same file triggers onChange
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [toast]);

  // ── Coord input helpers (manual mode) ─────────────────────────────────────
  const setCoord = (idx: number, field: "lat" | "lng", val: string) => {
    const normalized = val
      .replace(/,/g, ".")
      .replace(/[^0-9.\-]/g, "")
      .replace(/(?!^)-/g, "");
    setCoords(c => c.map((coord, i) => i === idx ? { ...coord, [field]: normalized } : coord));
  };

  const isValidCoord = (val: string, min: number, max: number) => {
    if (!val || val === "-" || val === ".") return false;
    const n = parseFloat(val.replace(",", "."));
    return !isNaN(n) && n >= min && n <= max;
  };
  const allManualValid = coords.every(c =>
    isValidCoord(c.lat, -90, 90) && isValidCoord(c.lng, -180, 180)
  );

  const applyQuickFill = (qf: typeof QUICK_FILL[0]) => {
    setFieldName(qf.name);
    setRegion(qf.region);
    setCropType(qf.cropType);
    setCoords(qf.coords.map(c => ({ lat: String(c.lat), lng: String(c.lng) })));
    setInputMode("manual");
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const canSubmit = fieldName.trim() && polygon.length >= 3;

  const createMutation = useMutation({
    mutationFn: async () => {
      const field = await apiRequest("POST", "/api/fields", {
        name: fieldName, region, cropType,
        coordinates: JSON.stringify(polygon),
        notes, dateFrom, dateTo,
      }).then(r => r.json());
      await runAnalyzeJob(field.id, { dateFrom, dateTo });
      return field;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Field added & analyzed!", description: "Sentinel-2 time-series data processed." });
      navigate("/timeseries");
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast({ title: "Error", description: msg || "Check coordinates and try again.", variant: "destructive" });
    },
  });

  // ── Render ─────────────────────────────────────────────────────────────────
  const modeTab = (mode: InputMode, icon: any, label: string, desc: string) => (
    <button
      onClick={() => { setInputMode(mode); setPolygon([]); setUploadError(""); setUploadFileName(""); }}
      className={`flex-1 flex flex-col items-center gap-1.5 p-3 rounded-xl border-2 text-center transition-all ${
        inputMode === mode
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border text-muted-foreground hover:border-primary/40 hover:bg-muted/50"
      }`}
      data-testid={`tab-mode-${mode}`}
    >
      <span className={inputMode === mode ? "text-primary" : ""}>{icon}</span>
      <span className="text-xs font-semibold">{label}</span>
      <span className="text-[10px] leading-tight">{desc}</span>
    </button>
  );

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Add & Analyze a Field</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Define your field boundary three ways — type coordinates, draw directly on the map, or import a GeoJSON / Shapefile.
          NDVI and MSI are then computed from bi-weekly Sentinel-2 passes.
        </p>
      </div>

      {/* Quick-fill */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Info size={14} className="text-primary" />
            Quick-fill — Ghana sample fields
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {QUICK_FILL.map(qf => (
            <Button key={qf.name} variant="outline" size="sm" className="text-xs gap-1"
              onClick={() => applyQuickFill(qf)}
              data-testid={`button-quickfill-${qf.name.toLowerCase().replace(/\s/g, "-")}`}>
              <MapPin size={11} /> {qf.name}
            </Button>
          ))}
        </CardContent>
      </Card>

      <div className="grid md:grid-cols-2 gap-6">
        {/* ── Left: Form ────────────────────────────────────────────────── */}
        <div className="space-y-4">
          {/* Field info */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Field Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="field-name">Field Name *</Label>
                <Input id="field-name" data-testid="input-field-name"
                  placeholder="e.g. Kumasi North Plot"
                  value={fieldName} onChange={e => setFieldName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>Region</Label>
                <Select value={region} onValueChange={setRegion}>
                  <SelectTrigger data-testid="select-region">
                    <SelectValue placeholder="Select Ghana region" />
                  </SelectTrigger>
                  <SelectContent>
                    {GHANA_REGIONS.map(r => <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Crop Type</Label>
                <Select value={cropType} onValueChange={setCropType}>
                  <SelectTrigger data-testid="select-crop-type">
                    <SelectValue placeholder="Select crop" />
                  </SelectTrigger>
                  <SelectContent>
                    {CROP_TYPES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="notes">Notes (optional)</Label>
                <Input id="notes" data-testid="input-notes"
                  placeholder="Additional notes" value={notes} onChange={e => setNotes(e.target.value)} />
              </div>
            </CardContent>
          </Card>

          {/* Date range + cloud cover */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarRange size={15} className="text-primary" /> Analysis Period
              </CardTitle>
              <CardDescription className="text-xs">
                Set the time window. Sentinel-2 passes every ~5 days; with cloud filtering you get ~2 clean images per 2 weeks.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="date-from" className="text-xs">Start Date</Label>
                  <Input type="date" id="date-from" data-testid="input-date-from"
                    value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="text-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="date-to" className="text-xs">End Date</Label>
                  <Input type="date" id="date-to" data-testid="input-date-to"
                    value={dateTo} onChange={e => setDateTo(e.target.value)} className="text-sm" />
                </div>
              </div>
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <Cloud size={11} className="mt-0.5 flex-shrink-0" />
                Only Sentinel-2 images with 20% or less cloud over this field are used.
              </p>
            </CardContent>
          </Card>

          {/* ── Boundary input mode selector ─────────────────────────────── */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Field Boundary</CardTitle>
              <CardDescription className="text-xs">
                Choose how to define your field polygon.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Mode tabs */}
              <div className="flex gap-2">
                {modeTab("manual",
                  <KeyboardIcon size={16} />,
                  "Type Coordinates",
                  "Enter 4 corner lat/lng"
                )}
                {modeTab("draw",
                  <PencilLine size={16} />,
                  "Draw on Map",
                  "Click to trace polygon"
                )}
                {modeTab("upload",
                  <Upload size={16} />,
                  "Upload File",
                  "GeoJSON or Shapefile"
                )}
              </div>

              {/* ── Manual input ─────────────────────────────────────────── */}
              {inputMode === "manual" && (
                <div className="space-y-3">
                  {coords.map((coord, idx) => (
                    <div key={idx} className="space-y-1">
                      <Label className="text-xs text-muted-foreground">{CORNER_LABELS[idx]}</Label>
                      <div className="flex gap-2">
                        <Input data-testid={`input-lat-${idx}`} placeholder="Latitude e.g. 6.6885"
                          value={coord.lat} onChange={e => setCoord(idx, "lat", e.target.value)}
                          inputMode="decimal" autoComplete="off" autoCorrect="off" spellCheck={false}
                          className="font-mono text-sm" />
                        <Input data-testid={`input-lng-${idx}`} placeholder="e.g. -1.6244 (West=neg)"
                          value={coord.lng} onChange={e => setCoord(idx, "lng", e.target.value)}
                          inputMode="text" autoComplete="off" autoCorrect="off" spellCheck={false}
                          className="font-mono text-sm" />
                      </div>
                    </div>
                  ))}
                  {allManualValid && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 size={12} /> All 4 corners valid
                    </p>
                  )}
                </div>
              )}

              {/* ── Draw mode ─────────────────────────────────────────────── */}
              {inputMode === "draw" && (
                <div className="space-y-3">
                  <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3 text-sm text-center space-y-2">
                    <PencilLine size={20} className="mx-auto text-primary" />
                    <p className="font-medium text-foreground">Draw your field on the map</p>
                    <p className="text-xs text-muted-foreground">
                      Click the button below, then click on the map to place vertices.<br />
                      Double-click to close and finish the polygon.
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      onClick={startDraw}
                      disabled={drawMode || !mapReady}
                      className="flex-1 gap-2"
                      variant={drawMode ? "outline" : "default"}
                      data-testid="button-start-draw"
                    >
                      <PencilLine size={14} />
                      {drawMode ? "Drawing… click map to add points" : "Start Drawing Polygon"}
                    </Button>
                    {polygon.length >= 3 && (
                      <Button variant="ghost" size="icon" onClick={clearDraw} title="Clear polygon" data-testid="button-clear-draw">
                        <Trash2 size={14} className="text-red-500" />
                      </Button>
                    )}
                  </div>
                  {polygon.length >= 3 && (
                    <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                      <CheckCircle2 size={12} /> Polygon drawn — {polygon.length} vertices
                    </p>
                  )}
                </div>
              )}

              {/* ── Upload mode ───────────────────────────────────────────── */}
              {inputMode === "upload" && (
                <div className="space-y-3">
                  <div
                    className="rounded-xl border-2 border-dashed border-primary/30 bg-primary/5 p-5 text-center cursor-pointer hover:border-primary/60 hover:bg-primary/10 transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.currentTarget.classList.add("border-primary"); }}
                    onDragLeave={e => e.currentTarget.classList.remove("border-primary")}
                    onDrop={e => {
                      e.preventDefault();
                      e.currentTarget.classList.remove("border-primary");
                      const file = e.dataTransfer.files[0];
                      if (file && fileInputRef.current) {
                        const dt = new DataTransfer();
                        dt.items.add(file);
                        fileInputRef.current.files = dt.files;
                        fileInputRef.current.dispatchEvent(new Event("change", { bubbles: true }));
                      }
                    }}
                    data-testid="drop-zone-upload"
                  >
                    <Upload size={22} className="mx-auto mb-2 text-primary" />
                    <p className="text-sm font-medium text-foreground">
                      {uploadLoading ? "Parsing file…" : uploadFileName ? uploadFileName : "Drop file here or click to browse"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Supported: <strong>.geojson</strong>, <strong>.json</strong>, <strong>.zip</strong> (Shapefile archive)
                    </p>
                    <p className="text-xs text-muted-foreground">
                      GeoPackage (.gpkg): export to GeoJSON from QGIS first
                    </p>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".geojson,.json,.zip,.gpkg"
                    className="hidden"
                    onChange={handleFileUpload}
                    data-testid="input-file-upload"
                  />

                  {uploadError && (
                    <div className="rounded-lg bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/40 p-3 text-xs text-red-700 dark:text-red-400">
                      {uploadError}
                    </div>
                  )}

                  {polygon.length >= 3 && !uploadError && (
                    <div className="flex items-center justify-between">
                      <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                        <CheckCircle2 size={12} /> {polygon.length} vertices loaded from {uploadFileName}
                      </p>
                      <Button variant="ghost" size="sm" className="text-xs gap-1 text-red-500 h-6"
                        onClick={() => { setPolygon([]); setUploadFileName(""); setUploadError(""); }}>
                        <Undo2 size={10} /> Clear
                      </Button>
                    </div>
                  )}

                  {/* How-to tip */}
                  <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground space-y-1">
                    <p className="font-medium text-foreground">How to export from common tools:</p>
                    <p>• <strong>QGIS:</strong> Right-click layer → Export → Save Features As → GeoJSON</p>
                    <p>• <strong>ArcGIS:</strong> Right-click layer → Data → Export Features → format: GeoJSON</p>
                    <p>• <strong>Google Earth:</strong> Save Place As → .kml, then convert to GeoJSON at <a href="https://mygeodata.cloud/converter" target="_blank" rel="noopener" className="underline text-primary">mygeodata.cloud</a></p>
                    <p>• <strong>Shapefile:</strong> Zip the .shp, .dbf, .prj files together before uploading</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Button className="w-full gap-2" size="lg"
            disabled={!canSubmit || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="button-analyze-field"
          >
            <SatelliteDish size={16} className={createMutation.isPending ? "animate-pulse" : ""} />
            {createMutation.isPending ? "Processing Sentinel-2 data…" : "Analyze with Sentinel-2"}
          </Button>

          {!canSubmit && fieldName && polygon.length < 3 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 text-center">
              {inputMode === "manual" ? "Enter all 4 corner coordinates above."
                : inputMode === "draw" ? "Draw a polygon on the map first."
                : "Upload a GeoJSON or Shapefile to define the field boundary."}
            </p>
          )}
        </div>

        {/* ── Right: Map ────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-foreground">
            Field Preview Map
            {inputMode === "draw" && drawMode && (
              <span className="ml-2 text-xs font-normal text-primary animate-pulse">● Click to add vertices · Double-click to finish</span>
            )}
          </p>
          <div
            id="field-map"
            className="rounded-lg border border-border overflow-hidden"
            style={{ height: "420px" }}
          />
          {polygon.length >= 3 && (
            <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={12} />
              Polygon visible on map · {polygon.length} vertices
            </p>
          )}
          {polygon.length < 3 && (
            <p className="text-xs text-muted-foreground">
              {inputMode === "draw"
                ? "Click 'Start Drawing Polygon', then click on the map."
                : inputMode === "upload"
                ? "Upload a GeoJSON / Shapefile — polygon will appear here."
                : "Polygon appears once all 4 corners are entered."}
            </p>
          )}

          {/* Analysis outputs reminder */}
          <Card className="bg-muted/40">
            <CardContent className="p-3 space-y-2">
              <p className="text-xs font-medium text-foreground">What this analysis produces:</p>
              <ul className="text-xs text-muted-foreground space-y-1.5">
                {[
                  "NDVI from Sentinel-2 Red (B04) + NIR (B08) bands",
                  "MSI from SWIR (B11) / NIR (B8A) — open water pixels excluded",
                  "One image per 14-day window across your date range",
                  "Only images with ≤20% cloud over the field; if a window has none, the nearest such image up to 7 days away",
                  "Cloud, cirrus and cloud-shadow pixels removed from every average and map",
                  "Dual NDVI + MSI time-series chart",
                  "Automatic crop stress alerts every 2 weeks",
                  "Spatial NDVI + MSI false-colour maps per observation date",
                ].map(item => (
                  <li key={item} className="flex items-start gap-1.5">
                    <CheckCircle2 size={11} className="text-primary mt-0.5 flex-shrink-0" />
                    {item}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
