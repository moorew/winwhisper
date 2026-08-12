import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  Upload,
  Youtube,
  Search,
  Trash2,
  FileAudio,
  Clock,
  AlignLeft,
  Loader2,
  AlertCircle,
  RefreshCw,
  Mic,
  Square,
  Download,
  CheckSquare,
  Square as SquareIcon,
  Info,
  X,
  Volume2,
} from "lucide-react";
import {
  api,
  AudioDevice,
  CaptureStatus,
  JobResponse,
  TranscriptSummary,
  TranscriptDetail,
  YouTubeMetadata,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, formatDuration, formatElapsed, formatRelativeTime, parseEngineDate } from "@/lib/utils";

type Tab = "file" | "youtube" | "record" | "system";

interface TranscribeOptions {
  model: string;
  language: string;
  diarize: boolean;
  translate: boolean;
}

const DEFAULT_OPTS: TranscribeOptions = {
  model: "base",
  language: "",
  diarize: false,
  translate: false,
};

/** How long a failed job stays in the panel before it stops being reported. */
const FAILURE_VISIBLE_MS = 30 * 60 * 1000;

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

export default function Dashboard() {
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>("file");
  const [droppedPath, setDroppedPath] = useState<string | null>(null);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [ytPreview, setYtPreview] = useState<YouTubeMetadata | null>(null);
  const [ytPreviewLoading, setYtPreviewLoading] = useState(false);
  const [opts, setOpts] = useState<TranscribeOptions>(DEFAULT_OPTS);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Microphone recording
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // System audio capture (WASAPI loopback) — driven entirely by the engine
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [loopbackDevices, setLoopbackDevices] = useState<AudioDevice[] | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);

  // Data state
  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<string[]>(["tiny", "base", "small", "medium", "large-v3"]);
  const [loadingTranscripts, setLoadingTranscripts] = useState(true);
  const activeCountRef = useRef(0);
  // Ticks once a second purely so the elapsed-time readout keeps moving.
  const [now, setNow] = useState(() => Date.now());

  // Batch selection
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [batchExporting, setBatchExporting] = useState(false);

  useEffect(() => {
    api.models.list().then((ms) => {
      const downloaded = ms.filter((m) => m.is_downloaded).map((m) => m.name);
      if (downloaded.length > 0) setModels(downloaded);
      const active = ms.find((m) => m.is_active);
      if (active) setOpts((o) => ({ ...o, model: active.name }));
    }).catch(() => {});
  }, []);

  const loadTranscripts = useCallback((resetSelection = false) => {
    api.transcripts
      .list()
      .then((ts) => { setTranscripts(ts); if (resetSelection) setSelected(new Set()); })
      .catch(() => {})
      .finally(() => setLoadingTranscripts(false));
  }, []);

  const pollJobs = useCallback(async () => {
    try {
      // Failed jobs are fetched too — without them a failure just vanishes from
      // the panel and the user never learns why their transcription didn't run.
      const [processing, queued, failed] = await Promise.all([
        api.jobs.list({ status: "processing" }),
        api.jobs.list({ status: "queued" }),
        api.jobs.list({ status: "failed", limit: 10 }),
      ]);

      const now = Date.now();
      const recentFailures = failed.filter(
        (j) => now - parseEngineDate(j.updated_at).getTime() < FAILURE_VISIBLE_MS
      );

      const active = [...processing, ...queued];
      const activeCount = active.length;

      // Refresh transcripts while work is in flight, plus one extra tick after
      // the queue drains so the newly-finished transcript is picked up.
      if (activeCount > 0 || activeCountRef.current > 0) loadTranscripts();
      activeCountRef.current = activeCount;

      setJobs([...active, ...recentFailures]);
    } catch {
      // Engine not reachable yet — leave the previous state alone.
    }
  }, [loadTranscripts]);

  useEffect(() => {
    loadTranscripts(true);
    pollJobs();
    const id = setInterval(pollJobs, 2000);
    return () => clearInterval(id);
  }, [loadTranscripts, pollJobs]);

  useEffect(() => {
    if (!jobs.some((j) => j.status === "processing")) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [jobs]);

  const dismissJob = useCallback(async (jobId: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== jobId));
    try {
      await api.jobs.dismiss(jobId);
    } catch {
      // Row may already be gone; the panel is updated either way.
    }
  }, []);

  const cancelJob = useCallback(async (jobId: string) => {
    try {
      await api.jobs.cancel(jobId);
    } catch {
      // Most likely it finished a moment ago; the next poll will reflect that.
    }
    pollJobs();
  }, [pollJobs]);

  // Tauri drag-drop.
  //
  // With dragDropEnabled (the default) the webview hands OS drops to Tauri, so
  // the HTML5 handlers below never fire for a real file drag — these events are
  // the only route. They are core plugin commands, so they are also silently
  // denied if the app ships without a capability granting core:event; that is
  // exactly how drag-drop broke, so failures are surfaced rather than swallowed.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const attach = <T,>(event: string, handler: (payload: T) => void) => {
      listen<T>(event, (e) => handler(e.payload))
        .then((fn) => {
          if (disposed) fn();
          else unlisteners.push(fn);
        })
        .catch((err) => {
          // Not fatal: the Rust-side queue below still delivers dropped files.
          // Worth logging loudly though — a denial here means the capability
          // config is wrong, which breaks every other Tauri event too.
          console.error(
            `[WinWhisper] could not subscribe to ${event}; ` +
              "falling back to the polled drop queue.",
            err
          );
        });
    };

    attach<DragDropPayload>("tauri://drag-drop", (payload) => {
      const paths = payload?.paths ?? [];
      if (paths.length > 0) {
        setTab("file");
        setDroppedPath(paths[0]);
        setDroppedFile(null);
        setIsDragging(false);
        setSubmitError(null);
      }
    });
    attach<unknown>("tauri://drag-enter", () => setIsDragging(true));
    attach<unknown>("tauri://drag-leave", () => setIsDragging(false));

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Belt and braces: the Rust side also queues dropped paths, and draining that
  // queue is a plain command rather than a permission-gated event. If the
  // listener above is denied, this still delivers the file.
  useEffect(() => {
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const paths = await invoke<string[]>("take_dropped_paths");
        if (stopped || !paths?.length) return;
        setTab("file");
        setDroppedPath(paths[0]);
        setDroppedFile(null);
        setIsDragging(false);
        setSubmitError(null);
      } catch {
        // Not running under Tauri (browser dev) — nothing to collect.
      }
    }, 700);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // Mic recording
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const file = new File([blob], `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`, { type: "audio/webm" });
        setDroppedFile(file);
        setDroppedPath(null);
        setTab("file");
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        setRecordSeconds(0);
      };
      mr.start(250);
      mediaRecorderRef.current = mr;
      setRecording(true);
      setRecordSeconds(0);
      recordTimerRef.current = setInterval(() => setRecordSeconds((s) => s + 1), 1000);
    } catch {
      setSubmitError("Microphone access denied. Check your browser permissions.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  useEffect(() => {
    return () => {
      mediaRecorderRef.current?.stop();
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    };
  }, []);

  // Look up the video as soon as a URL is pasted, so the user can confirm they
  // picked the right one (and catch a bad link) before committing to a job.
  useEffect(() => {
    const url = youtubeUrl.trim();
    if (tab !== "youtube" || !/^https?:\/\//i.test(url)) {
      setYtPreview(null);
      return;
    }

    let cancelled = false;
    setYtPreviewLoading(true);
    const timer = setTimeout(() => {
      api.transcribe
        .youtubeMetadata(url)
        .then((meta) => { if (!cancelled) setYtPreview(meta); })
        .catch(() => { if (!cancelled) setYtPreview(null); })
        .finally(() => { if (!cancelled) setYtPreviewLoading(false); });
    }, 600);

    return () => { cancelled = true; clearTimeout(timer); setYtPreviewLoading(false); };
  }, [youtubeUrl, tab]);

  // ── System audio capture ───────────────────────────────────────────────
  // Recording happens in the engine (WASAPI loopback), so the UI just drives
  // start/stop and polls for the elapsed time. Stopping queues the job itself.
  useEffect(() => {
    if (tab !== "system") return;

    let cancelled = false;
    if (loopbackDevices === null) {
      api.audio
        .devices()
        .then((ds) => { if (!cancelled) setLoopbackDevices(ds.filter((d) => d.is_loopback)); })
        .catch((e) => {
          if (!cancelled) {
            setLoopbackDevices([]);
            setCaptureError(
              e instanceof Error && e.message.includes("503")
                ? "System audio capture needs WASAPI, which is only available on Windows."
                : "Could not list audio devices."
            );
          }
        });
    }

    const poll = () => api.audio.status()
      .then((s) => { if (!cancelled) setCaptureStatus(s); })
      .catch(() => {});
    poll();
    const id = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tab, loopbackDevices]);

  async function startSystemCapture() {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      const device = loopbackDevices?.[0];
      await api.audio.startCapture({ loopback: true, device_index: device?.index });
      setCaptureStatus(await api.audio.status());
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : String(e));
    } finally {
      setCaptureBusy(false);
    }
  }

  async function stopSystemCapture() {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      // transcribe:true makes the engine queue the recording immediately, so it
      // shows up in the Activity panel without a further round trip.
      await api.audio.stopCapture({
        transcribe: true,
        model_name: opts.model,
        diarize: opts.diarize,
      });
      setCaptureStatus(await api.audio.status());
      pollJobs();
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : String(e));
    } finally {
      setCaptureBusy(false);
    }
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) { setDroppedFile(file); setDroppedPath(null); }
  }

  function onDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragging(true); }
  function onDragLeave() { setIsDragging(false); }
  function onDrop(e: React.DragEvent) {
    e.preventDefault(); setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) { setDroppedFile(file); setDroppedPath(null); }
  }

  async function handleTranscribe() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (tab === "file" || tab === "record") {
        if (droppedPath) {
          await api.transcribe.file({ file_path: droppedPath, model_name: opts.model, language: opts.language || undefined, diarize: opts.diarize, translate: opts.translate });
        } else if (droppedFile) {
          await api.transcribe.upload(droppedFile, { model_name: opts.model, language: opts.language || undefined, diarize: opts.diarize, translate: opts.translate });
        } else {
          setSubmitError(tab === "record" ? "Record audio first, then click Transcribe." : "Drop a file or click Browse first.");
          return;
        }
      } else {
        if (!youtubeUrl.trim()) { setSubmitError("Enter a YouTube URL."); return; }
        await api.transcribe.youtube({ url: youtubeUrl.trim(), model_name: opts.model, language: opts.language || undefined, diarize: opts.diarize });
      }
      setDroppedPath(null); setDroppedFile(null); setYoutubeUrl("");
      pollJobs();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Batch export — fetch each selected transcript and combine into one TXT
  async function handleBatchExport() {
    if (selected.size === 0) return;
    setBatchExporting(true);
    try {
      const details: TranscriptDetail[] = await Promise.all(
        [...selected].map((id) => api.transcripts.get(id))
      );
      const parts = details.map((t) => {
        const header = `=== ${t.title} ===`;
        const body = t.segments.map((s) => {
          const prefix = s.speaker_label ? `[${s.speaker_label}] ` : "";
          return `${prefix}${s.text.trim()}`;
        }).join("\n");
        return `${header}\n\n${body}`;
      });
      const content = parts.join("\n\n\n");
      const blob = new Blob([content], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `WinWhisper-export-${new Date().toISOString().slice(0, 10)}.txt`;
      a.click();
      URL.revokeObjectURL(url);
      setSelected(new Set());
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setBatchExporting(false);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === filtered.length ? new Set() : new Set(filtered.map((t) => t.id))
    );
  }

  const fileName = droppedPath ? droppedPath.split(/[\\/]/).pop() : droppedFile?.name;
  const filtered = transcripts.filter((t) => t.title.toLowerCase().includes(search.toLowerCase()));

  const statusColor: Record<string, string> = {
    queued: "secondary", processing: "default", done: "success", failed: "destructive", cancelled: "outline",
  };

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "file", label: "File", icon: <FileAudio className="h-3.5 w-3.5" /> },
    { id: "youtube", label: "YouTube", icon: <Youtube className="h-3.5 w-3.5" /> },
    { id: "record", label: "Record", icon: <Mic className="h-3.5 w-3.5" /> },
    { id: "system", label: "System", icon: <Volume2 className="h-3.5 w-3.5" /> },
  ];

  const capturing = captureStatus?.active ?? false;

  return (
    <TooltipProvider>
      <div className="flex h-full overflow-hidden">
        {/* Left: New Transcription panel */}
        <div className="flex w-72 flex-shrink-0 flex-col gap-4 border-r border-border p-4 overflow-y-auto">
          <h2 className="text-sm font-semibold text-foreground">New Transcription</h2>

          {/* Tabs */}
          <div className="flex rounded-lg bg-muted p-0.5">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 rounded-md py-1.5 text-xs font-medium transition-colors",
                  tab === t.id ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>

          {/* File tab */}
          {(tab === "file") && (
            <>
              <div
                onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
                className={cn(
                  "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors",
                  isDragging ? "border-primary bg-primary/10" : "border-border hover:border-muted-foreground/50"
                )}
                onClick={() => fileInputRef.current?.click()}
              >
                <FileAudio className="h-8 w-8 text-muted-foreground mb-2" />
                {fileName ? (
                  <p className="text-sm font-medium text-foreground break-all">{fileName}</p>
                ) : (
                  <>
                    <p className="text-xs font-medium text-foreground">Drop audio / video here</p>
                    <p className="text-xs text-muted-foreground mt-0.5">or click to browse</p>
                  </>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="audio/*,video/*" className="hidden" onChange={handleFileInput} />
            </>
          )}

          {/* YouTube tab */}
          {tab === "youtube" && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 rounded-md border border-input bg-background px-3 py-2">
                <Youtube className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <input
                  value={youtubeUrl}
                  onChange={(e) => setYoutubeUrl(e.target.value)}
                  placeholder="https://youtube.com/watch?v=…"
                  className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                />
              </div>

              {ytPreviewLoading && (
                <div className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Looking up video…</span>
                </div>
              )}

              {ytPreview && !ytPreviewLoading && (
                <div className="flex gap-2 rounded-md border border-border p-2">
                  {ytPreview.thumbnail && (
                    <img
                      src={ytPreview.thumbnail}
                      alt=""
                      className="h-12 w-20 flex-shrink-0 rounded object-cover"
                    />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-snug line-clamp-2">
                      {ytPreview.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground truncate">
                      {ytPreview.uploader}
                      {ytPreview.duration > 0 && ` · ${formatDuration(ytPreview.duration)}`}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Record tab */}
          {tab === "record" && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
              {recording ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-sm font-mono tabular-nums">
                      {String(Math.floor(recordSeconds / 60)).padStart(2, "0")}:{String(recordSeconds % 60).padStart(2, "0")}
                    </span>
                  </div>
                  <Button variant="destructive" size="sm" className="w-full" onClick={stopRecording}>
                    <Square className="mr-2 h-3.5 w-3.5 fill-current" />
                    Stop Recording
                  </Button>
                </>
              ) : (
                <>
                  <Mic className="h-8 w-8 text-muted-foreground" />
                  {fileName && tab === "record" ? (
                    <p className="text-xs text-center text-muted-foreground">
                      Ready: <span className="font-medium text-foreground">{fileName}</span>
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground text-center">
                      Record from your microphone, then click Transcribe.
                    </p>
                  )}
                  <Button variant="outline" size="sm" className="w-full" onClick={startRecording}>
                    <Mic className="mr-2 h-3.5 w-3.5" />
                    Start Recording
                  </Button>
                </>
              )}
            </div>
          )}

          {/* System audio tab */}
          {tab === "system" && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-border p-4">
              {capturing ? (
                <>
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-sm font-mono tabular-nums">
                      {formatDuration(captureStatus?.duration_seconds ?? 0)}
                    </span>
                  </div>
                  {captureStatus?.device_name && (
                    <p className="text-xs text-muted-foreground text-center break-words">
                      {captureStatus.device_name}
                    </p>
                  )}
                  <Button
                    variant="destructive" size="sm" className="w-full"
                    onClick={stopSystemCapture} disabled={captureBusy}
                  >
                    {captureBusy
                      ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      : <Square className="mr-2 h-3.5 w-3.5 fill-current" />
                    }
                    Stop &amp; Transcribe
                  </Button>
                </>
              ) : (
                <>
                  <Volume2 className="h-8 w-8 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground text-center">
                    Records what your computer is playing — calls, videos, anything
                    on your speakers. Nothing from your microphone.
                  </p>
                  <Button
                    variant="outline" size="sm" className="w-full"
                    onClick={startSystemCapture}
                    disabled={captureBusy || loopbackDevices?.length === 0}
                  >
                    {captureBusy
                      ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      : <Volume2 className="mr-2 h-3.5 w-3.5" />
                    }
                    Start Recording
                  </Button>
                </>
              )}
              {captureError && (
                <p className="text-xs text-destructive text-center">{captureError}</p>
              )}
            </div>
          )}

          {/* Options */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">Model</label>
              <select
                value={opts.model}
                onChange={(e) => setOpts((o) => ({ ...o, model: e.target.value }))}
                className="rounded border border-input bg-background px-2 py-1 text-xs text-foreground"
              >
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">Language</label>
              <input
                value={opts.language}
                onChange={(e) => setOpts((o) => ({ ...o, language: e.target.value }))}
                placeholder="auto"
                className="w-20 rounded border border-input bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground"
              />
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={opts.diarize} onChange={(e) => setOpts((o) => ({ ...o, diarize: e.target.checked }))} className="accent-primary" />
              <span className="text-xs text-muted-foreground">Speaker diarization</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground/60 cursor-help flex-shrink-0" />
                </TooltipTrigger>
                <TooltipContent side="right">
                  Identifies who is speaking and when — labels each sentence with a speaker tag
                  (Speaker 1, Speaker 2…). Requires a HuggingFace token in Settings.
                </TooltipContent>
              </Tooltip>
            </label>

            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={opts.translate} onChange={(e) => setOpts((o) => ({ ...o, translate: e.target.checked }))} className="accent-primary" />
              <span className="text-xs text-muted-foreground">Translate to English</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3 w-3 text-muted-foreground/60 cursor-help flex-shrink-0" />
                </TooltipTrigger>
                <TooltipContent side="right">
                  Transcribes foreign-language audio and translates the result to English in one step.
                  Not available for YouTube transcriptions.
                </TooltipContent>
              </Tooltip>
            </label>
          </div>

          {submitError && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          )}

          {/* System capture queues its own job when you stop it. */}
          {tab !== "system" && (
            <Button onClick={handleTranscribe} disabled={submitting || recording} className="w-full">
              {submitting ? (
                <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Queuing…</>
              ) : (
                <><Upload className="mr-2 h-4 w-4" />Transcribe</>
              )}
            </Button>
          )}
        </div>

        {/* Right: Transcripts + Jobs */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Active jobs */}
          {jobs.length > 0 && (
            <div className="border-b border-border px-4 py-3 space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Activity</p>
              <div className="space-y-2">
                {jobs.map((job) => (
                  <div
                    key={job.id}
                    className={cn(
                      "rounded-md p-3 space-y-1.5",
                      job.status === "failed" ? "bg-destructive/10" : "bg-muted"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">{job.source_name ?? "Untitled"}</span>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <Badge variant={(statusColor[job.status] ?? "secondary") as "default" | "secondary" | "destructive" | "outline" | "success"}>
                          {job.status}
                        </Badge>
                        {(job.status === "processing" || job.status === "queued") && (
                          <button
                            onClick={() => cancelJob(job.id)}
                            title="Cancel this transcription"
                            className="text-muted-foreground hover:text-destructive transition-colors"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                        {job.status === "failed" && (
                          <button
                            onClick={() => dismissJob(job.id)}
                            title="Dismiss"
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {job.status === "processing" && (
                      <>
                        <Progress value={(job.progress ?? 0) * 100} />
                        {/* A big model on a slow machine can sit on one step for
                            many minutes. Naming the step and showing elapsed
                            time is the difference between "working" and "hung". */}
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span className="truncate">{job.stage ?? "Working…"}</span>
                          <span className="tabular-nums flex-shrink-0">
                            {formatElapsed(job.created_at, now)}
                          </span>
                        </div>
                      </>
                    )}
                    {job.status === "failed" && (
                      <p className="text-xs text-destructive break-words">
                        {job.error_message ?? "Transcription failed."}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Search + batch export toolbar */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
            <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search transcripts…"
              className="border-0 p-0 shadow-none focus-visible:ring-0 h-auto text-sm"
            />
            {filtered.length > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleSelectAll}
                    className={cn(
                      "transition-colors flex-shrink-0",
                      selected.size > 0 ? "text-primary" : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {selected.size === filtered.length && filtered.length > 0
                      ? <CheckSquare className="h-4 w-4" />
                      : <SquareIcon className="h-4 w-4" />
                    }
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {selected.size === filtered.length ? "Deselect all" : "Select all for batch export"}
                </TooltipContent>
              </Tooltip>
            )}
            {selected.size > 0 && (
              <Button variant="outline" size="sm" onClick={handleBatchExport} disabled={batchExporting} className="flex-shrink-0 text-xs">
                {batchExporting
                  ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  : <Download className="mr-1.5 h-3.5 w-3.5" />
                }
                Export {selected.size}
              </Button>
            )}
            <button onClick={() => loadTranscripts(true)} className="text-muted-foreground hover:text-foreground transition-colors flex-shrink-0">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>

          <ScrollArea className="flex-1">
            {loadingTranscripts ? (
              <div className="flex items-center justify-center py-12 text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                <span className="text-sm">Loading…</span>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
                <FileAudio className="h-10 w-10 mb-3 opacity-30" />
                <p className="text-sm">
                  {search ? "No transcripts match your search" : "No transcripts yet"}
                </p>
                {!search && <p className="text-xs mt-1 opacity-70">Drop an audio file or record from your mic to get started</p>}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((t) => (
                  <TranscriptRow
                    key={t.id}
                    transcript={t}
                    selected={selected.has(t.id)}
                    onToggleSelect={() => toggleSelect(t.id)}
                    onOpen={() => navigate(`/editor/${t.id}`)}
                    onDelete={async () => { await api.transcripts.delete(t.id); loadTranscripts(true); }}
                  />
                ))}
              </div>
            )}
          </ScrollArea>
        </div>
      </div>
    </TooltipProvider>
  );
}

function TranscriptRow({
  transcript: t,
  selected,
  onToggleSelect,
  onOpen,
  onDelete,
}: {
  transcript: TranscriptSummary;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-3 cursor-pointer group transition-colors",
        selected ? "bg-primary/5" : "hover:bg-accent/50"
      )}
      onClick={onOpen}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
        className={cn(
          "flex-shrink-0 transition-colors",
          selected ? "text-primary" : "text-muted-foreground/30 group-hover:text-muted-foreground/60"
        )}
      >
        {selected ? <CheckSquare className="h-4 w-4" /> : <SquareIcon className="h-4 w-4" />}
      </button>
      <FileAudio className="h-5 w-5 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{t.title}</p>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground">
          {t.duration != null && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDuration(t.duration)}
            </span>
          )}
          <span className="flex items-center gap-1">
            <AlignLeft className="h-3 w-3" />
            {t.word_count.toLocaleString()} words
          </span>
          <span>{formatRelativeTime(t.created_at)}</span>
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (!deleting) { setDeleting(true); onDelete().finally(() => setDeleting(false)); }
        }}
        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
      >
        {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
      </button>
    </div>
  );
}
