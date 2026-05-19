import { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Home, Cpu, Settings, Mic } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEngineHealth } from "@/hooks/useEngine";

const NAV = [
  { to: "/", icon: Home, label: "Dashboard" },
  { to: "/models", icon: Cpu, label: "Models" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

export default function Layout({ children }: { children: ReactNode }) {
  const { healthy, checking } = useEngineHealth();

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {/* Sidebar */}
      <aside className="flex w-52 flex-shrink-0 flex-col border-r border-border bg-card">
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 py-4 border-b border-border">
          <Mic className="h-5 w-5 text-primary" />
          <span className="font-semibold tracking-tight text-foreground">WinWhisper</span>
        </div>

        {/* Nav */}
        <nav className="flex-1 space-y-0.5 p-2 pt-3">
          {NAV.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                )
              }
            >
              <Icon className="h-4 w-4 flex-shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Engine status */}
        <div className="border-t border-border p-3">
          <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                checking
                  ? "bg-yellow-400 animate-pulse"
                  : healthy
                  ? "bg-green-500"
                  : "bg-red-500"
              )}
            />
            <span>{checking ? "Connecting…" : healthy ? "Engine ready" : "Engine offline"}</span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
