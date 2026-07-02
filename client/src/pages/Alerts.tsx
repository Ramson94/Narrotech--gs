import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Alert, Field } from "@shared/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, CheckCircle2, Info, XCircle, BellOff, Bell } from "lucide-react";

const SEVERITY_CONFIG = {
  critical: {
    icon: XCircle,
    color: "text-red-600 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-900/50",
    badge: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400",
    label: "Critical",
  },
  warning: {
    icon: AlertTriangle,
    color: "text-yellow-600 dark:text-yellow-400",
    bg: "bg-yellow-50 dark:bg-yellow-950/30 border-yellow-200 dark:border-yellow-900/50",
    badge: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400",
    label: "Warning",
  },
  info: {
    icon: Info,
    color: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/50",
    badge: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400",
    label: "Info",
  },
};

export default function Alerts() {
  const { toast } = useToast();

  const { data: alerts = [], isLoading } = useQuery<Alert[]>({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: fields = [] } = useQuery<Field[]>({
    queryKey: ["/api/fields"],
    queryFn: () => apiRequest("GET", "/api/fields").then(r => r.json()),
  });

  const ackMutation = useMutation({
    mutationFn: (id: number) => apiRequest("PATCH", `/api/alerts/${id}/acknowledge`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
    },
  });

  const ackAllMutation = useMutation({
    mutationFn: async () => {
      const unacked = alerts.filter(a => !a.acknowledged);
      await Promise.all(unacked.map(a => apiRequest("PATCH", `/api/alerts/${a.id}/acknowledge`)));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/alerts"] });
      toast({ title: "All alerts acknowledged" });
    },
  });

  const unacked = alerts.filter(a => !a.acknowledged);
  const acked = alerts.filter(a => a.acknowledged);

  const getFieldName = (fieldId: number) =>
    fields.find(f => f.id === fieldId)?.name ?? `Field #${fieldId}`;

  if (isLoading) {
    return <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-20" />)}</div>;
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-foreground">Alerts</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {unacked.length} unacknowledged · {acked.length} resolved
          </p>
        </div>
        {unacked.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="gap-2 flex-shrink-0"
            onClick={() => ackAllMutation.mutate()}
            disabled={ackAllMutation.isPending}
            data-testid="button-ack-all"
          >
            <CheckCircle2 size={14} />
            Acknowledge All
          </Button>
        )}
      </div>

      {alerts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-16 flex flex-col items-center gap-3 text-center">
            <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <Bell size={20} className="text-green-600 dark:text-green-400" />
            </div>
            <div>
              <p className="font-medium text-foreground">No alerts</p>
              <p className="text-sm text-muted-foreground mt-1">
                Alerts will appear here when NDVI or water stress thresholds are exceeded after field analysis.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Active alerts */}
          {unacked.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <Bell size={11} />
                Active ({unacked.length})
              </p>
              {["critical", "warning", "info"].map(severity =>
                unacked.filter(a => a.severity === severity).map(alert => {
                  const cfg = SEVERITY_CONFIG[severity as keyof typeof SEVERITY_CONFIG];
                  const Icon = cfg.icon;
                  return (
                    <Card
                      key={alert.id}
                      data-testid={`alert-card-${alert.id}`}
                      className={`border ${cfg.bg}`}
                    >
                      <CardContent className="p-4 flex items-start gap-3">
                        <Icon size={16} className={`${cfg.color} flex-shrink-0 mt-0.5`} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <Badge className={`text-xs ${cfg.badge}`}>{cfg.label}</Badge>
                            <span className="text-xs text-muted-foreground">{getFieldName(alert.fieldId)}</span>
                          </div>
                          <p className="text-sm text-foreground leading-relaxed">{alert.message}</p>
                          <p className="text-xs text-muted-foreground mt-1.5">
                            {new Date(alert.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs flex-shrink-0 gap-1"
                          onClick={() => ackMutation.mutate(alert.id)}
                          disabled={ackMutation.isPending}
                          data-testid={`button-ack-${alert.id}`}
                        >
                          <CheckCircle2 size={12} />
                          Dismiss
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          )}

          {/* Acknowledged */}
          {acked.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                <BellOff size={11} />
                Resolved ({acked.length})
              </p>
              {acked.map(alert => (
                <Card key={alert.id} className="opacity-50" data-testid={`alert-resolved-${alert.id}`}>
                  <CardContent className="p-3 flex items-center gap-3">
                    <CheckCircle2 size={14} className="text-green-500 flex-shrink-0" />
                    <p className="text-sm text-muted-foreground flex-1 truncate">{alert.message}</p>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {new Date(alert.createdAt).toLocaleDateString()}
                    </span>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Alert threshold reference */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Alert Thresholds</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-xs">
            {[
              { icon: XCircle, color: "text-red-500", label: "Critical: NDVI < 0.2", desc: "Possible crop failure or bare soil" },
              { icon: XCircle, color: "text-red-500", label: "Critical: MSI > 1.2", desc: "Severe drought stress — immediate irrigation needed" },
              { icon: AlertTriangle, color: "text-yellow-500", label: "Warning: NDVI 0.2–0.35", desc: "Low vegetation density, check for pest/nutrient stress" },
              { icon: AlertTriangle, color: "text-yellow-500", label: "Warning: MSI 1.0–1.2", desc: "Moderate water stress — consider irrigation" },
              { icon: AlertTriangle, color: "text-yellow-500", label: "Warning: EVI < 0.1", desc: "Critically low canopy vigor — possible crop stress or bare soil" },
              { icon: Info, color: "text-blue-500", label: "Info: NDVI > 0.7 + MSI < 0.6", desc: "Excellent crop health — good moisture status" },
            ].map(({ icon: Icon, color, label, desc }) => (
              <div key={label} className="flex items-start gap-2">
                <Icon size={12} className={`${color} flex-shrink-0 mt-0.5`} />
                <div>
                  <span className="font-medium text-foreground">{label}</span>
                  <span className="text-muted-foreground"> — {desc}</span>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
