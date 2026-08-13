import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { House, Cpu, Settings, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEngineState, type EngineState } from "@/hooks/useEngine";
import { Mark } from "@/components/Mark";

const NAV = [
  { to: "/", icon: House, label: "Dashboard" },
  { to: "/models", icon: Cpu, label: "Models" },
  { to: "/settings", icon: Settings, label: "Settings" },
] as const;

const RAIL_COLLAPSED = 56;
const RAIL_EXPANDED = 208;
const EXPAND_DELAY = 120;
const COLLAPSE_DELAY = 200;

/** Window controls talk to Tauri; in a browser they simply do nothing. */
async function windowAction(action: "minimize" | "toggleMaximize" | "close") {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    if (action === "minimize") await w.minimize();
    else if (action === "toggleMaximize") await w.toggleMaximize();
    else await w.close();
  } catch {
    // Running outside Tauri.
  }
}

export default function Layout({
  children,
  readerTitle,
}: {
  children: ReactNode;
  readerTitle?: string | null;
}) {
  const engineState = useEngineState();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const w = getCurrentWindow();
        setMaximized(await w.isMaximized());
        unlisten = await w.onResized(async () => setMaximized(await w.isMaximized()));
      } catch {
        // Not under Tauri.
      }
    })();
    return () => unlisten?.();
  }, []);

  return (
    // The window's own surface. Mica shows through where the platform supports
    // it; app-chrome is the gradient fallback.
    //
    // Deliberately square: Windows 11 rounds the window itself, and no CSS
    // radius we pick can track the OS one across versions and DPI. Rounding
    // here as well left a crescent in each corner that belonged to neither
    // shape — the white notches. Painting edge to edge lets the compositor do
    // the clipping, so the corner is whatever Windows says it is.
    <div className="app-chrome flex h-full flex-col overflow-hidden">
      <TitleBar maximized={maximized} readerTitle={readerTitle} />

      {/* The rail overlays the pane while expanded, so page content never
          reflows on hover — hence the fixed left offset rather than a flex gap. */}
      <div className="relative flex min-h-0 flex-1">
        <Rail engineState={engineState} />
        <main
          className="min-w-0 flex-1 overflow-hidden border-l border-t border-pane-edge bg-pane rounded-tl-pane"
          style={{ marginLeft: RAIL_COLLAPSED }}
        >
          {children}
        </main>
      </div>
    </div>
  );
}

function TitleBar({
  maximized,
  readerTitle,
}: {
  maximized: boolean;
  readerTitle?: string | null;
}) {
  return (
    <div
      data-tauri-drag-region
      className="flex h-10 flex-shrink-0 items-center pl-[14px] select-none"
    >
      <Mark size={14} className="pointer-events-none text-accent-ink" />
      <span
        data-tauri-drag-region
        className="pointer-events-none ml-[9px] truncate text-[12.5px] font-semibold tracking-[-0.005em] text-titlebar-text"
      >
        WinWhisper
        {readerTitle ? (
          <span className="text-titlebar-subtle"> — {readerTitle}</span>
        ) : null}
      </span>

      <div data-tauri-drag-region className="flex-1" />

      <div className="flex">
        <ControlCell label="Minimise" onClick={() => windowAction("minimize")}>
          <span className="block h-px w-[10px] bg-current" />
        </ControlCell>
        <ControlCell
          label={maximized ? "Restore" : "Maximise"}
          onClick={() => windowAction("toggleMaximize")}
        >
          {maximized ? (
            // Two-square restore mark
            <span className="relative block h-[9px] w-[9px]">
              <span className="absolute left-0 top-[2px] h-[7px] w-[7px] rounded-[1px] border border-current" />
              <span className="absolute left-[2px] top-0 h-[7px] w-[7px] rounded-[1px] border border-current bg-transparent" />
            </span>
          ) : (
            <span className="block h-[9px] w-[9px] rounded-[1px] border border-current" />
          )}
        </ControlCell>
        <ControlCell label="Close" onClick={() => windowAction("close")} danger>
          <X size={12} strokeWidth={1.75} />
        </ControlCell>
      </div>
    </div>
  );
}

function ControlCell({
  children,
  onClick,
  label,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex h-10 w-[46px] items-center justify-center text-titlebar-glyph transition-colors duration-[120ms]",
        danger
          ? "hover:bg-[#c42b1c] hover:text-white"
          : "hover:bg-fill"
      )}
    >
      {children}
    </button>
  );
}

function Rail({ engineState }: { engineState: EngineState }) {
  const [expanded, setExpanded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const location = useLocation();

  const schedule = useCallback((next: boolean) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => setExpanded(next),
      next ? EXPAND_DELAY : COLLAPSE_DELAY
    );
  }, []);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // The dot carries a 3px halo of its own colour at 15%. "Starting" covers the
  // cold start, which is tens of seconds — only a engine that has answered and
  // then stopped is reported as offline.
  // The title is what a hover reveals, and it is the only place the collapsed
  // rail can explain itself — "starting" on its own tells someone a minute into
  // a cold start nothing they did not already fear.
  const status =
    engineState === "starting"
      ? {
          label: "Starting up…",
          title: "Getting the transcription engine ready — about a minute after an update. Nothing is wrong.",
          dot: "bg-warning ring-warning/15",
          pulse: true,
        }
      : engineState === "ready"
      ? {
          label: "Engine ready",
          title: "The transcription engine is running on this machine.",
          dot: "bg-accent-ink ring-accent-ink/15",
          pulse: false,
        }
      : {
          label: "Engine offline",
          title: "The engine stopped responding. Restart WinWhisper; if it persists, check %APPDATA%\\WinWhisper\\engine.log.",
          dot: "bg-danger ring-danger/15",
          pulse: true,
        };

  return (
    <nav
      aria-label="Main"
      onMouseEnter={() => schedule(true)}
      onMouseLeave={() => schedule(false)}
      onFocus={() => setExpanded(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) schedule(false);
      }}
      style={{ width: expanded ? RAIL_EXPANDED : RAIL_COLLAPSED }}
      className={cn(
        "absolute inset-y-0 left-0 z-20 box-border flex flex-col gap-[3px] overflow-hidden px-2 pb-[10px] pt-1",
        "transition-[width] duration-rail ease-out",
        expanded && "app-chrome"
      )}
    >
      {NAV.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === "/"}
          title={expanded ? undefined : label}
          aria-current={
            (to === "/" ? location.pathname === "/" : location.pathname.startsWith(to))
              ? "page"
              : undefined
          }
          className={({ isActive }) =>
            cn(
              "relative flex h-[38px] flex-shrink-0 items-center rounded-control transition-colors duration-[120ms]",
              // 11px of clearance either side is what keeps the collapsed
              // 18px icon optically centred in the 56px rail.
              expanded ? "justify-start pl-[11px]" : "justify-center",
              isActive
                ? "bg-fill-strong text-text-strong"
                : "text-text-muted hover:bg-fill-subtle"
            )
          }
        >
          {({ isActive }) => (
            <>
              {isActive && (
                <span
                  aria-hidden
                  className="absolute left-[-4px] top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-[2px] bg-accent-ink"
                />
              )}
              <Icon size={18} strokeWidth={1.75} className="flex-shrink-0" />
              {/* Collapsed, the label must occupy no width at all. Left in the
                  layout at opacity-0 it pushes the icon off-centre and drags the
                  item's clickable centre outside the rail's overflow clip, which
                  makes the collapsed items unreliable to click. */}
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap text-[13px] font-medium transition-opacity duration-100",
                  expanded ? "ml-[13px] w-auto opacity-100" : "pointer-events-none w-0 opacity-0"
                )}
              >
                {label}
              </span>
            </>
          )}
        </NavLink>
      ))}

      <div className="flex-1" />

      <div
        className={cn(
          "flex h-[38px] flex-shrink-0 items-center",
          expanded ? "pl-[11px]" : "justify-center"
        )}
        title={status.title}
      >
        <span
          className={cn(
            "h-[7px] w-[7px] flex-shrink-0 rounded-full ring-[3px]",
            status.dot,
            status.pulse && "animate-pulse-dot"
          )}
        />
        <span
          className={cn(
            "overflow-hidden whitespace-nowrap text-meta text-text-dim transition-opacity duration-100",
            expanded ? "ml-[13px] w-auto opacity-100" : "pointer-events-none w-0 opacity-0"
          )}
        >
          {status.label}
        </span>
      </div>
    </nav>
  );
}
