import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, runAnalyzeJob } from "@/lib/queryClient";
import type { Field, Alert } from "@shared/schema";
import { Link } from "wouter";
import { fieldStatus, STATUS_COLORS } from "@shared/status";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  SatelliteDish, AlertTriangle, Leaf, Droplets, TrendingUp,
  Plus, RefreshCw, Info, XCircle, Bell, CalendarRange, Trash2,
  FileText, MessageCircle, Loader2, MapPin
} from "lucide-react";
import { RadialBarChart, RadialBar, ResponsiveContainer } from "recharts";


export default function Dashboard() {
  const { toast } = useToast();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const { data: fields = [], isLoading } = useQuery<Field[]>({
    queryKey: ["/api/fields"],
    queryFn: () => apiRequest("GET", "/api/fields").then(r => r.json()),
  });

  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: sentinelStatus } = useQuery({
    queryKey: ["/api/settings/sentinel-status"],
    queryFn: () => apiRequest("GET", "/api/settings/sentinel-status").then(r => r.json()),
  });

  const analyzeMutation = useMutation({
    mutationFn: (id: number) => runAnalyzeJob(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Analysis complete", description: "Field updated from Sentinel-2 data." });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/fields/${id}`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Field deleted", description: "Field and all its data removed." });
    },
    onError: () => toast({ title: "Delete failed", variant: "destructive" }),
  });

  // ── PDF Report download ─────────────────────────────────────────────────
  const [downloadingReport, setDownloadingReport] = useState<number | null>(null);
  const handleDownloadReport = async (fieldId: number, fieldName: string) => {
    setDownloadingReport(fieldId);
    try {
      const API_BASE = ("__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__");
      const res = await fetch(`${API_BASE}/api/fields/${fieldId}/report`, {
        method: "GET",
        credentials: "include",
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${res.status}: ${errText}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `narrowtech-gs_${fieldName.replace(/\s+/g, "-")}_${new Date().toISOString().slice(0,10)}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: "Report downloaded", description: `${fieldName} crop health report saved.` });
    } catch (err: any) {
      toast({ title: "Report failed", description: err?.message ?? String(err), variant: "destructive" });
    }
    setDownloadingReport(null);
  };

  // ── WhatsApp notification ────────────────────────────────────────────────
  const [sendingWa, setSendingWa] = useState<number | null>(null);
  const handleWhatsApp = async (fieldId: number, fieldName: string) => {
    setSendingWa(fieldId);
    try {
      const API_BASE2 = ("__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__");
      const res = await fetch(`${API_BASE2}/api/fields/${fieldId}/notify-whatsapp`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      const data = await res.json();
      if (data.success) {
        toast({
          title: data.simulated ? "WhatsApp preview (no credentials yet)" : "WhatsApp sent!",
          description: data.simulated
            ? "Add Twilio credentials to enable real delivery. Message preview logged to console."
            : `Message sent to +233024080279 · SID: ${data.messageSid?.slice(0,16)}`,
        });
      } else {
        toast({ title: "WhatsApp failed", description: data.error ?? "Unknown error", variant: "destructive" });
      }
    } catch (err: any) {
      toast({ title: "WhatsApp failed", description: err?.message ?? String(err), variant: "destructive" });
    }
    setSendingWa(null);
  };

    const biweeklyMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/notify/check").then(r => r.json()),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      const failed = (data.results ?? []).filter((r: any) => r.error);
      toast({
        title: `Bi-weekly check complete`,
        description: failed.length
          ? `${data.checked - failed.length} of ${data.checked} field(s) updated. No satellite data for: ${failed.map((r: any) => r.name).join(", ")}.`
          : `${data.checked} field(s) updated.`,
        variant: failed.length ? "destructive" : undefined,
      });
    },
  });

  const totalFields = fields.length;
  const analyzedFields = fields.filter(f => f.status !== "pending").length;
  const alertFields = fields.filter(f => f.status === "alert").length;
  const unackAlerts = alerts.filter(a => !a.acknowledged).length;

  return (
    <div className="space-y-5 max-w-6xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-bold text-foreground">Field Overview</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Monitor agricultural fields with Sentinel-2 satellite data · Ghana
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => biweeklyMutation.mutate()}
            disabled={biweeklyMutation.isPending || fields.length === 0}
            data-testid="button-biweekly-check"
          >
            <Bell size={13} className={biweeklyMutation.isPending ? "animate-pulse" : ""} />
            Bi-weekly Check
          </Button>
          <Link href="/analyze">
            <Button data-testid="button-add-field" size="sm" className="gap-2">
              <Plus size={13} />
              Add Field
            </Button>
          </Link>
        </div>
      </div>

      {/* Sentinel API status */}
      {sentinelStatus && !sentinelStatus.connected && (
        <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/40 text-amber-700 dark:text-amber-400">
          <SatelliteDish size={12} />
          <span className="font-medium">Satellite connection unavailable.</span>
          <span className="text-amber-600/70 dark:text-amber-500/70">New analyses will not run until the Copernicus credentials are working.</span>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: "Total Fields", value: totalFields, icon: Leaf, color: "text-emerald-600 dark:text-emerald-400" },
          { label: "Analyzed", value: analyzedFields, icon: SatelliteDish, color: "text-primary" },
          { label: "Active Alerts", value: unackAlerts, icon: AlertTriangle, color: unackAlerts > 0 ? "text-red-500" : "text-muted-foreground" },
          { label: "Need Action Now", value: fields.filter(f => fieldStatus(f).level === "red").length, icon: TrendingUp, color: "text-red-500" },
        ].map(({ label, value, icon: Icon, color }) => (
          <Card key={label}>
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-2">
                <Icon size={14} className={color} />
                <span className="text-xs text-muted-foreground font-medium">{label}</span>
              </div>
              <p className="text-2xl font-bold text-foreground">{value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Fields grid */}
      {isLoading ? (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1,2,3].map(i => <Skeleton key={i} className="h-64" />)}
        </div>
      ) : fields.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 flex flex-col items-center gap-4 text-center">
            <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center">
              <SatelliteDish size={24} className="text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">No fields yet</h3>
              <p className="text-sm text-muted-foreground mt-1 max-w-xs">
                Add your first agricultural field to start monitoring crop health with Sentinel-2 satellite data.
              </p>
            </div>
            <Link href="/analyze">
              <Button data-testid="button-add-first-field" className="gap-2">
                <Plus size={14} /> Add your first field
              </Button>
            </Link>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {fields.map(field => {
            const status = fieldStatus(field);
            const coords = field.coordinates ? JSON.parse(field.coordinates) : [];
            const ts = field.timeSeriesData ? JSON.parse(field.timeSeriesData) : [];
            const validObs = ts.filter((d: any) => !d.excluded && !d.isWater).length;

            return (
              <Card key={field.id} data-testid={`card-field-${field.id}`} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <CardTitle className="text-base font-semibold truncate">{field.name}</CardTitle>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {field.region || "Ghana"} · {field.cropType || "Unknown crop"}
                      </p>
                    </div>
                    <span
                      className="text-xs font-semibold flex-shrink-0 flex items-center gap-1.5 px-2 py-0.5 rounded-full text-white"
                      style={{ background: STATUS_COLORS[status.level] }}
                      data-testid={`status-${field.id}`}
                    >
                      {status.label}
                    </span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Traffic light + one sentence of action. Numbers live in the Time Series table. */}
                  <div
                    className="flex items-start gap-3 rounded-lg p-3"
                    style={{ background: `${STATUS_COLORS[status.level]}14`, borderLeft: `4px solid ${STATUS_COLORS[status.level]}` }}
                  >
                    <span
                      className="mt-0.5 w-5 h-5 rounded-full flex-shrink-0 shadow-inner"
                      style={{ background: STATUS_COLORS[status.level] }}
                      aria-label={status.label}
                    />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{status.label}</p>
                      <p className="text-sm text-foreground/80 leading-snug">{status.action}</p>
                    </div>
                  </div>
                  {(status.level === "red" || status.level === "yellow") && validObs > 0 && (
                    <Link href={`/maps?field=${field.id}`}>
                      <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs h-8" data-testid={`button-go-here-${field.id}`}>
                        <MapPin size={12} /> Go here — see the places to check
                      </Button>
                    </Link>
                  )}
                  {validObs > 0 && (
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <CalendarRange size={10} />
                      Based on {validObs} satellite images · {field.dateFrom?.slice(0,7)} → {field.dateTo?.slice(0,7)}
                    </p>
                  )}

                  {coords.length > 0 && (
                    <p className="text-xs text-muted-foreground font-mono truncate">
                      {coords[0].lat.toFixed(4)}°N, {coords[0].lng.toFixed(4)}°E
                    </p>
                  )}

                  {field.analyzedAt && (
                    <p className="text-xs text-muted-foreground">
                      Analyzed: {new Date(field.analyzedAt).toLocaleDateString()} ·{" "}
                      {field.lastNotifiedAt
                        ? `Notified: ${new Date(field.lastNotifiedAt).toLocaleDateString()}`
                        : "Notification pending"}
                    </p>
                  )}

                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1 gap-1.5"
                      onClick={() => analyzeMutation.mutate(field.id)}
                      disabled={analyzeMutation.isPending}
                      data-testid={`button-analyze-${field.id}`}
                    >
                      <RefreshCw size={12} className={analyzeMutation.isPending ? "animate-spin" : ""} />
                      {field.status === "pending" ? "Analyze" : "Re-analyze"}
                    </Button>
                    <Link href="/timeseries">
                      <Button variant="ghost" size="sm" className="gap-1.5 text-xs">
                        <TrendingUp size={12} /> Time Series
                      </Button>
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 px-2"
                      onClick={() => {
                        if (confirm(`Delete "${field.name}"? This cannot be undone.`)) {
                          deleteMutation.mutate(field.id);
                        }
                      }}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-delete-${field.id}`}
                      title="Delete field"
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                  {/* Report + WhatsApp row */}
                  {field.status !== "pending" && (
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1.5 text-xs"
                        onClick={() => handleDownloadReport(field.id, field.name)}
                        disabled={downloadingReport === field.id}
                        data-testid={`button-report-${field.id}`}
                        title="Download PDF report"
                      >
                        {downloadingReport === field.id
                          ? <Loader2 size={11} className="animate-spin" />
                          : <FileText size={11} />}
                        {downloadingReport === field.id ? "Generating…" : "PDF Report"}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="flex-1 gap-1.5 text-xs text-green-700 dark:text-green-400 border-green-200 dark:border-green-900/40 hover:bg-green-50 dark:hover:bg-green-950/30"
                        onClick={() => handleWhatsApp(field.id, field.name)}
                        disabled={sendingWa === field.id}
                        data-testid={`button-whatsapp-${field.id}`}
                        title="Send WhatsApp update"
                      >
                        {sendingWa === field.id
                          ? <Loader2 size={11} className="animate-spin" />
                          : <MessageCircle size={11} />}
                        {sendingWa === field.id ? "Sending…" : "WhatsApp"}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Alerts preview */}
      {unackAlerts > 0 && (
        <Card className="border-orange-200 dark:border-orange-900/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle size={16} className="text-orange-500" />
              Recent Alerts
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {alerts.filter(a => !a.acknowledged).slice(0, 3).map(alert => (
              <div key={alert.id} className="flex items-start gap-2 text-sm p-2 rounded-md bg-muted/50">
                {alert.severity === "critical"
                  ? <XCircle size={13} className="text-red-500 flex-shrink-0 mt-0.5" />
                  : alert.severity === "warning"
                  ? <AlertTriangle size={13} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                  : <Info size={13} className="text-blue-500 flex-shrink-0 mt-0.5" />
                }
                <p className="text-xs text-foreground leading-relaxed">{alert.message}</p>
              </div>
            ))}
            <Link href="/alerts">
              <Button variant="ghost" size="sm" className="text-xs">View all alerts →</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
