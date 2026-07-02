import { Switch, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider, useAuth } from "@/lib/auth";
import Dashboard from "./pages/Dashboard";
import FieldAnalysis from "./pages/FieldAnalysis";
import TimeSeries from "./pages/TimeSeries";
import Alerts from "./pages/Alerts";
import SpatialMaps from "./pages/SpatialMaps";
import NotFound from "./pages/not-found";
import AppShell from "./components/AppShell";
import Login from "./pages/Login";
import { useEffect } from "react";

// Keep the backend sandbox alive — ping every 4 minutes to prevent 503 cold-starts
function useKeepAlive() {
  useEffect(() => {
    const ping = () => fetch("/api/ping", { credentials: "include" }).catch(() => {});
    ping(); // ping immediately on load
    const interval = setInterval(ping, 4 * 60 * 1000); // every 4 minutes
    return () => clearInterval(interval);
  }, []);
}

function AppRoutes() {
  const { user, loading } = useAuth();

  // Show nothing while checking session
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-[#0f2a3f] via-[#1a3a52] to-[#0d2233]">
        <div className="flex flex-col items-center gap-3">
          <img src="./narrowtech-logo.png" alt="NarrowTech GS" className="h-14 w-auto animate-pulse" />
          <p className="text-slate-400 text-sm">Loading…</p>
        </div>
      </div>
    );
  }

  // Not logged in → show Login page
  if (!user) {
    return <Login />;
  }

  // Logged in → full app
  return (
    <Router hook={useHashLocation}>
      <AppShell>
        <Switch>
          <Route path="/" component={Dashboard} />
          <Route path="/analyze" component={FieldAnalysis} />
          <Route path="/timeseries" component={TimeSeries} />
          <Route path="/alerts" component={Alerts} />
          <Route path="/maps" component={SpatialMaps} />
          <Route component={NotFound} />
        </Switch>
      </AppShell>
    </Router>
  );
}

function KeepAlive() {
  useKeepAlive();
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <KeepAlive />
        <AppRoutes />
        <Toaster />
      </AuthProvider>
    </QueryClientProvider>
  );
}
