import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  AlignLeft,
  ArrowLeft,
  Check,
  ChevronDown,
  Clock,
  Copy,
  Download,
  Globe,
  Loader,
  Pause,
  Pencil,
  Play,
  Search,
  X,
} from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, Segment, Speaker, TranscriptDetail } from "@/lib/api";
import { SecondaryButton } from "@/components/ui/primitives";
import { useSetReaderTitle } from "@/lib/reader-title";
import { cn, formatDuration, formatFileSize, safeFilename } from "@/lib/utils";

/** Moved off green so a speaker never reads as the brand colour. */
const SPEAKER_COLORS = [
  "#7f9cf5", "#f2836b", "#e0b45c", "#b487f0",
  "#5fbdd1", "#e88ab0", "#9ac47a", "#d4956b",
];

const EXPORT_FORMATS = ["TXT", "SRT", "VTT", "JSON"] as const;
type ExportFormat = (typeof EXPORT_FORMATS)[number];

export default function Editor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [transcript, setTranscript] = useState<TranscriptDetail | null>(null);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingSpeaker, setEditingSpeaker] = useState<number | null>(null);
  const [speakerName, setSpeakerName] = useState("");
  const [findQuery, setFindQuery] = useState("");
  const [copied, setCopied] = useState(false);

  // Player
  const waveContainerRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<import("wavesurfer.js").default | null>(null);
  const [waveReady, setWaveReady] = useState(false);
  const [waveError, setWaveError] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);

  const listRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  useSetReaderTitle(transcript?.title);

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    api.transcripts
      .get(id)
      .then((t) => { setTranscript(t); setSpeakers(t.speakers); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // ── Waveform ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!transcript?.source_path || !transcript.source_available) return;
    if (!waveContainerRef.current) return;

    let destroyed = false;
    (async () => {
      try {
        const WaveSurfer = (await import("wavesurfer.js")).default;
        if (destroyed || !waveContainerRef.current) return;

        const ws = WaveSurfer.create({
          container: waveContainerRef.current,
          waveColor: "rgba(255,255,255,0.2)",
          progressColor: "#7FBE95",
          cursorColor: "transparent",
          height: 40,
          barWidth: 3,
          barGap: 2,
          barRadius: 2,
          normalize: true,
          interact: true,
        });
        wavesurferRef.current = ws;

        ws.on("ready", () => { setWaveReady(true); setDuration(ws.getDuration()); });
        ws.on("play", () => setPlaying(true));
        ws.on("pause", () => setPlaying(false));
        ws.on("finish", () => setPlaying(false));
        ws.on("timeupdate", (t) => setTime(t));
        ws.on("error", () => { if (!destroyed) setWaveError(true); });

        ws.load(convertFileSrc(transcript.source_path!));
      } catch {
        if (!destroyed) setWaveError(true);
      }
    })();

    return () => {
      destroyed = true;
      wavesurferRef.current?.destroy();
      wavesurferRef.current = null;
      setWaveReady(false);
      setPlaying(false);
      setWaveError(false);
    };
  }, [transcript?.source_path, transcript?.source_available]);

  const seekTo = useCallback((seconds: number) => {
    const ws = wavesurferRef.current;
    if (!ws || !waveReady) return;
    ws.seekTo(Math.max(0, Math.min(1, seconds / ws.getDuration())));
  }, [waveReady]);

  const togglePlay = useCallback(() => { wavesurferRef.current?.playPause(); }, []);

  function cycleRate() {
    const rates = [1, 1.25, 1.5, 2, 0.75];
    const next = rates[(rates.indexOf(rate) + 1) % rates.length];
    setRate(next);
    wavesurferRef.current?.setPlaybackRate(next);
  }

  // Which segment is playing — drives the highlight and the auto-follow.
  const activeSegmentId = useMemo(() => {
    if (!transcript || !playing) return null;
    const seg = transcript.segments.find((s) => time >= s.start && time < s.end);
    return seg?.id ?? null;
  }, [transcript, time, playing]);

  // Follow playback by setting scrollTop directly — scrollIntoView would drag
  // the whole pane around.
  useEffect(() => {
    if (activeSegmentId == null || !listRef.current) return;
    const list = listRef.current;
    const row = list.querySelector<HTMLElement>(`[data-seg="${activeSegmentId}"]`);
    if (!row) return;
    list.scrollTop = Math.max(0, row.offsetTop - list.clientHeight / 2 + row.clientHeight / 2);
  }, [activeSegmentId]);

  // ── Keyboard: Ctrl+F find, Space play/pause ─────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        findRef.current?.focus();
      } else if (e.key === " " && !typing) {
        e.preventDefault();
        togglePlay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay]);

  // ── Speakers ────────────────────────────────────────────────────────────
  const colorFor = useCallback(
    (label: string | null): string => {
      if (!label) return "#98a1af";
      const sp = speakers.find((s) => s.label === label);
      if (sp?.color) return sp.color;
      const idx = speakers.findIndex((s) => s.label === label);
      return SPEAKER_COLORS[(idx < 0 ? 0 : idx) % SPEAKER_COLORS.length];
    },
    [speakers]
  );

  const nameFor = useCallback(
    (label: string | null): string => {
      const sp = label ? speakers.find((s) => s.label === label) : undefined;
      return sp?.name || sp?.label || label || "";
    },
    [speakers]
  );

  async function saveSpeakerName(speaker: Speaker) {
    if (!id || !speakerName.trim()) { setEditingSpeaker(null); return; }
    try {
      const updated = await api.transcripts.updateSpeaker(id, speaker.id, speakerName.trim());
      setSpeakers((prev) => prev.map((s) => (s.id === speaker.id ? updated : s)));
    } catch { /* leave the previous name in place */ }
    setEditingSpeaker(null);
  }

  // ── Export ──────────────────────────────────────────────────────────────
  const buildText = useCallback(
    (format: ExportFormat): string => {
      if (!transcript) return "";
      const segs = transcript.segments;
      if (format === "TXT") {
        return segs
          .map((s) => `${s.speaker_label ? `[${nameFor(s.speaker_label)}] ` : ""}${s.text.trim()}`)
          .join("\n");
      }
      if (format === "JSON") return JSON.stringify(transcript, null, 2);
      if (format === "SRT") {
        return segs
          .map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text.trim()}\n`)
          .join("\n");
      }
      const lines = ["WEBVTT", ""];
      segs.forEach((s, i) => {
        lines.push(`${i + 1}`, `${vttTime(s.start)} --> ${vttTime(s.end)}`, s.text.trim(), "");
      });
      return lines.join("\n");
    },
    [transcript, nameFor]
  );

  function exportAs(format: ExportFormat) {
    if (!transcript) return;
    const mime =
      format === "JSON" ? "application/json" : format === "VTT" ? "text/vtt" : "text/plain";
    const url = URL.createObjectURL(new Blob([buildText(format)], { type: mime }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFilename(transcript.title)}.${format.toLowerCase()}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(buildText("TXT"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-text-dim">
        <Loader size={18} strokeWidth={1.75} className="animate-spin" />
        <span className="text-body">Loading transcript…</span>
      </div>
    );
  }

  if (error || !transcript) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-dim">
        <AlertCircle size={28} strokeWidth={1.75} className="text-danger" />
        <p className="text-body">{error ?? "Transcript not found"}</p>
        <SecondaryButton onClick={() => navigate("/")}>
          <ArrowLeft size={14} strokeWidth={1.75} />
          Back
        </SecondaryButton>
      </div>
    );
  }

  const usedSpeakers = speakers.filter((s) =>
    transcript.segments.some((seg) => seg.speaker_label === s.label)
  );
  const showPlayer = transcript.source_available && !waveError;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex h-16 flex-shrink-0 items-center gap-[14px] pl-[14px] pr-5">
        <button
          type="button"
          aria-label="Back"
          onClick={() => navigate("/")}
          className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-tile bg-fill text-text-tertiary transition-colors duration-[120ms] hover:bg-fill-strong"
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>

        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h2 font-semibold text-text">{transcript.title}</h1>
          <div className="tnum mt-0.5 flex items-center gap-[14px] text-meta text-text-dim">
            {transcript.duration != null && (
              <span className="flex items-center gap-1.5">
                <Clock size={12} strokeWidth={1.75} />
                {formatDuration(transcript.duration)}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <AlignLeft size={12} strokeWidth={1.75} />
              {transcript.word_count.toLocaleString()} words
            </span>
            {transcript.language && (
              <span className="flex items-center gap-1.5">
                <Globe size={12} strokeWidth={1.75} />
                {transcript.language.toUpperCase()}
                {transcript.language_probability != null &&
                  ` · ${Math.round(transcript.language_probability * 100)}%`}
              </span>
            )}
          </div>
        </div>

        <div className="flex h-[30px] w-[200px] flex-shrink-0 items-center gap-2 rounded-[15px] border border-stroke-strong bg-input px-3">
          <Search size={14} strokeWidth={1.75} className="flex-shrink-0 text-text-dim" />
          <input
            ref={findRef}
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="Find in transcript"
            className="w-full min-w-0 bg-transparent text-[12.5px] text-text-secondary outline-none placeholder:text-text-dim"
          />
          {findQuery && (
            <button type="button" aria-label="Clear search" onClick={() => setFindQuery("")}>
              <X size={13} strokeWidth={1.75} className="text-text-dim hover:text-text-strong" />
            </button>
          )}
        </div>

        <ExportMenu onExport={exportAs} />
      </header>

      {/* ── Player ─────────────────────────────────────────────────── */}
      {showPlayer && (
        <div className="mx-5 flex items-center gap-3 rounded-card border border-stroke bg-card px-[14px] py-2.5">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={togglePlay}
            disabled={!waveReady}
            className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-full bg-accent-fill text-white transition-opacity duration-[120ms] disabled:opacity-40"
          >
            {playing ? (
              <Pause size={15} strokeWidth={1.75} className="fill-current" />
            ) : (
              <Play size={15} strokeWidth={1.75} className="fill-current" />
            )}
          </button>

          <div className="min-w-0 flex-1">
            <div ref={waveContainerRef} className="w-full" />
            {!waveReady && (
              <div className="flex items-center gap-1.5 py-3 text-meta text-text-dim">
                <Loader size={12} strokeWidth={1.75} className="animate-spin" />
                Loading audio…
              </div>
            )}
          </div>

          <span className="tnum flex-shrink-0 text-meta text-text-muted">
            {formatDuration(time)} / {formatDuration(duration)}
          </span>
          <button
            type="button"
            onClick={cycleRate}
            aria-label="Playback speed"
            className="tnum h-6 flex-shrink-0 rounded-chip border border-stroke-strong px-2 text-[11px] text-text-muted transition-colors duration-[120ms] hover:text-text-strong"
          >
            {rate}×
          </button>
        </div>
      )}

      {/* ── Body ───────────────────────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 gap-[18px] px-5 pt-3.5">
        <div ref={listRef} className="min-w-0 flex-1 overflow-y-auto pb-6">
          {transcript.segments.map((seg) => (
            <SegmentRow
              key={seg.id}
              segment={seg}
              active={seg.id === activeSegmentId}
              speakerName={nameFor(seg.speaker_label)}
              speakerColor={colorFor(seg.speaker_label)}
              query={findQuery}
              onSeek={() => seekTo(seg.start)}
              seekable={waveReady}
            />
          ))}
        </div>

        <aside className="hidden w-[244px] flex-shrink-0 flex-col gap-[18px] overflow-y-auto pb-6 lg:flex">
          {usedSpeakers.length > 0 && (
            <SidebarSection label="Speakers">
              {usedSpeakers.map((sp) => (
                <div
                  key={sp.id}
                  className="flex h-8 items-center gap-2 rounded-control bg-fill-subtle px-2.5"
                >
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: colorFor(sp.label) }}
                  />
                  {editingSpeaker === sp.id ? (
                    <input
                      autoFocus
                      value={speakerName}
                      onChange={(e) => setSpeakerName(e.target.value)}
                      onBlur={() => saveSpeakerName(sp)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") saveSpeakerName(sp);
                        if (e.key === "Escape") setEditingSpeaker(null);
                      }}
                      className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-strong outline-none"
                    />
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-secondary">
                        {nameFor(sp.label)}
                      </span>
                      <button
                        type="button"
                        aria-label={`Rename ${nameFor(sp.label)}`}
                        onClick={() => { setEditingSpeaker(sp.id); setSpeakerName(sp.name ?? sp.label); }}
                        className="flex-shrink-0 text-text-dim transition-colors duration-[120ms] hover:text-text-strong"
                      >
                        <Pencil size={13} strokeWidth={1.75} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </SidebarSection>
          )}

          <SidebarSection label="Export">
            <div className="flex flex-wrap gap-1.5">
              {EXPORT_FORMATS.map((f) => (
                <Chip key={f} onClick={() => exportAs(f)}>{f}</Chip>
              ))}
              <Chip onClick={copyAll}>
                {copied ? (
                  <Check size={12} strokeWidth={1.75} className="text-accent-ink" />
                ) : (
                  <Copy size={12} strokeWidth={1.75} />
                )}
                {copied ? "Copied" : "Copy all"}
              </Chip>
            </div>
          </SidebarSection>

          <SidebarSection label="Source">
            {transcript.source_available ? (
              <>
                <p className="break-all text-meta text-text-muted">{transcript.source_path}</p>
                <p className="tnum text-meta text-text-dim">
                  {[
                    transcript.duration != null ? formatDuration(transcript.duration) : null,
                    transcript.source_size_bytes != null
                      ? formatFileSize(transcript.source_size_bytes)
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </>
            ) : (
              <p className="text-meta text-text-dim">Original file no longer on disk</p>
            )}
          </SidebarSection>
        </aside>
      </div>
    </div>
  );
}

/* ── Pieces ─────────────────────────────────────────────────────────────── */

function SegmentRow({
  segment,
  active,
  speakerName,
  speakerColor,
  query,
  onSeek,
  seekable,
}: {
  segment: Segment;
  active: boolean;
  speakerName: string;
  speakerColor: string;
  query: string;
  onSeek: () => void;
  seekable: boolean;
}) {
  return (
    <div
      data-seg={segment.id}
      className={cn(
        "flex gap-[14px] border-b border-hairline px-1.5 py-[11px]",
        active && "rounded-segment border-transparent bg-accent-ink/[0.05]"
      )}
    >
      <button
        type="button"
        onClick={onSeek}
        disabled={!seekable}
        title={seekable ? `Jump to ${formatDuration(segment.start)}` : undefined}
        className={cn(
          "tnum h-fit w-[46px] flex-shrink-0 text-left text-meta transition-colors duration-[120ms]",
          active ? "text-accent-ink" : "text-text-dim",
          seekable && "hover:text-accent-ink"
        )}
      >
        {formatDuration(segment.start)}
      </button>

      {speakerName && (
        <span
          className="w-[74px] flex-shrink-0 truncate text-[12px] font-semibold"
          style={{ color: speakerColor }}
        >
          {speakerName}
        </span>
      )}

      <p
        className={cn("flex-1 text-reader", active ? "text-text-strong" : "text-text-body")}
        style={{ textWrap: "pretty" } as React.CSSProperties}
      >
        <Highlight text={segment.text.trim()} query={query} />
      </p>
    </div>
  );
}

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "ig"));
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="rounded-[3px] bg-accent-ink/[0.22] text-inherit">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function SidebarSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[9px] border-b border-stroke pb-[18px] last:border-b-0">
      <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-dim">
        {label}
      </span>
      {children}
    </section>
  );
}

function Chip({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-7 items-center gap-1.5 rounded-chip border border-stroke-strong bg-fill px-2.5 text-meta text-text-secondary transition-colors duration-[120ms] hover:bg-fill-strong"
    >
      {children}
    </button>
  );
}

function ExportMenu({ onExport }: { onExport: (f: ExportFormat) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <SecondaryButton onClick={() => setOpen((v) => !v)}>
        <Download size={14} strokeWidth={1.75} />
        Export
        <ChevronDown size={13} strokeWidth={1.75} />
      </SecondaryButton>
      {open && (
        <div className="absolute right-0 top-9 z-30 w-36 overflow-hidden rounded-tile border border-stroke-strong bg-card py-1 shadow-modal">
          {EXPORT_FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => { onExport(f); setOpen(false); }}
              className="block w-full px-3 py-1.5 text-left text-[12.5px] text-text-secondary transition-colors duration-[120ms] hover:bg-fill"
            >
              {f}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function srtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function vttTime(seconds: number): string {
  return srtTime(seconds).replace(",", ".");
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}
