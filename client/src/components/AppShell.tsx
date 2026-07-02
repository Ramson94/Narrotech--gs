import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import type { Alert } from "@shared/schema";
import {
  LayoutDashboard, SatelliteDish, History, Bell, Menu, Sun, Moon, LogOut, UserCircle, Map
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function UserBadge() {
  const { user, logout } = useAuth();
  if (!user) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <UserCircle size={14} className="text-sidebar-foreground/60 shrink-0" />
        <div className="min-w-0">
          <p className="text-xs font-medium text-sidebar-foreground truncate">{user.name}</p>
          <p className="text-[10px] text-sidebar-foreground/50 truncate capitalize">{user.role}</p>
        </div>
      </div>
      <Button variant="ghost" size="icon" onClick={logout} title="Sign out"
        className="h-7 w-7 text-sidebar-foreground/50 hover:text-red-400 hover:bg-red-900/20 shrink-0">
        <LogOut size={13} />
      </Button>
    </div>
  );
}

const NAV_ITEMS = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/analyze", label: "Analyze Field", icon: SatelliteDish },
  { href: "/timeseries", label: "Time Series", icon: History },
  { href: "/maps", label: "Spatial Maps", icon: Map },
  { href: "/alerts", label: "Alerts", icon: Bell },
];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [dark, setDark] = useState(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );

  const toggleDark = () => {
    setDark(d => {
      const next = !d;
      document.documentElement.classList.toggle("dark", next);
      return next;
    });
  };

  const { data: alerts = [] } = useQuery<Alert[]>({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 30000,
  });

  const unacknowledgedCount = alerts.filter((a: Alert) => !a.acknowledged).length;

  const SidebarContent = () => (
    <div className="flex flex-col h-full">
      {/* Brand */}
      <div className="flex items-center gap-3 px-4 py-4 border-b border-sidebar-border">
        <img
          src="/narrowtech-logo.png"
          alt="NarrowTech GeoSolution Logo"
          className="w-10 h-10 object-contain rounded flex-shrink-0 bg-white p-0.5"
        />
        <div className="min-w-0">
          <p className="font-bold text-sm text-sidebar-foreground leading-tight truncate">NarrowTech GS</p>
          <p className="text-xs text-sidebar-foreground/80 leading-tight truncate">Crop Health Intelligence</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = location === href;
          return (
            <Link key={href} href={href}>
              <button
                data-testid={`nav-${label.toLowerCase().replace(/\s/g, "-")}`}
                onClick={() => setSidebarOpen(false)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-all ${
                  active
                    ? "bg-sidebar-primary text-sidebar-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
                }`}
              >
                <Icon size={16} />
                <span className="flex-1 text-left">{label}</span>
                {label === "Alerts" && unacknowledgedCount > 0 && (
                  <Badge variant="destructive" className="text-xs px-1.5 py-0 h-5">
                    {unacknowledgedCount}
                  </Badge>
                )}
              </button>
            </Link>
          );
        })}
      </nav>

      {/* Footer: user info + logout */}
      <div className="p-4 border-t border-sidebar-border space-y-3">
        <UserBadge />
        <div className="flex items-center gap-2 text-xs text-sidebar-foreground/80">
          <SatelliteDish size={12} />
          <span>Powered by Sentinel-2</span>
        </div>
        <p className="text-xs text-sidebar-foreground/60">ESA Copernicus Programme</p>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-58 flex-col bg-sidebar-background border-r border-sidebar-border flex-shrink-0" style={{ width: "228px" }}>
        <SidebarContent />
      </aside>

      {/* Mobile Sidebar Overlay */}
      {sidebarOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex">
          <div className="bg-sidebar-background flex flex-col shadow-xl" style={{ width: "228px" }}>
            <SidebarContent />
          </div>
          <div className="flex-1 bg-black/40" onClick={() => setSidebarOpen(false)} />
        </div>
      )}

      {/* Main area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card/80 backdrop-blur-sm flex-shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
            data-testid="button-menu"
          >
            <Menu size={18} />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-semibold text-foreground truncate">
              {NAV_ITEMS.find(n => n.href === location)?.label ?? "NarrowTech GS"}
            </h1>
            <p className="text-xs text-muted-foreground hidden sm:block">Ghana Agricultural Crop Monitoring · Sentinel-2</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleDark}
            data-testid="button-theme-toggle"
            aria-label="Toggle theme"
          >
            {dark ? <Sun size={16} /> : <Moon size={16} />}
          </Button>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto p-4 md:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
