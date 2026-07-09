import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, runAnalyzeJob } from "@/lib/queryClient";
import type { Field } from "@shared/schema";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  ResponsiveContainer, ReferenceLine, Legend, Scatter, Rectangle
} from "recharts";
import {
  CalendarRange, SatelliteDish, Cloud, Droplets, Leaf,
  RefreshCw, AlertTriangle, CheckCircle2, Info, CloudOff,
  Download, FileText, Image as ImageIcon, Share2
} from "lucide-react";

// Custom Tooltip for the dual chart
const CustomTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg shadow-lg p-3 text-xs min-w-[160px]">
      <p className="font-semibold text-foreground mb-2">{label}</p>
      {payload.map((entry: any) => (
        entry.value !== null && entry.value !== undefined && (
          <div key={entry.name} className="flex items-center justify-between gap-4 mb-1">
            <span className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: entry.color }} />
              {entry.name}
            </span>
            <span className="font-mono font-semibold" style={{ color: entry.color }}>
              {typeof entry.value === "number" ? entry.value.toFixed(3) : entry.value}
            </span>
          </div>
        )
      ))}
      {payload[0]?.payload?.cloudCover !== undefined && (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-border text-muted-foreground">
          <Cloud size={10} />
          <span>Cloud cover: {payload[0].payload.cloudCover}%</span>
        </div>
      )}
      {payload[0]?.payload?.excluded && (
        <p className="text-orange-500 mt-1 flex items-center gap-1"><AlertTriangle size={10} /> Cloudy — excluded</p>
      )}
      {payload[0]?.payload?.isWater && (
        <p className="text-blue-500 mt-1 flex items-center gap-1"><Droplets size={10} /> Open water pixel</p>
      )}
    </div>
  );
};

// Water pixel indicator dot
const WaterDot = (props: any) => {
  const { cx, cy, payload } = props;
  if (!payload?.isWater) return null;
  return <circle cx={cx} cy={cy} r={5} fill="#3b82f6" stroke="white" strokeWidth={1.5} />;
};

// Cloudy/excluded bar
const CloudyBar = (props: any) => {
  const { x, y, width, height, payload } = props;
  if (!payload?.excluded) return null;
  return <Rectangle x={x} y={0} width={width || 2} height={height * 10} fill="#f97316" fillOpacity={0.15} />;
};

function getDefaultDates() {
  const to = new Date();
  const from = new Date();
  from.setMonth(from.getMonth() - 6);
  return {
    from: from.toISOString().split("T")[0],
    to: to.toISOString().split("T")[0],
  };
}

// ── Download helpers ──────────────────────────────────────────────────────────

function downloadCSV(data: any[], fieldName: string, dateFrom: string, dateTo: string) {
  const headers = ["Date", "NDVI", "MSI", "EVI", "Soil Moisture (OPTRAM)", "Cloud Cover (%)", "Status", "Data Source"];
  const rows = [...data].reverse().map(d => [
    d.date,
    d.NDVI !== null && d.NDVI !== undefined ? d.NDVI.toFixed(3) : "",
    d.MSI !== null && d.MSI !== undefined ? d.MSI.toFixed(3) : "",
    d.EVI !== null && d.EVI !== undefined ? d.EVI.toFixed(3) : "",
    d["Soil Moisture (OPTRAM)"] !== null && d["Soil Moisture (OPTRAM)"] !== undefined ? d["Soil Moisture (OPTRAM)"].toFixed(3) : "",
    d.cloudCover ?? "",
    d.excluded ? "Cloudy-excluded" : d.isWater ? "Open water-removed" : "Valid",
    d.dataSource ?? "",
  ]);

  const metaLines = [
    `# NarrowTech GS — NDVI, MSI & EVI Time Series`,
    `# Field: ${fieldName}`,
    `# Period: ${dateFrom} to ${dateTo}`,
    `# Generated: ${new Date().toISOString()}`,
    `# Source: Sentinel-2 via Copernicus Data Space`,
    ``,
  ];

  const csvContent = [
    ...metaLines,
    headers.join(","),
    ...rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")),
  ].join("\n");

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `narrowtech-gs_${fieldName.replace(/\s+/g, "-")}_${dateFrom}_${dateTo}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportChartAsPng(
  chartContainerRef: React.RefObject<HTMLDivElement>,
  fieldName: string,
  dateFrom: string,
  dateTo: string,
  toast: (opts: any) => void
) {
  const container = chartContainerRef.current;
  if (!container) return;

  const svgEl = container.querySelector("svg");
  if (!svgEl) {
    toast({ title: "Could not find chart to export", variant: "destructive" });
    return;
  }

  try {
    // Clone and prepare SVG
    const clone = svgEl.cloneNode(true) as SVGElement;
    // Force white background for export
    clone.setAttribute("style", "background:#ffffff; font-family: system-ui, sans-serif;");

    // Fix computed colors that use CSS variables — replace hsl(var(--...)) with fallback values
    const serializer = new XMLSerializer();
    let svgStr = serializer.serializeToString(clone);
    // Replace common CSS variable references with static colors for clean export
    svgStr = svgStr
      .replace(/hsl\(var\(--border\)\)/g, "#e2e8f0")
      .replace(/hsl\(var\(--muted-foreground\)\)/g, "#64748b")
      .replace(/hsl\(var\(--foreground\)\)/g, "#1e293b")
      .replace(/hsl\(var\(--background\)\)/g, "#ffffff");

    const titleText = `NarrowTech GS — ${fieldName} · ${dateFrom} → ${dateTo}`;
    const PADDING = 48;
    const TITLE_H = 32;
    const SUBTITLE_H = 20;
    const FOOTER_H = 20;
    const svgW = svgEl.viewBox?.baseVal?.width || svgEl.getBoundingClientRect().width || 800;
    const svgH = svgEl.viewBox?.baseVal?.height || svgEl.getBoundingClientRect().height || 360;
    const canvasW = svgW + PADDING * 2;
    const canvasH = svgH + TITLE_H + SUBTITLE_H + FOOTER_H + PADDING * 2;

    const canvas = document.createElement("canvas");
    canvas.width = canvasW * 2; // @2x for retina
    canvas.height = canvasH * 2;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(2, 2);

    // White background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Title
    ctx.fillStyle = "#0f172a";
    ctx.font = "bold 14px system-ui, sans-serif";
    ctx.fillText(titleText, PADDING, PADDING + 14);

    // Subtitle
    ctx.fillStyle = "#64748b";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText("Sentinel-2 bi-weekly observations · NarrowTech GS Crop Health Intelligence", PADDING, PADDING + TITLE_H + 12);

    // Draw chart SVG onto canvas
    const img = new window.Image();
    const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);

    await new Promise<void>((resolve, reject) => {
      img.onload = () => {
        ctx.drawImage(img, PADDING, PADDING + TITLE_H + SUBTITLE_H, svgW, svgH);
        URL.revokeObjectURL(svgUrl);
        resolve();
      };
      img.onerror = reject;
      img.src = svgUrl;
    });

    // Footer
    ctx.fillStyle = "#94a3b8";
    ctx.font = "9px system-ui, sans-serif";
    const footerY = PADDING + TITLE_H + SUBTITLE_H + svgH + 14;
    ctx.fillText(`Generated ${new Date().toLocaleDateString()} · Source: Copernicus Sentinel-2 · narrowtechgeosolution.com`, PADDING, footerY);

    // Download
    canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `narrowtech-gs_chart_${fieldName.replace(/\s+/g, "-")}_${dateFrom}_${dateTo}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");

    toast({ title: "Chart exported as PNG" });
  } catch (e) {
    console.error(e);
    toast({ title: "Export failed — try again", variant: "destructive" });
  }
}

export default function TimeSeries() {
  const { toast } = useToast();
  const defaults = getDefaultDates();
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const [exportingPng, setExportingPng] = useState(false);

  const [selectedFieldId, setSelectedFieldId] = useState<string>("");
  const [dateFrom, setDateFrom] = useState(defaults.from);
  const [dateTo, setDateTo] = useState(defaults.to);
  const [cloudCoverMax, setCloudCoverMax] = useState<number>(20);
  const [chartData, setChartData] = useState<any[]>([]);

  const { data: fields = [], isLoading: fieldsLoading } = useQuery<Field[]>({
    queryKey: ["/api/fields"],
    queryFn: () => apiRequest("GET", "/api/fields").then(r => r.json()),
  });

  const { data: sentinelStatus } = useQuery({
    queryKey: ["/api/settings/sentinel-status"],
    queryFn: () => apiRequest("GET", "/api/settings/sentinel-status").then(r => r.json()),
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      if (!selectedFieldId) throw new Error("No field selected");
      return runAnalyzeJob(Number(selectedFieldId), { dateFrom, dateTo, cloudCoverMax });
    },
    onSuccess: (data) => {
      const ts = data.timeSeriesData || [];
      setChartData(ts);
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      const validCount = ts.filter((d: any) => !d.excluded && !d.isWater).length;
      const excludedCount = ts.filter((d: any) => d.excluded).length;
      const waterCount = ts.filter((d: any) => d.isWater).length;
      toast({
        title: "Time series ready",
        description: `${validCount} valid observations · ${excludedCount} cloudy excluded · ${waterCount} water pixels removed`,
      });
    },
    onError: () => toast({ title: "Analysis failed", variant: "destructive" }),
  });

  // Load existing time series when field changes
  useEffect(() => {
    if (!selectedFieldId) { setChartData([]); return; }
    const field = fields.find(f => String(f.id) === selectedFieldId);
    if (field?.timeSeriesData) {
      setChartData(JSON.parse(field.timeSeriesData));
      if (field.dateFrom) setDateFrom(field.dateFrom);
      if (field.dateTo) setDateTo(field.dateTo);
      if (field.cloudCoverMax) setCloudCoverMax(field.cloudCoverMax);
    } else {
      setChartData([]);
    }
  }, [selectedFieldId, fields]);

  const selectedField = fields.find(f => String(f.id) === selectedFieldId);
  const validObs = chartData.filter(d => !d.excluded && !d.isWater && d.ndvi !== null);
  const cloudyObs = chartData.filter(d => d.excluded);
  const waterObs = chartData.filter(d => d.isWater);

  // Prepare chart data: null values for excluded points so line breaks
  const plotData = chartData.map(d => ({
    date: d.date,
    NDVI: d.excluded || d.isWater ? null : d.ndvi,
    MSI: d.excluded || d.isWater ? null : d.ndwi,
    EVI: d.excluded || d.isWater ? null : (d.evi ?? null),
    "Soil Moisture (OPTRAM)": d.excluded || d.isWater ? null : (d.soilMoisture ?? null),
    cloudCover: d.cloudCover,
    excluded: d.excluded,
    isWater: d.isWater,
    dataSource: d.dataSource,
  }));

  // Summary stats
  const latestNdvi = validObs.length ? validObs[validObs.length - 1].ndvi : null;
  const latestMsi = validObs.length ? validObs[validObs.length - 1].ndwi : null;
  const latestNdwi = latestMsi; // alias
  const avgNdvi = validObs.length
    ? Math.round((validObs.reduce((s, d) => s + d.ndvi, 0) / validObs.length) * 1000) / 1000
    : null;
  const minNdvi = validObs.length ? Math.min(...validObs.map(d => d.ndvi)) : null;
  const maxNdvi = validObs.length ? Math.max(...validObs.map(d => d.ndvi)) : null;

  const hasData = plotData.length > 0;
  const fieldName = selectedField?.name ?? "Field";

  const handleExportPng = useCallback(async () => {
    setExportingPng(true);
    await exportChartAsPng(chartContainerRef, fieldName, dateFrom, dateTo, toast);
    setExportingPng(false);
  }, [chartContainerRef, fieldName, dateFrom, dateTo, toast]);

  return (
    <div className="max-w-6xl space-y-5">
      <div>
        <h2 className="text-xl font-bold text-foreground">NDVI, MSI & EVI Time Series</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Plot vegetation health and water stress over time using Sentinel-2 bi-weekly passes.
          Open water pixels are automatically excluded from stress analysis.
        </p>
      </div>

      {/* API Status banner */}
      {sentinelStatus && (
        <div className={`flex items-center gap-2.5 text-xs px-3 py-2 rounded-lg border ${
          sentinelStatus.connected
            ? "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-900/40 text-green-700 dark:text-green-400"
            : "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/40 text-amber-700 dark:text-amber-400"
        }`}>
          <SatelliteDish size={13} />
          <span className="font-medium">{sentinelStatus.mode}</span>
          {sentinelStatus.connected && <span className="text-muted-foreground">· Token: {sentinelStatus.tokenHint}</span>}
          {!sentinelStatus.connected && (
            <span className="text-muted-foreground">· Share your SentinelHub API token to enable real satellite data</span>
          )}
        </div>
      )}

      {/* Controls */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarRange size={16} className="text-primary" />
            Analysis Configuration
          </CardTitle>
          <CardDescription className="text-xs">
            Select a field and time range. Data is sourced every ~14 days (bi-weekly Sentinel-2 pass).
            Cloud cover &gt; {cloudCoverMax}% observations are automatically excluded.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            {/* Field selector */}
            <div className="space-y-1.5">
              <Label className="text-xs">Field</Label>
              {fieldsLoading ? <Skeleton className="h-9" /> : (
                <Select value={selectedFieldId} onValueChange={setSelectedFieldId}>
                  <SelectTrigger data-testid="select-field-ts">
                    <SelectValue placeholder="Select field…" />
                  </SelectTrigger>
                  <SelectContent>
                    {fields.map(f => (
                      <SelectItem key={f.id} value={String(f.id)}>
                        {f.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {/* Date From */}
            <div className="space-y-1.5">
              <Label className="text-xs">Start Date</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                data-testid="input-date-from"
                className="text-sm"
              />
            </div>

            {/* Date To */}
            <div className="space-y-1.5">
              <Label className="text-xs">End Date</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                data-testid="input-date-to"
                className="text-sm"
              />
            </div>

            {/* Cloud Cover */}
            <div className="space-y-1.5">
              <Label className="text-xs">Max Cloud Cover (%)</Label>
              <Select value={String(cloudCoverMax)} onValueChange={v => setCloudCoverMax(Number(v))}>
                <SelectTrigger data-testid="select-cloud-cover">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5% — Very strict</SelectItem>
                  <SelectItem value="10">10% — Strict</SelectItem>
                  <SelectItem value="20">20% — Recommended</SelectItem>
                  <SelectItem value="30">30% — Relaxed</SelectItem>
                  <SelectItem value="50">50% — Permissive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Quick date range presets */}
          <div className="flex flex-wrap gap-2 mb-4">
            {[
              { label: "Last 3 months", months: 3 },
              { label: "Last 6 months", months: 6 },
              { label: "Last 12 months", months: 12 },
              { label: "Last 2 years", months: 24 },
            ].map(({ label, months }) => (
              <Button
                key={label}
                variant="outline"
                size="sm"
                className="text-xs h-7"
                onClick={() => {
                  const to = new Date();
                  const from = new Date();
                  from.setMonth(from.getMonth() - months);
                  setDateTo(to.toISOString().split("T")[0]);
                  setDateFrom(from.toISOString().split("T")[0]);
                }}
                data-testid={`button-preset-${months}`}
              >
                {label}
              </Button>
            ))}
          </div>

          <Button
            className="gap-2"
            disabled={!selectedFieldId || analyzeMutation.isPending}
            onClick={() => analyzeMutation.mutate()}
            data-testid="button-run-timeseries"
          >
            <SatelliteDish size={14} className={analyzeMutation.isPending ? "animate-pulse" : ""} />
            {analyzeMutation.isPending ? "Fetching Sentinel-2 data…" : "Run Time Series Analysis"}
          </Button>
        </CardContent>
      </Card>

      {/* Stats strip */}
      {validObs.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Valid Observations", value: validObs.length, icon: CheckCircle2, color: "text-green-600 dark:text-green-400" },
            { label: "Cloudy / Excluded", value: cloudyObs.length, icon: Cloud, color: "text-orange-500" },
            { label: "Water Pixels Removed", value: waterObs.length, icon: Droplets, color: "text-blue-500" },
            { label: "Latest NDVI", value: latestNdvi?.toFixed(3) ?? "—", icon: Leaf, color: "text-emerald-600 dark:text-emerald-400" },
          ].map(({ label, value, icon: Icon, color }) => (
            <Card key={label}>
              <CardContent className="p-3">
                <div className="flex items-center gap-1.5 mb-1">
                  <Icon size={13} className={color} />
                  <span className="text-xs text-muted-foreground">{label}</span>
                </div>
                <p className="text-xl font-bold text-foreground">{value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dual NDVI + MSI Chart */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <CardTitle className="text-base">
                NDVI, MSI & EVI Time Series
                {selectedField && <span className="text-muted-foreground font-normal ml-2">— {selectedField.name}</span>}
              </CardTitle>
              <CardDescription className="text-xs mt-1">
                {dateFrom} → {dateTo} · Bi-weekly Sentinel-2 observations · Cloud cover ≤ {cloudCoverMax}%
              </CardDescription>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <div className="flex items-center gap-3 text-xs">
                <span className="flex items-center gap-1.5"><span className="w-3 h-1 rounded bg-emerald-500 inline-block" />NDVI</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-1 rounded bg-blue-500 inline-block" />MSI</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-1 rounded bg-purple-500 inline-block" />EVI</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-1 rounded bg-teal-500 inline-block" />Soil Moisture (OPTRAM)</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-orange-400 inline-block" />Cloudy</span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-blue-400 inline-block" />Water</span>
              </div>
              {/* Export button — only show when there's data */}
              {hasData && (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs h-7"
                  onClick={handleExportPng}
                  disabled={exportingPng}
                  data-testid="button-export-chart-png"
                >
                  <ImageIcon size={12} />
                  {exportingPng ? "Exporting…" : "Save as PNG"}
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {plotData.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
              <CalendarRange size={36} className="text-muted-foreground/30" />
              <div>
                <p className="font-medium text-foreground">No data yet</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Select a field and date range above, then run the analysis.
                </p>
              </div>
            </div>
          ) : (
            <div ref={chartContainerRef}>
              <ResponsiveContainer width="100%" height={360}>
                <ComposedChart data={plotData} margin={{ top: 8, right: 16, bottom: 20, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10 }}
                    stroke="hsl(var(--muted-foreground))"
                    angle={-35}
                    textAnchor="end"
                    height={50}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    domain={[0, 2.0]}
                    tick={{ fontSize: 10 }}
                    stroke="hsl(var(--muted-foreground))"
                    tickFormatter={(v) => v.toFixed(1)}
                    label={{ value: "Index value", angle: -90, position: "insideLeft", style: { fontSize: 10, fill: "hsl(var(--muted-foreground))" } }}
                  />
                  <ChartTooltip content={<CustomTooltip />} />

                  {/* MSI=0.6 — adequate/mild stress boundary */}
                  <ReferenceLine y={0.6} stroke="#3b82f6" strokeDasharray="4 2" strokeWidth={1}
                    label={{ value: "MSI=0.6", position: "insideTopRight", fontSize: 9, fill: "#3b82f6" }} />
                  {/* NDVI=0.35 — vegetation health warning */}
                  <ReferenceLine y={0.35} stroke="#22c55e" strokeDasharray="4 2" strokeWidth={1}
                    label={{ value: "NDVI=0.35", position: "insideTopRight", fontSize: 9, fill: "#22c55e" }} />
                  {/* MSI=1.2 — severe stress threshold */}
                  <ReferenceLine y={1.2} stroke="#ef4444" strokeDasharray="2 4" strokeWidth={1}
                    label={{ value: "MSI=1.2 (severe)", position: "insideTopLeft", fontSize: 9, fill: "#ef4444" }} />

                  {/* NDVI line — green */}
                  <Line
                    type="monotone"
                    dataKey="NDVI"
                    stroke="#10b981"
                    strokeWidth={2.5}
                    dot={{ fill: "#10b981", r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: "#10b981" }}
                    connectNulls={false}
                    name="NDVI"
                  />

                  {/* MSI line — blue */}
                  <Line
                    type="monotone"
                    dataKey="MSI"
                    stroke="#3b82f6"
                    strokeWidth={2.5}
                    dot={{ fill: "#3b82f6", r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: "#3b82f6" }}
                    connectNulls={false}
                    name="MSI"
                    strokeDasharray="none"
                  />

                  {/* EVI line — purple */}
                  <Line
                    type="monotone"
                    dataKey="EVI"
                    stroke="#a855f7"
                    strokeWidth={2.5}
                    dot={{ fill: "#a855f7", r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: "#a855f7" }}
                    connectNulls={false}
                    name="EVI"
                    strokeDasharray="5 2"
                  />

                  {/* Soil Moisture (OPTRAM) line — teal */}
                  <Line
                    type="monotone"
                    dataKey="Soil Moisture (OPTRAM)"
                    stroke="#14b8a6"
                    strokeWidth={2.5}
                    dot={{ fill: "#14b8a6", r: 3, strokeWidth: 0 }}
                    activeDot={{ r: 5, fill: "#14b8a6" }}
                    connectNulls={false}
                    name="Soil Moisture (OPTRAM)"
                    strokeDasharray="6 3"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Data Table */}
      {plotData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <CardTitle className="text-sm">Observation Log</CardTitle>
                <CardDescription className="text-xs">
                  All Sentinel-2 passes in the selected period. Open water pixels and cloudy scenes (&gt;{cloudCoverMax}% cloud) are excluded.
                </CardDescription>
              </div>
              {/* Download CSV + PNG chart buttons */}
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 text-xs h-7"
                  onClick={() => downloadCSV(plotData, fieldName, dateFrom, dateTo)}
                  data-testid="button-download-csv"
                >
                  <FileText size={12} />
                  Download CSV
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-2 pr-4 text-muted-foreground font-medium">Date</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">NDVI</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">MSI</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">EVI</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Soil Moisture</th>
                    <th className="text-right py-2 pr-4 text-muted-foreground font-medium">Cloud %</th>
                    <th className="text-left py-2 text-muted-foreground font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...plotData].reverse().map((d, i) => (
                    <tr key={i} className={`border-b border-border/50 ${d.excluded || d.isWater ? "opacity-50" : ""}`}>
                      <td className="py-1.5 pr-4 font-mono">{d.date}</td>
                      <td className="py-1.5 pr-4 text-right font-mono text-emerald-600 dark:text-emerald-400">
                        {d.NDVI !== null && d.NDVI !== undefined ? d.NDVI.toFixed(3) : "—"}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-blue-600 dark:text-blue-400">
                        {d.MSI !== null && d.MSI !== undefined ? d.MSI.toFixed(3) : "—"}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-purple-600 dark:text-purple-400">
                        {d.EVI !== null && d.EVI !== undefined ? d.EVI.toFixed(3) : "—"}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-teal-600 dark:text-teal-400">
                        {d["Soil Moisture (OPTRAM)"] !== null && d["Soil Moisture (OPTRAM)"] !== undefined ? d["Soil Moisture (OPTRAM)"].toFixed(3) : "—"}
                      </td>
                      <td className="py-1.5 pr-4 text-right">
                        <span className={d.cloudCover > cloudCoverMax ? "text-orange-500 font-semibold" : "text-muted-foreground"}>
                          {d.cloudCover ?? "—"}%
                        </span>
                      </td>
                      <td className="py-1.5">
                        {d.excluded ? (
                          <span className="flex items-center gap-1 text-orange-500"><Cloud size={10} /> Cloudy — excluded</span>
                        ) : d.isWater ? (
                          <span className="flex items-center gap-1 text-blue-500"><Droplets size={10} /> Open water — removed</span>
                        ) : (
                          <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={10} /> Valid</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Legend cards */}
      <div className="grid sm:grid-cols-3 gap-4">
        <Card className="bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-900/40">
          <CardContent className="p-4 space-y-2">
            <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 flex items-center gap-1.5">
              <Leaf size={12} /> NDVI Reference Ranges
            </p>
            {[
              ["≥ 0.6", "Dense healthy vegetation", "text-green-700 dark:text-green-400"],
              ["0.4–0.6", "Moderate / good growth", "text-emerald-600 dark:text-emerald-400"],
              ["0.25–0.4", "Sparse / stressed", "text-yellow-600 dark:text-yellow-400"],
              ["0.1–0.25", "Very sparse / drought risk", "text-orange-600 dark:text-orange-400"],
              ["< 0.1", "Bare soil / no vegetation", "text-red-600 dark:text-red-400"],
            ].map(([range, label, cls]) => (
              <div key={range} className="flex justify-between text-xs">
                <span className={`font-mono font-medium ${cls}`}>{range}</span>
                <span className="text-muted-foreground">{label}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="bg-blue-50 dark:bg-blue-950/20 border-blue-200 dark:border-blue-900/40">
          <CardContent className="p-4 space-y-2">
            <p className="text-xs font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-1.5">
              <Droplets size={12} /> MSI Reference Ranges
            </p>
            {[
              ["< 0.1", "Open water (excluded)", "text-blue-700 dark:text-blue-400"],
              ["0.1–0.4", "High moisture / no stress", "text-cyan-600 dark:text-cyan-400"],
              ["0.4–0.6", "Adequate moisture", "text-green-600 dark:text-green-400"],
              ["0.6–1.0", "Mild water stress", "text-yellow-600 dark:text-yellow-400"],
              ["1.0–1.2", "Moderate drought", "text-orange-600 dark:text-orange-400"],
              ["> 1.2", "Severe drought stress", "text-red-600 dark:text-red-400"],
            ].map(([range, label, cls]) => (
              <div key={range} className="flex justify-between text-xs">
                <span className={`font-mono font-medium ${cls}`}>{range}</span>
                <span className="text-muted-foreground">{label}</span>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card className="bg-purple-50 dark:bg-purple-950/20 border-purple-200 dark:border-purple-900/40">
          <CardContent className="p-4 space-y-2">
            <p className="text-xs font-semibold text-purple-700 dark:text-purple-400 flex items-center gap-1.5">
              <Leaf size={12} /> EVI Reference Ranges
            </p>
            {[
              ["≥ 0.5", "Dense healthy canopy", "text-green-700 dark:text-green-400"],
              ["0.35–0.5", "Good vegetation vigor", "text-emerald-600 dark:text-emerald-400"],
              ["0.2–0.35", "Moderate / developing", "text-yellow-600 dark:text-yellow-400"],
              ["0.1–0.2", "Poor / sparse canopy", "text-orange-600 dark:text-orange-400"],
              ["< 0.1", "Critical / bare soil", "text-red-600 dark:text-red-400"],
            ].map(([range, label, cls]) => (
              <div key={range} className="flex justify-between text-xs">
                <span className={`font-mono font-medium ${cls}`}>{range}</span>
                <span className="text-muted-foreground">{label}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
