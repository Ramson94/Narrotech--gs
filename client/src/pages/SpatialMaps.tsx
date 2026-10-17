import { useState } from "react";
import { shapeBBox, shapeFromField, type FieldShape } from "@shared/geometry";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Map, Layers, Calendar, Info, ZoomIn, Download, Share2, Check, Navigation, MapPin } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import type { Field } from "@shared/schema";
import { formatArea, spotShareText, walkingDirectionsUrl, type ProblemSpot, type SpotsResult } from "@shared/spots";

// ── Legend component ────────────────────────────────────────────────────────
function NdviLegend() {
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-2">
      <span className="font-medium text-foreground">NDVI:</span>
      {[
        { color: "#cc1a00", label: "Low (<0.2)" },
        { color: "#e87d00", label: "Poor (0.2–0.35)" },
        { color: "#d4c200", label: "Moderate (0.35–0.5)" },
        { color: "#4caf3d", label: "Good (0.5–0.65)" },
        { color: "#1a6e00", label: "Excellent (>0.65)" },
        { color: "#1a4db3", label: "Water" },
        { color: "#9aa0b0", label: "Cloud / shadow" },
      ].map(({ color, label }) => (
        <span key={label} className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm flex-shrink-0" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function MsiLegend() {
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-2">
      <span className="font-medium text-foreground">MSI:</span>
      {[
        { color: "#0d80d8", label: "Moist (<0.4)" },
        { color: "#0db8c8", label: "Adequate (0.4–0.6)" },
        { color: "#f2d600", label: "Mild stress (0.6–1.0)" },
        { color: "#f28700", label: "Moderate (1.0–1.2)" },
        { color: "#e51a00", label: "Severe (>1.2)" },
        { color: "#1a4db3", label: "Water" },
        { color: "#9aa0b0", label: "Cloud / shadow" },
      ].map(({ color, label }) => (
        <span key={label} className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm flex-shrink-0" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

// ── Project lat/lng polygon onto 0..1 image space given a bbox ──────────────
const BUF = 0.005; // must match server-side buffer (bboxOf(shape, 0.005))

// Project every ring of the field (all plots and holes) into image space and return one SVG path.
// With fill-rule "evenodd", holes stay empty.
function projectShape(shape: FieldShape, size: number = 100): string {
  const [minLng, minLat, maxLng, maxLat] = shapeBBox(shape, BUF);
  return shape.flatMap(plot => plot).map(ring =>
    "M" + ring.map(([lng, lat]) =>
      `${(((lng - minLng) / (maxLng - minLng)) * size).toFixed(2)},${(((maxLat - lat) / (maxLat - minLat)) * size).toFixed(2)}`
    ).join(" L") + " Z"
  ).join(" ");
}

// ── Clipped image with SVG polygon mask ───────────────────────────────────
function ClippedMapImage({
  imgUrl,
  shape,
  label,
  onClick,
  spots = [],
}: {
  imgUrl: string;
  shape: FieldShape;
  label: string;
  onClick: () => void;
  spots?: ProblemSpot[];
}) {
  const path = projectShape(shape);
  const [minLng, minLat, maxLng, maxLat] = shapeBBox(shape, BUF);
  const pin = (sp: ProblemSpot) => ({
    x: ((sp.lng - minLng) / (maxLng - minLng)) * 100,
    y: ((maxLat - sp.lat) / (maxLat - minLat)) * 100,
  });

  return (
    <div
      className="relative aspect-square w-full rounded-lg overflow-hidden border border-border bg-black cursor-zoom-in"
      onClick={onClick}
      aria-label={label}
    >
      {/* The server returns the map already clipped to the field: transparent outside it. */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="none"
      >
        <image href={imgUrl} x="0" y="0" width="100" height="100" preserveAspectRatio="none" />
        {/* Field outline: every plot and hole */}
        <path
          d={path}
          fillRule="evenodd"
          fill="none"
          stroke="white"
          strokeWidth="0.8"
          strokeDasharray="2 1"
          opacity="0.9"
        />
        {/* Problem spots: lettered pins matching the "Places to check" list */}
        {spots.map(sp => {
          const { x, y } = pin(sp);
          return (
            <g key={sp.label}>
              <circle cx={x} cy={y} r="3.4" fill={sp.severity === "critical" ? "#dc2626" : "#d97706"} stroke="white" strokeWidth="0.7" />
              <text x={x} y={y + 1.3} textAnchor="middle" fontSize="3.6" fontWeight="700" fill="white">{sp.label}</text>
            </g>
          );
        })}
      </svg>
      {/* Zoom hint */}
      <div className="absolute bottom-1.5 right-1.5 bg-black/50 rounded px-1.5 py-0.5 text-white text-[10px] flex items-center gap-1">
        <ZoomIn size={10} /> Zoom
      </div>
    </div>
  );
}

// ── Download a blob-URL image as PNG ──────────────────────────────────────────
async function downloadMapPng(
  imgUrl: string,
  fieldName: string,
  date: string,
  type: string,
  shape: FieldShape,
  toast: (opts: any) => void
) {
  try {
    // Fetch the blob (it's already a blob URL from useQuery)
    const res = await fetch(imgUrl);
    const blob = await res.blob();

    // Draw onto canvas with title + legend + border
    const SIZE = 512;
    const HEADER = 52;
    const FOOTER = 28;
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE + HEADER + FOOTER;
    const ctx = canvas.getContext("2d")!;

    // Background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, SIZE, SIZE + HEADER + FOOTER);

    // Header text
    const indexLabel = type === "ndvi" ? "NDVI — Vegetation Index" : "MSI — Moisture Stress Index";
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(fieldName, 16, 20);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(`${indexLabel} · ${date}`, 16, 38);

    // Draw satellite image
    const img = new window.Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        ctx.drawImage(img, 0, HEADER, SIZE, SIZE);
        resolve();
      };
      img.onerror = reject;
      img.src = imgUrl;
    });

    // Draw the field outline (every plot and hole) on the canvas
    const [minLng, minLat, maxLng, maxLat] = shapeBBox(shape, BUF);
    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    for (const ring of shape.flatMap(plot => plot)) {
      ctx.beginPath();
      ring.forEach(([lng, lat], i) => {
        const x = ((lng - minLng) / (maxLng - minLng)) * SIZE;
        const y = ((maxLat - lat) / (maxLat - minLat)) * SIZE + HEADER;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.stroke();
    }

    // Footer
    ctx.setLineDash([]);
    ctx.fillStyle = "#334155";
    ctx.fillRect(0, SIZE + HEADER, SIZE, FOOTER);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "9px system-ui, sans-serif";
    ctx.fillText(`Source: Sentinel-2 · Copernicus Data Space · narrowtechgeosolution.com · ${new Date().toLocaleDateString()}`, 10, SIZE + HEADER + 18);

    canvas.toBlob(b => {
      if (!b) return;
      const url = URL.createObjectURL(b);
      const a = document.createElement("a");
      a.href = url;
      a.download = `narrowtech-gs_${type.toUpperCase()}_${fieldName.replace(/\s+/g, "-")}_${date}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");

    toast({ title: `${indexLabel} map downloaded` });
  } catch (e) {
    console.error(e);
    toast({ title: "Download failed — try again", variant: "destructive" });
  }
}

// ── Share via Web Share API or copy link ──────────────────────────────────────
async function shareMapImage(
  imgUrl: string,
  fieldName: string,
  date: string,
  type: string,
  toast: (opts: any) => void
) {
  const title = `${fieldName} — ${type.toUpperCase()} Map · ${date}`;
  const text = `Crop health satellite map from NarrowTech GS. Field: ${fieldName}, Date: ${date}, Index: ${type.toUpperCase()}.`;

  // Try native Web Share API with file
  if (navigator.share && navigator.canShare) {
    try {
      const res = await fetch(imgUrl);
      const blob = await res.blob();
      const file = new File([blob], `narrowtech-gs-${type}-${date}.png`, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ title, text, files: [file] });
        return;
      }
    } catch (e) {
      // fall through to URL share
    }
    // Share URL fallback
    try {
      await navigator.share({ title, text, url: window.location.href });
      return;
    } catch (e) {
      // fall through to clipboard
    }
  }

  // Clipboard fallback
  try {
    await navigator.clipboard.writeText(`${title}\n${text}\n${window.location.href}`);
    toast({ title: "Link copied to clipboard", description: "Share this with anyone who has access to the app." });
  } catch {
    toast({ title: "Sharing not supported on this device", description: "Use the Download button instead." });
  }
}

// ── Single map tile ────────────────────────────────────────────────────────────────
function MapTile({
  fieldId,
  date,
  type,
  label,
  shape,
  fieldName,
  spots = [],
}: {
  fieldId: number;
  date: string;
  type: "ndvi" | "msi";
  label: string;
  shape: FieldShape;
  fieldName: string;
  spots?: ProblemSpot[];
}) {
  const [zoomed, setZoomed] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [sharing, setSharing] = useState(false);
  const { toast } = useToast();

  const { data: imgUrl, isLoading, isError } = useQuery<string>({
    queryKey: [`/api/fields/${fieldId}/map`, date, type],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/fields/${fieldId}/map?date=${date}&type=${type}`);
      if (!res.ok) throw new Error("Map render failed");
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    },
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  const handleDownload = async () => {
    if (!imgUrl) return;
    setDownloading(true);
    await downloadMapPng(imgUrl, fieldName, date, type, shape, toast);
    setDownloading(false);
  };

  const handleShare = async () => {
    if (!imgUrl) return;
    setSharing(true);
    await shareMapImage(imgUrl, fieldName, date, type, toast);
    setSharing(false);
  };

  return (
    <>
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <span className="text-xs font-semibold text-foreground uppercase tracking-wide">{label}</span>
          {imgUrl && (
            <div className="flex items-center gap-1.5">
              {/* Download PNG */}
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px] gap-1"
                onClick={handleDownload}
                disabled={downloading}
                data-testid={`button-download-map-${type}-${date}`}
              >
                <Download size={10} />
                {downloading ? "…" : "PNG"}
              </Button>
              {/* Share */}
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-[11px] gap-1"
                onClick={handleShare}
                disabled={sharing}
                data-testid={`button-share-map-${type}-${date}`}
              >
                <Share2 size={10} />
                {sharing ? "…" : "Share"}
              </Button>
              {/* Full view */}
              <button
                onClick={() => setZoomed(true)}
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
              >
                <ZoomIn size={12} /> Full view
              </button>
            </div>
          )}
        </div>

        {isLoading && (
          <div className="relative aspect-square w-full rounded-lg border border-border bg-muted flex flex-col items-center justify-center gap-2 text-muted-foreground">
            <Skeleton className="absolute inset-0 w-full h-full rounded-lg" />
            <Map size={24} className="animate-pulse relative z-10" />
            <span className="text-xs relative z-10">Fetching satellite data…</span>
          </div>
        )}
        {isError && (
          <div className="aspect-square w-full rounded-lg border border-border bg-muted/80 flex flex-col items-center justify-center gap-1 text-muted-foreground p-3 text-center">
            <Info size={20} />
            <p className="text-xs">No imagery available for this date.<br />Try a wider date range in Analyze.</p>
          </div>
        )}
        {imgUrl && (
          <ClippedMapImage
            imgUrl={imgUrl}
            shape={shape}
            label={label}
            onClick={() => setZoomed(true)}
            spots={spots}
          />
        )}

        {type === "ndvi" ? <NdviLegend /> : <MsiLegend />}
      </div>

      {/* Zoom modal — shows full unclipped image + clipped side by side */}
      {zoomed && imgUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
          onClick={() => setZoomed(false)}
        >
          <div className="relative w-full max-w-3xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <span className="text-white font-semibold text-sm">{label} — {date}</span>
              <div className="flex items-center gap-2">
                {/* Download from modal */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs bg-white/10 border-white/30 text-white hover:bg-white/20"
                  onClick={handleDownload}
                  disabled={downloading}
                >
                  <Download size={11} />
                  {downloading ? "Downloading…" : "Download PNG"}
                </Button>
                {/* Share from modal */}
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs bg-white/10 border-white/30 text-white hover:bg-white/20"
                  onClick={handleShare}
                  disabled={sharing}
                >
                  <Share2 size={11} />
                  {sharing ? "Sharing…" : "Share"}
                </Button>
                <button
                  onClick={() => setZoomed(false)}
                  className="text-white/70 hover:text-white text-xs border border-white/30 rounded px-2 py-0.5"
                >Close</button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-white/60 text-xs mb-1">Clipped to field boundary</p>
                <ClippedMapImage imgUrl={imgUrl} shape={shape} label={label} onClick={() => {}} spots={spots} />
              </div>
              <div>
                <p className="text-white/60 text-xs mb-1">Full scene context</p>
                <div className="aspect-square rounded-lg overflow-hidden border border-white/20">
                  <img src={imgUrl} alt="Full scene" className="w-full h-full object-cover" style={{ imageRendering: "pixelated" }} />
                </div>
              </div>
            </div>
            <div className="mt-3">
              {type === "ndvi" ? <NdviLegend /> : <MsiLegend />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── "Go here": one list of places to check, matching the pins on the maps ───
function PlacesToCheck({ fieldName, result, isLoading, error }: {
  fieldName: string; result?: SpotsResult; isLoading: boolean; error: unknown;
}) {
  const { toast } = useToast();
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  }
  if (error) {
    const msg = error instanceof Error ? error.message : "";
    return (
      <p className="text-sm text-muted-foreground">
        Couldn't find problem spots for this image. {msg.includes("qualifying") ? "Re-run the field analysis to refresh its image dates." : "Try again later."}
      </p>
    );
  }
  const spots = result?.spots || [];
  if (spots.length === 0) {
    return (
      <p className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
        <Check size={14} /> {result?.message || "No problem spots — the field looks even on this date."}
      </p>
    );
  }

  const copy = async (sp: ProblemSpot) => {
    try {
      await navigator.clipboard.writeText(`${sp.lat.toFixed(6)}, ${sp.lng.toFixed(6)}`);
      toast({ title: `Location of spot ${sp.label} copied` });
    } catch { toast({ title: "Could not copy", variant: "destructive" }); }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold text-foreground flex items-center gap-2">
        <MapPin size={15} className="text-red-500" />
        Go here — {spots.length} place{spots.length > 1 ? "s" : ""} to check
      </p>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
        {spots.map(sp => {
          const color = sp.severity === "critical" ? "#dc2626" : "#d97706";
          return (
            <div key={sp.label} className="rounded-lg border border-border bg-card p-3 flex gap-3" data-testid={`spot-${sp.label}`}>
              <span className="w-8 h-8 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0" style={{ background: color }}>
                {sp.label}
              </span>
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-medium text-foreground leading-snug">{sp.reason}</p>
                <p className="text-xs text-muted-foreground">Check: {sp.check}</p>
                <p className="text-xs text-muted-foreground">
                  About {formatArea(sp.areaHa)}{sp.severity === "critical" ? " · much worse than the rest of the field" : ""}
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <a href={walkingDirectionsUrl(sp.lat, sp.lng)} target="_blank" rel="noopener noreferrer" data-testid={`button-walk-${sp.label}`}>
                    <Button size="sm" className="h-7 px-2.5 text-xs gap-1"><Navigation size={11} /> Walk there</Button>
                  </a>
                  <a href={`https://wa.me/?text=${encodeURIComponent(spotShareText(fieldName, sp))}`} target="_blank" rel="noopener noreferrer">
                    <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs gap-1"><Share2 size={11} /> Send on WhatsApp</Button>
                  </a>
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => copy(sp)}>Copy location</Button>
                </div>
                {(sp.ndvi !== undefined || sp.msi !== undefined) && (
                  <p className="text-[10px] text-muted-foreground/70 font-mono pt-0.5">
                    {sp.ndvi !== undefined && `NDVI ${sp.ndvi.toFixed(2)} (field ${sp.fieldNdvi?.toFixed(2)})`}
                    {sp.ndvi !== undefined && sp.msi !== undefined && " · "}
                    {sp.msi !== undefined && `MSI ${sp.msi.toFixed(2)} (field ${sp.fieldMsi?.toFixed(2)})`}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── One satellite image date: places to check first, then the two maps ────────
function DateRow({
  fieldId, date, cloudCover, shape, fieldName, latest, defaultOpen,
}: {
  fieldId: number;
  date: string;
  cloudCover?: number | null;
  shape: FieldShape;
  fieldName: string;
  latest: boolean;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { data, isLoading, error } = useQuery<SpotsResult>({
    queryKey: [`/api/fields/${fieldId}/spots`, date],
    queryFn: async () => (await apiRequest("GET", `/api/fields/${fieldId}/spots?date=${date}`)).json(),
    enabled: open,
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });
  const spots = data?.spots || [];

  return (
    <div className="space-y-3 border border-border rounded-xl p-4 bg-card">
      <div className="flex items-center gap-2 flex-wrap">
        <Calendar size={14} className="text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">{date}</span>
        {latest && <Badge className="text-xs">Latest image</Badge>}
        <Badge variant="outline" className="text-xs">{typeof cloudCover === "number" ? `${cloudCover}% field cloud` : "Sentinel-2 L2A"}</Badge>
        {!open && (
          <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" onClick={() => setOpen(true)}>
            Show maps & places to check
          </Button>
        )}
      </div>
      {open && (
        <>
          <PlacesToCheck fieldName={fieldName} result={data} isLoading={isLoading} error={error} />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-3 border-t border-border">
            <MapTile fieldId={fieldId} date={date} type="ndvi" label="NDVI — Vegetation Index" shape={shape} fieldName={fieldName} spots={spots} />
            <MapTile fieldId={fieldId} date={date} type="msi"  label="MSI — Moisture Stress"   shape={shape} fieldName={fieldName} spots={spots} />
          </div>
        </>
      )}
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function SpatialMaps() {
  const [selectedFieldId, setSelectedFieldId] = useState<string>(
    // Opened from a dashboard "Go here" link: /maps?field=ID (the router keeps the query in location.search)
    () => new URLSearchParams(window.location.search).get("field")
      || new URLSearchParams(window.location.hash.split("?")[1] || "").get("field") || ""
  );

  const { data: fields = [], isLoading: fieldsLoading } = useQuery<Field[]>({
    queryKey: ["/api/fields"],
    queryFn: () => apiRequest("GET", "/api/fields").then(r => r.json()),
  });

  const analyzedFields = fields.filter(f => f.timeSeriesData);

  const selectedField = analyzedFields.find(f => String(f.id) === selectedFieldId);

  // Only images that passed the ≤20% field-cloud rule (the dates in the time series)
  const observations: { date: string; cloudCover: number | null }[] = selectedField?.timeSeriesData
    ? (JSON.parse(selectedField.timeSeriesData) as any[])
        .filter(d => !d.excluded && d.ndvi !== null)
        .map(d => ({ date: d.date as string, cloudCover: typeof d.cloudCover === "number" ? d.cloudCover : null }))
        .sort((a, b) => b.date.localeCompare(a.date)) // newest first
    : [];
  const obsDates = observations.map(o => o.date);

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
            <Layers size={20} className="text-[#1E6FA3]" />
            Spatial Maps
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Where to go in your field: places to check with walking directions, and NDVI and MSI maps
            from the Sentinel-2 images used in the time series (20% or less cloud over the field). Newest image first.
            Download or share any map as a PNG image.
          </p>
        </div>
      </div>

      {/* Field selector */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Select Field</CardTitle>
        </CardHeader>
        <CardContent>
          {fieldsLoading ? (
            <Skeleton className="h-9 w-64" />
          ) : analyzedFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No analyzed fields yet. Run an analysis on a field first to generate maps.
            </p>
          ) : (
            <Select value={selectedFieldId} onValueChange={setSelectedFieldId}>
              <SelectTrigger className="w-full max-w-sm" data-testid="select-field">
                <SelectValue placeholder="Choose a field…" />
              </SelectTrigger>
              <SelectContent>
                {analyzedFields.map(f => (
                  <SelectItem key={f.id} value={String(f.id)}>
                    {f.name}{f.region ? ` — ${f.region}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      {/* Maps grid — one row per observation date */}
      {selectedField && obsDates.length === 0 && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-muted-foreground text-center">
              This field has been analyzed but has no valid observation dates. Re-run the analysis to generate data.
            </p>
          </CardContent>
        </Card>
      )}

      {selectedField && obsDates.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Info size={13} className="text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              Each map shows a 256×256 pixel false-colour rendering over your field boundary.
              Each map uses exactly the image listed in the time series for that date (20% or less cloud over the field).
              <strong className="text-foreground"> Grey = cloud or cloud shadow, Blue = water.</strong>
              {" "}Use the <strong className="text-foreground">PNG</strong> or <strong className="text-foreground">Share</strong> buttons on each map to export or send directly.
            </p>
          </div>
          {observations.map(({ date, cloudCover }, i) => (
            <DateRow
              key={`${selectedField.id}-${date}`}
              latest={i === 0}
              defaultOpen={i === 0}
              fieldId={selectedField.id}
              date={date}
              cloudCover={cloudCover}
              shape={shapeFromField(selectedField)}
              fieldName={selectedField.name}
            />
          ))}
        </div>
      )}

      {!selectedField && !fieldsLoading && analyzedFields.length > 0 && (
        <Card className="border-dashed">
          <CardContent className="pt-10 pb-10 flex flex-col items-center gap-3 text-muted-foreground">
            <Map size={36} className="opacity-30" />
            <p className="text-sm">Select a field above to view its spatial maps.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
