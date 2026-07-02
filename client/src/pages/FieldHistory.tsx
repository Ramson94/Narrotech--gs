import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Field } from "@shared/schema";
import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip,
  ResponsiveContainer, ReferenceLine, Legend
} from "recharts";
import { Leaf, Droplets, Calendar, RefreshCw, Trash2, MapPin, TrendingUp, TrendingDown, Sprout } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger
} from "@/components/ui/alert-dialog";

function NdviChart({ ndviHistory, fieldName }: { ndviHistory: string | null, fieldName: string }) {
  if (!ndviHistory) return (
    <div className="flex items-center justify-center h-24 text-sm text-muted-foreground">
      Run analysis to see NDVI history
    </div>
  );
  const data = JSON.parse(ndviHistory).map((d: { date: string, value: number }) => ({
    date: new Date(d.date).toLocaleString("en", { month: "short" }),
    NDVI: d.value,
  }));
  return (
    <ResponsiveContainer width="100%" height={120}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="date" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
        <YAxis domain={[0, 1]} tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
        <ChartTooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
            fontSize: "12px",
          }}
        />
        <ReferenceLine y={0.4} stroke="#eab308" strokeDasharray="4 2" label={{ value: "Threshold", fontSize: 10, fill: "#eab308" }} />
        <Line
          type="monotone" dataKey="NDVI" stroke="#22c55e"
          strokeWidth={2} dot={{ fill: "#22c55e", r: 2 }}
          activeDot={{ r: 4 }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function HealthBar({ score }: { score: number | null }) {
  if (score === null) return <div className="h-2 bg-muted rounded-full" />;
  const color = score >= 70 ? "bg-green-500" : score >= 45 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="h-2 bg-muted rounded-full overflow-hidden">
      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${score}%` }} />
    </div>
  );
}

export default function FieldHistory() {
  const { toast } = useToast();
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data: fields = [], isLoading } = useQuery<Field[]>({
    queryKey: ["/api/fields"],
    queryFn: () => apiRequest("GET", "/api/fields").then(r => r.json()),
  });

  const analyzeMutation = useMutation({
    mutationFn: (id: number) => apiRequest("POST", `/api/fields/${id}/analyze`).then(r => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "Re-analysis complete", description: "Updated NDVI and water stress data." });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/fields/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/fields"] });
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      setSelectedId(null);
      toast({ title: "Field deleted" });
    },
  });

  const analyzed = fields.filter(f => f.status !== "pending");
  const selected = selectedId ? fields.find(f => f.id === selectedId) : null;

  if (isLoading) {
    return <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-32" />)}</div>;
  }

  return (
    <div className="max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-bold text-foreground">Field History</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {analyzed.length} analyzed field{analyzed.length !== 1 ? "s" : ""} · NDVI time-series and historical records
        </p>
      </div>

      {fields.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-12 text-center text-muted-foreground text-sm">
            No fields in history yet. Add and analyze a field to see records here.
          </CardContent>
        </Card>
      ) : (
        <div className="grid lg:grid-cols-3 gap-6">
          {/* Field list */}
          <div className="space-y-3 lg:col-span-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">All Fields</p>
            {fields.map(field => (
              <Card
                key={field.id}
                data-testid={`card-history-${field.id}`}
                className={`cursor-pointer transition-all hover:shadow-md ${selectedId === field.id ? "ring-2 ring-primary" : ""}`}
                onClick={() => setSelectedId(selectedId === field.id ? null : field.id)}
              >
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm truncate">{field.name}</p>
                      <p className="text-xs text-muted-foreground">{field.region || "Ghana"}</p>
                    </div>
                    <Badge
                      variant={field.status === "alert" ? "destructive" : field.status === "analyzed" ? "outline" : "secondary"}
                      className="text-xs flex-shrink-0"
                    >
                      {field.status}
                    </Badge>
                  </div>
                  <HealthBar score={field.healthScore ?? null} />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Score: {field.healthScore ?? "—"}/100</span>
                    <span>NDVI: {field.ndvi?.toFixed(3) ?? "—"}</span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-2">
            {!selected ? (
              <Card className="border-dashed h-full flex items-center justify-center">
                <CardContent className="py-16 text-center text-muted-foreground text-sm">
                  <TrendingUp size={32} className="mx-auto mb-3 opacity-30" />
                  Select a field to view detailed analysis
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-4">
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <CardTitle className="text-lg">{selected.name}</CardTitle>
                        <p className="text-sm text-muted-foreground mt-1">
                          {selected.region} · {selected.cropType || "Unknown crop"}
                        </p>
                      </div>
                      <div className="flex gap-2 flex-shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => analyzeMutation.mutate(selected.id)}
                          disabled={analyzeMutation.isPending}
                          data-testid={`button-reanalyze-${selected.id}`}
                        >
                          <RefreshCw size={13} className={analyzeMutation.isPending ? "animate-spin" : ""} />
                          Re-analyze
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="sm" className="gap-1.5 text-destructive hover:text-destructive">
                              <Trash2 size={13} />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete field?</AlertDialogTitle>
                              <AlertDialogDescription>
                                This will permanently remove "{selected.name}" and all its analysis data.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                className="bg-destructive text-destructive-foreground"
                                onClick={() => deleteMutation.mutate(selected.id)}
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Key metrics */}
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <div className="text-center p-3 rounded-lg bg-muted/40">
                        <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
                          <Leaf size={11} /> NDVI
                        </p>
                        <p className="text-xl font-bold font-mono text-foreground">
                          {selected.ndvi?.toFixed(3) ?? "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">{selected.ndvi !== null ? (selected.ndvi! >= 0.4 ? "Healthy" : "Stressed") : ""}</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/40">
                        <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
                          <Droplets size={11} /> MNDWI
                        </p>
                        <p className="text-xl font-bold font-mono text-foreground">
                          {selected.ndwi?.toFixed(3) ?? "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">{selected.ndwi !== null ? (selected.ndwi! > 0 ? "Adequate moisture" : selected.ndwi! > -0.2 ? "Mild stress" : "Water stressed") : ""}</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/40">
                        <p className="text-xs text-muted-foreground mb-1 flex items-center justify-center gap-1">
                          <Sprout size={11} /> EVI
                        </p>
                        <p className="text-xl font-bold font-mono text-foreground">
                          {selected.evi?.toFixed(3) ?? "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">{selected.evi !== null && selected.evi !== undefined ? (selected.evi! >= 0.35 ? "Good vigor" : selected.evi! >= 0.2 ? "Moderate" : "Sparse") : ""}</p>
                      </div>
                      <div className="text-center p-3 rounded-lg bg-muted/40">
                        <p className="text-xs text-muted-foreground mb-1">Health Score</p>
                        <p className={`text-xl font-bold font-mono ${selected.healthScore !== null ? (selected.healthScore! >= 70 ? "text-green-600 dark:text-green-400" : selected.healthScore! >= 45 ? "text-yellow-600 dark:text-yellow-400" : "text-red-600 dark:text-red-400") : "text-foreground"}`}>
                          {selected.healthScore ?? "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">out of 100</p>
                      </div>
                    </div>

                    {/* NDVI Chart */}
                    <div>
                      <p className="text-sm font-medium mb-2 flex items-center gap-2">
                        <TrendingUp size={14} className="text-primary" />
                        12-Month NDVI Trend
                      </p>
                      <NdviChart ndviHistory={selected.ndviHistory ?? null} fieldName={selected.name} />
                    </div>

                    {/* Coordinates */}
                    <div>
                      <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5 uppercase tracking-wider">
                        <MapPin size={11} /> Field Coordinates
                      </p>
                      <div className="grid grid-cols-2 gap-1.5">
                        {JSON.parse(selected.coordinates).map((c: { lat: number, lng: number }, i: number) => (
                          <div key={i} className="text-xs font-mono bg-muted/40 px-2 py-1.5 rounded">
                            {["NW", "NE", "SE", "SW"][i]}: {c.lat.toFixed(4)}, {c.lng.toFixed(4)}
                          </div>
                        ))}
                      </div>
                    </div>

                    {selected.analyzedAt && (
                      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                        <Calendar size={11} />
                        Last analyzed: {new Date(selected.analyzedAt).toLocaleString()}
                      </p>
                    )}

                    {selected.notes && (
                      <p className="text-sm text-muted-foreground bg-muted/40 rounded-md px-3 py-2">
                        {selected.notes}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {/* NDVI Interpretation Guide */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">NDVI Interpretation Guide</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="space-y-1.5">
                      {[
                        { range: "0.6 – 1.0", label: "Dense healthy vegetation", color: "#166534", bg: "bg-green-50 dark:bg-green-950/30" },
                        { range: "0.4 – 0.6", label: "Moderate vegetation, good growth", color: "#15803d", bg: "bg-emerald-50 dark:bg-emerald-950/30" },
                        { range: "0.25 – 0.4", label: "Sparse/stressed vegetation", color: "#ca8a04", bg: "bg-yellow-50 dark:bg-yellow-950/30" },
                        { range: "0.1 – 0.25", label: "Very sparse — possible stress/drought", color: "#ea580c", bg: "bg-orange-50 dark:bg-orange-950/30" },
                        { range: "0 – 0.1", label: "Bare soil, no vegetation", color: "#dc2626", bg: "bg-red-50 dark:bg-red-950/30" },
                      ].map(item => (
                        <div key={item.range} className={`flex items-center justify-between px-3 py-1.5 rounded text-xs ${item.bg}`}>
                          <span className="font-mono font-medium" style={{ color: item.color }}>{item.range}</span>
                          <span className="text-muted-foreground">{item.label}</span>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
