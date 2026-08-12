import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Mic, Square } from "lucide-react";
import { api } from "@/lib/api";
import { PrimaryButton, SecondaryButton } from "@/components/ui/primitives";
import { cn, formatDuration } from "@/lib/utils";

/**
 * The floating capture windows: recorder, dictation HUD and completion toast.
 *
 * Each is its own always-on-top Tauri window loading the same bundle with
 * `?window=<kind>`, so they share the token layer and components. They are dark
 * only — they sit over whatever the user is doing, not inside the app.
 */

async function closeSelf(kind: string) {
  try {
    await invoke("close_capture_window", { kind });
  } catch {
    /* not under Tauri */
  }
}

/* ── Level meter ────────────────────────────────────────────────────────── */

/**
 * Bars driven by the engine's RMS level. Each bar keeps a little of its own
 * history so the meter moves like audio rather than flashing as one block.
 */
function LevelMeter({
  level,
  bars,
  height,
  className,
}: {
  level: number;
  bars: number;
  height: number;
  className?: string;
}) {
  const [scales, setScales] = useState<number[]>(() => new Array(bars).fill(0.22));
  const latest = useRef(level);
  latest.current = level;

  // Driven by a timer rather than by changes to `level`: a steady input still
  // has to look like moving audio, and it would otherwise freeze whenever the
  // measured level happened to repeat.
  useEffect(() => {
    const id = setInterval(() => {
      setScales((prev) => {
        const next = prev.slice();
        const mid = Math.floor(bars / 2);
        for (let i = 0; i < bars; i++) {
          // Loudest in the middle, tapering outwards, so the shape reads as a
          // waveform rather than a bar chart.
          const distance = Math.abs(i - mid) / Math.max(1, mid);
          const target =
            latest.current * (1 - distance * 0.5) * (0.6 + Math.random() * 0.8);
          next[i] = next[i] * 0.45 + Math.min(1, Math.max(0.12, target)) * 0.55;
        }
        return next;
      });
    }, 90);
    return () => clearInterval(id);
  }, [bars]);

  return (
    <div className={cn("flex flex-1 items-center gap-[2px]", className)} style={{ height }}>
      {scales.map((s, i) => (
        <span
          key={i}
          className="flex-1 origin-center rounded-[2px] bg-accent-ink transition-transform duration-100 ease-out"
          style={{ height, transform: `scaleY(${Math.max(0.12, s)})` }}
        />
      ))}
    </div>
  );
}

/* ── Recorder ───────────────────────────────────────────────────────────── */

export function RecorderWindow() {
  const [status, setStatus] = useState<{
    active: boolean;
    duration_seconds: number;
    device_name: string | null;
    level: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(location.search);
  const model = params.get("model") ?? "base";

  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const s = await api.audio.status();
        if (stopped) return;
        setStatus(s as typeof status);
        // The engine is the source of truth: if capture ended elsewhere, go away.
        if (!s.active) closeSelf("recorder");
      } catch {
        /* engine unreachable */
      }
    };
    poll();
    const id = setInterval(poll, 120);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  async function stopAndTranscribe() {
    setBusy(true);
    try {
      await api.audio.stopCapture({ transcribe: true, model_name: model });
    } catch { /* surfaced in the main window's job list */ }
    closeSelf("recorder");
  }

  async function discard() {
    setBusy(true);
    try {
      await api.audio.stopCapture({ transcribe: false });
    } catch { /* nothing to clean up */ }
    closeSelf("recorder");
  }

  return (
    <FloatingShell className="gap-[14px] rounded-modal px-[18px] py-4">
      <div className="flex items-center gap-2.5">
        <span className="h-2 w-2 flex-shrink-0 animate-pulse-dot rounded-full bg-danger" />
        <span className="text-label font-semibold text-text-strong">Recording</span>
        <span className="min-w-0 truncate text-meta text-text-dim">
          {status?.device_name ?? "System audio"}
        </span>
        <div className="flex-1" />
        <span className="tnum text-[15px] font-semibold text-text-strong">
          {formatDuration(status?.duration_seconds ?? 0)}
        </span>
      </div>

      <LevelMeter level={status?.level ?? 0} bars={44} height={28} />

      <div className="flex items-center gap-2">
        <PrimaryButton onClick={stopAndTranscribe} disabled={busy} className="flex-1 justify-center">
          <Square size={14} strokeWidth={1.75} className="fill-current" />
          Stop &amp; transcribe
        </PrimaryButton>
        <SecondaryButton onClick={discard} disabled={busy}>
          Discard
        </SecondaryButton>
      </div>
    </FloatingShell>
  );
}

/* ── Dictation HUD ──────────────────────────────────────────────────────── */

export function DictationHud() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const tick = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(tick);
  }, []);

  // Shown for exactly as long as the hotkey is held.
  useEffect(() => {
    let stopped = false;
    const poll = async () => {
      try {
        const s = await api.dictation.status();
        if (!stopped && !s.is_recording) closeSelf("dictation");
      } catch { /* engine unreachable */ }
    };
    const id = setInterval(poll, 200);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // The dictation stream has no level feed of its own; the spec's animated
  // meter stands in for it here.
  const [pulse, setPulse] = useState(0.5);
  useEffect(() => {
    const id = setInterval(() => setPulse(0.35 + Math.random() * 0.5), 140);
    return () => clearInterval(id);
  }, []);

  return (
    <FloatingShell className="flex-row items-center gap-[13px] rounded-[20px] px-4 py-3">
      <div className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full bg-danger/[0.14]">
        <Mic size={14} strokeWidth={1.75} className="text-danger" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label font-semibold text-text-strong">
          Listening — release to insert
        </p>
        <LevelMeter level={pulse} bars={26} height={12} className="mt-1 opacity-60" />
      </div>
      <span className="tnum flex-shrink-0 text-meta text-text-muted">
        {formatDuration(seconds)}
      </span>
    </FloatingShell>
  );
}

/* ── Completion toast ───────────────────────────────────────────────────── */

export function CompletionToast() {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const name = params.get("name") ?? "Transcript";
  const meta = params.get("meta") ?? "";
  const transcriptId = params.get("id");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    timer.current = setTimeout(() => closeSelf("toast"), 6000);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, []);

  const open = useCallback(async () => {
    try {
      await invoke("focus_main_window");
      if (transcriptId) {
        // The main window listens for this and routes to the transcript.
        localStorage.setItem("ww-open-transcript", transcriptId);
      }
    } catch { /* not under Tauri */ }
    closeSelf("toast");
  }, [transcriptId]);

  return (
    <FloatingShell className="flex-row items-center gap-3 rounded-[12px] px-3.5 py-3">
      <div className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-tile bg-accent-ink/[0.14]">
        <Check size={15} strokeWidth={1.75} className="text-accent-ink" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-label font-semibold text-text-strong">{name} transcribed</p>
        {meta && <p className="tnum truncate text-meta text-text-dim">{meta}</p>}
      </div>
      <SecondaryButton onClick={open} className="h-7 flex-shrink-0">
        Open
      </SecondaryButton>
    </FloatingShell>
  );
}

/* ── Shared shell ───────────────────────────────────────────────────────── */

function FloatingShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-full w-full select-none flex-col border border-white/[0.11] shadow-floating",
        className
      )}
      style={{
        background: "linear-gradient(150deg, #1e232b, #14171d)",
      }}
    >
      {children}
    </div>
  );
}
