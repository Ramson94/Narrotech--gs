import { useState } from "react";
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
        { color: "#9aa0b0", label: "Cloud" },
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
        { color: "#9aa0b0", label: "Cloud" },
      ].map(({ color, label }) => (
        <span key={label} className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded-sm flex-shrink-0" style={{ background: color }} />
          {label}
        </span>
      ))}
    </div>
  );
}

function EviLegend() {
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs text-muted-foreground mt-2">
      <span className="font-medium text-foreground">EVI:</span>
      {[
        { color: "#9b1a8a", label: "Critical (<0.1)" },
        { color: "#d1479e", label: "Poor (0.1–0.2)" },
        { color: "#e8c400", label: "Moderate (0.2–0.35)" },
        { color: "#7ec93d", label: "Good (0.35–0.5)" },
        { color: "#1a8f3d", label: "Excellent (>0.5)" },
        { color: "#1a4db3", label: "Water" },
        { color: "#9aa0b0", label: "Cloud" },
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
const BUF = 0.005; // must match server-side buffer
function projectPolygon(
  coords: { lat: number; lng: number }[],
  size: number = 100 // SVG viewBox size
): string {
  const lngs = coords.map(c => c.lng);
  const lats = coords.map(c => c.lat);
  const minLng = Math.min(...lngs) - BUF;
  const maxLng = Math.max(...lngs) + BUF;
  const minLat = Math.min(...lats) - BUF;
  const maxLat = Math.max(...lats) + BUF;
  const spanLng = maxLng - minLng;
  const spanLat = maxLat - minLat;
  return coords
    .map(({ lat, lng }) => {
      const x = ((lng - minLng) / spanLng) * size;
      // latitude: top of image = maxLat, so invert
      const y = ((maxLat - lat) / spanLat) * size;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}

// ── Clipped image with SVG polygon mask ───────────────────────────────────
function ClippedMapImage({
  imgUrl,
  coords,
  label,
  onClick,
}: {
  imgUrl: string;
  coords: { lat: number; lng: number }[];
  label: string;
  onClick: () => void;
}) {
  const clipId = `clip-${label.replace(/\W/g, "-")}`;
  const points = projectPolygon(coords);

  return (
    <div
      className="relative aspect-square w-full rounded-lg overflow-hidden border border-border bg-black cursor-zoom-in"
      onClick={onClick}
    >
      {/* Full satellite image as background */}
      <img
        src={imgUrl}
        alt={label}
        className="absolute inset-0 w-full h-full object-cover opacity-20"
        aria-hidden
      />
      {/* SVG clipped version on top */}
      <svg
        viewBox="0 0 100 100"
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="none"
      >
        <defs>
          <clipPath id={clipId}>
            <polygon points={points} />
          </clipPath>
        </defs>
        {/* Satellite image clipped to field polygon */}
        <image
          href={imgUrl}
          x="0" y="0" width="100" height="100"
          clipPath={`url(#${clipId})`}
          preserveAspectRatio="none"
        />
        {/* Field outline */}
        <polygon
          points={points}
          fill="none"
          stroke="white"
          strokeWidth="0.8"
          strokeDasharray="2 1"
          opacity="0.9"
        />
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
  coords: { lat: number; lng: number }[],
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
    const indexLabel = type === "ndvi" ? "NDVI — Vegetation Index" : type === "evi" ? "EVI — Enhanced Vegetation Index" : "MSI — Moisture Stress Index";
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

    // Draw field polygon overlay on the canvas
    const points = coords.map(({ lat, lng }) => {
      const lngs = coords.map(c => c.lng);
      const lats = coords.map(c => c.lat);
      const minLng = Math.min(...lngs) - BUF;
      const maxLng = Math.max(...lngs) + BUF;
      const minLat = Math.min(...lats) - BUF;
      const maxLat = Math.max(...lats) + BUF;
      const x = ((lng - minLng) / (maxLng - minLng)) * SIZE;
      const y = ((maxLat - lat) / (maxLat - minLat)) * SIZE + HEADER;
      return { x, y };
    });
    ctx.beginPath();
    ctx.setLineDash([6, 3]);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 2;
    points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.stroke();

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
  coords,
  fieldName,
}: {
  fieldId: number;
  date: string;
  type: "ndvi" | "msi" | "evi";
  label: string;
  coords: { lat: number; lng: number }[];
  fieldName: string;
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
    await downloadMapPng(imgUrl, fieldName, date, type, coords, toast);
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
            coords={coords}
            label={label}
            onClick={() => setZoomed(true)}
          />
        )}

        {type === "ndvi" ? <NdviLegend /> : type === "evi" ? <EviLegend /> : <MsiLegend />}
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
                <ClippedMapImage imgUrl={imgUrl} coords={coords} label={label} onClick={() => {}} />
              </div>
              <div>
                <p className="text-white/60 text-xs mb-1">Full scene context</p>
                <div className="aspect-square rounded-lg overflow-hidden border border-white/20">
                  <img src={imgUrl} alt="Full scene" className="w-full h-full object-cover" style={{ imageRendering: "pixelated" }} />
                </div>
              </div>
            </div>
            <div className="mt-3">
              {type === "ndvi" ? <NdviLegend /> : type === "evi" ? <EviLegend /> : <MsiLegend />}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Stress zones panel: navigable GPS pins for the worst sub-areas ──────────
type StressZone = {
  id: number;
  label: string;
  lat: number;
  lng: number;
  value: number;
  severity: "critical" | "warning" | "moderate";
  navigateUrl: string;
  cellCount?: number;
};

const SEVERITY_STYLES: Record<StressZone["severity"], { badge: string; dot: string; text: string }> = {
  critical: { badge: "bg-red-100 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900", dot: "bg-red-500", text: "Critical" },
  warning:  { badge: "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900", dot: "bg-amber-500", text: "Warning" },
  moderate: { badge: "bg-blue-100 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900", dot: "bg-blue-500", text: "Moderate" },
};

function StressZonesPanel({
  fieldId, date, index, indexLabel,
}: {
  fieldId: number;
  date: string;
  index: "ndvi" | "msi";
  indexLabel: string;
}) {
  const { data, isLoading, isError } = useQuery<{ zones: StressZone[]; fieldMean?: number; message?: string }>({
    queryKey: [`/api/fields/${fieldId}/stress-zones`, date, index],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/fields/${fieldId}/stress-zones?date=${date}&index=${index}&maxZones=5`);
      if (!res.ok) throw new Error("Stress zone analysis failed");
      return res.json();
    },
    staleTime: 24 * 60 * 60 * 1000,
    retry: 1,
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-16 w-full rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn't compute stress zones for this date — try a different observation date.
      </p>
    );
  }

  const zones = data?.zones || [];

  if (zones.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {data?.message || "No distinct stress zones detected — this field looks uniform for this date."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <MapPin size={13} className="text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground">
          Worst {indexLabel} zones — tap Navigate to walk there
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {zones.map(zone => {
          const style = SEVERITY_STYLES[zone.severity];
          return (
            <div
              key={zone.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2"
              data-testid={`stress-zone-${zone.id}`}
            >
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${style.dot}`} />
                  <span className="text-xs font-semibold text-foreground truncate">{zone.label}</span>
                  <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border ${style.badge}`}>
                    {style.text}
                  </Badge>
                </div>
                <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
                  {indexLabel} {zone.value.toFixed(2)} · {zone.lat.toFixed(3)}, {zone.lng.toFixed(3)}
                </p>
                {zone.cellCount && zone.cellCount > 1 ? (
                  <p className="text-[10px] text-muted-foreground/80 mt-0.5">
                    Affects ~{zone.cellCount} plots in this patch
                  </p>
                ) : null}
              </div>
              <a
                href={zone.navigateUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-shrink-0"
                data-testid={`button-navigate-${zone.id}`}
              >
                <Button variant="outline" size="sm" className="h-7 px-2 text-[11px] gap-1">
                  <Navigation size={11} />
                  Navigate
                </Button>
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Date window row (one observation date) ──────────────────────────────────
function DateRow({
  fieldId, date, coords, fieldName
}: {
  fieldId: number;
  date: string;
  coords: { lat: number; lng: number }[];
  fieldName: string;
}) {
  return (
    <div className="space-y-3 border border-border rounded-xl p-4 bg-card">
      <div className="flex items-center gap-2">
        <Calendar size={14} className="text-muted-foreground" />
        <span className="text-sm font-semibold text-foreground">{date}</span>
        <Badge variant="outline" className="text-xs">Bi-weekly observation</Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        <MapTile fieldId={fieldId} date={date} type="ndvi" label="NDVI — Vegetation Index" coords={coords} fieldName={fieldName} />
        <MapTile fieldId={fieldId} date={date} type="msi"  label="MSI — Moisture Stress"   coords={coords} fieldName={fieldName} />
        <MapTile fieldId={fieldId} date={date} type="evi"  label="EVI — Enhanced Vegetation" coords={coords} fieldName={fieldName} />
      </div>
      <div className="pt-3 border-t border-border space-y-4">
        <StressZonesPanel fieldId={fieldId} date={date} index="ndvi" indexLabel="NDVI" />
        <StressZonesPanel fieldId={fieldId} date={date} index="msi" indexLabel="MSI" />
      </div>
    </div>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function SpatialMaps() {
  const [selectedFieldId, setSelectedFieldId] = useState<string>("");

  const { data: fields = [], isLoading: fieldsLoading } = useQuery<Field[]>({
    queryKey: ["/api/fields"],
    queryFn: () => apiRequest("GET", "/api/fields").then(r => r.json()),
  });

  const analyzedFields = fields.filter(f => f.timeSeriesData);

  const selectedField = analyzedFields.find(f => String(f.id) === selectedFieldId);

  // Extract unique observation dates from time series
  const obsDates: string[] = selectedField?.timeSeriesData
    ? [
        ...new Set(
          (JSON.parse(selectedField.timeSeriesData) as any[])
            .filter(d => !d.excluded && d.ndvi !== null)
            .map((d: any) => d.date as string)
        ),
      ].sort()
    : [];

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
            Bi-weekly NDVI, MSI and EVI maps from Sentinel-2 — see spatial variation across your field.
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
                    {f.name} — {f.region}
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
              Images are cloud-filtered (best overpass within ±3 days of each date).
              <strong className="text-foreground"> Grey = cloud, Blue = water.</strong>
              {" "}Use the <strong className="text-foreground">PNG</strong> or <strong className="text-foreground">Share</strong> buttons on each map to export or send directly.
            </p>
          </div>
          {obsDates.map(date => (
            <DateRow
              key={date}
              fieldId={selectedField.id}
              date={date}
              coords={JSON.parse(selectedField.coordinates)}
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
