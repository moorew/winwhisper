import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertCircle,
  Download,
  FileAudio,
  FolderOpen,
  Loader,
  Mic,
  MonitorSpeaker,
  Play,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Upload,
  X,
  Youtube,
  Zap,
} from "lucide-react";
import {
  api,
  AudioDevice,
  CaptureStatus,
  JobResponse,
  TranscriptSummary,
} from "@/lib/api";
import {
  Card,
  PageHeader,
  Pill,
  PrimaryButton,
  SecondaryButton,
  SectionLabel,
  Segmented,
  Select,
  Toggle,
  Track,
} from "@/components/ui/primitives";
import { Mark } from "@/components/Mark";
import {
  cn,
  formatDuration,
  formatElapsed,
  formatRelativeTime,
  parseEngineDate,
  safeFilename,
} from "@/lib/utils";

type Source = "file" | "youtube" | "record" | "system";

const SOURCES = [
  { value: "file" as const, label: "File", icon: <FileAudio size={14} strokeWidth={1.75} /> },
  { value: "youtube" as const, label: "YouTube", icon: <Youtube size={14} strokeWidth={1.75} /> },
  { value: "record" as const, label: "Record", icon: <Mic size={14} strokeWidth={1.75} /> },
  { value: "system" as const, label: "System audio", icon: <MonitorSpeaker size={14} strokeWidth={1.75} /> },
];

const LANGUAGES = [
  { value: "", label: "Auto-detect" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "pl", label: "Polish" },
  { value: "ru", label: "Russian" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
];

/** How long a failed job stays in the panel before it stops being reported. */
const FAILURE_VISIBLE_MS = 30 * 60 * 1000;

interface DragDropPayload {
  paths: string[];
}

export default function Dashboard() {
  const navigate = useNavigate();

  const [source, setSource] = useState<Source>("file");
  const [droppedPath, setDroppedPath] = useState<string | null>(null);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [model, setModel] = useState("base");
  const [language, setLanguage] = useState("");
  const [diarize, setDiarize] = useState(false);
  const [translate, setTranslate] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [device, setDevice] = useState<string | null>(null);

  // Microphone recording
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // System audio capture (engine-side, WASAPI loopback)
  const [captureStatus, setCaptureStatus] = useState<CaptureStatus | null>(null);
  const [loopbackDevices, setLoopbackDevices] = useState<AudioDevice[] | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureBusy, setCaptureBusy] = useState(false);

  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [search, setSearch] = useState("");
  const [loadingTranscripts, setLoadingTranscripts] = useState(true);
  const activeCountRef = useRef(0);
  const [now, setNow] = useState(() => Date.now());

  // ── Data ────────────────────────────────────────────────────────────────
  useEffect(() => {
    api.models
      .list()
      .then((ms) => {
        const downloaded = ms.filter((m) => m.is_downloaded).map((m) => m.name);
        setAvailableModels(downloaded);
        const active = ms.find((m) => m.is_active) ?? ms.find((m) => m.is_downloaded);
        if (active) setModel(active.name);
      })
      .catch(() => {});
    api.status()
      .then((s) => {
        const hw = s.hardware as { recommended_device?: string } | undefined;
        setDevice(hw?.recommended_device === "cuda" ? "GPU" : "CPU");
      })
      .catch(() => {});
  }, []);

  const loadTranscripts = useCallback(() => {
    api.transcripts
      .list()
      .then(setTranscripts)
      .catch(() => {})
      .finally(() => setLoadingTranscripts(false));
  }, []);

  const pollJobs = useCallback(async () => {
    try {
      const [processing, queued, failed] = await Promise.all([
        api.jobs.list({ status: "processing" }),
        api.jobs.list({ status: "queued" }),
        api.jobs.list({ status: "failed", limit: 10 }),
      ]);
      const cutoff = Date.now() - FAILURE_VISIBLE_MS;
      const recentFailures = failed.filter(
        (j) => parseEngineDate(j.updated_at).getTime() > cutoff
      );
      const active = [...processing, ...queued];
      if (active.length > 0 || activeCountRef.current > 0) loadTranscripts();
      activeCountRef.current = active.length;
      setJobs([...active, ...recentFailures]);
    } catch {
      // Engine not reachable yet.
    }
  }, [loadTranscripts]);

  useEffect(() => {
    loadTranscripts();
    pollJobs();
    const id = setInterval(pollJobs, 2000);
    return () => clearInterval(id);
  }, [loadTranscripts, pollJobs]);

  useEffect(() => {
    if (!jobs.some((j) => j.status === "processing")) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [jobs]);

  // ── Drag & drop ─────────────────────────────────────────────────────────
  // Dropping anywhere in the pane activates the composer's drag-over state.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;

    const attach = <T,>(event: string, handler: (payload: T) => void) => {
      listen<T>(event, (e) => handler(e.payload))
        .then((fn) => (disposed ? fn() : unlisteners.push(fn)))
        .catch((err) =>
          console.error(
            `[WinWhisper] could not subscribe to ${event}; using the polled drop queue.`,
            err
          )
        );
    };

    const accept = (paths: string[]) => {
      if (!paths.length) return;
      setSource("file");
      setDroppedPath(paths[0]);
      setDroppedFile(null);
      setIsDragging(false);
      setSubmitError(null);
    };

    attach<DragDropPayload>("tauri://drag-drop", (p) => accept(p?.paths ?? []));
    attach<DragDropPayload>("tauri://drag-enter", (p) => {
      setIsDragging(true);
      if (p?.paths?.length) setPendingName(p.paths[0].split(/[\\/]/).pop() ?? null);
    });
    attach<unknown>("tauri://drag-leave", () => {
      setIsDragging(false);
      setPendingName(null);
    });

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, []);

  // Rust also queues drops; draining it is a plain command, so this works even
  // if the event subscription above is denied by the capability ACL.
  useEffect(() => {
    let stopped = false;
    const id = setInterval(async () => {
      try {
        const paths = await invoke<string[]>("take_dropped_paths");
        if (stopped || !paths?.length) return;
        setSource("file");
        setDroppedPath(paths[0]);
        setDroppedFile(null);
        setIsDragging(false);
        setSubmitError(null);
      } catch {
        // Not under Tauri.
      }
    }, 700);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  const [pendingName, setPendingName] = useState<string | null>(null);

  // ── Microphone ──────────────────────────────────────────────────────────
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const name = `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.webm`;
        setDroppedFile(new File([blob], name, { type: "audio/webm" }));
        setDroppedPath(null);
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
      setSubmitError("Microphone access was denied.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  useEffect(() => () => {
    mediaRecorderRef.current?.stop();
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
  }, []);

  // ── System audio ────────────────────────────────────────────────────────
  useEffect(() => {
    if (source !== "system") return;
    let cancelled = false;

    if (loopbackDevices === null) {
      api.audio
        .devices()
        .then((ds) => !cancelled && setLoopbackDevices(ds.filter((d) => d.is_loopback)))
        .catch((e) => {
          if (cancelled) return;
          setLoopbackDevices([]);
          setCaptureError(
            e instanceof Error && e.message.includes("503")
              ? "System audio capture needs WASAPI, which is Windows-only."
              : "Could not list audio devices."
          );
        });
    }

    const poll = () =>
      api.audio.status().then((s) => !cancelled && setCaptureStatus(s)).catch(() => {});
    poll();
    const id = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(id); };
  }, [source, loopbackDevices]);

  async function startSystemCapture() {
    setCaptureBusy(true);
    setCaptureError(null);
    try {
      await api.audio.startCapture({ loopback: true, device_index: loopbackDevices?.[0]?.index });
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
      await api.audio.stopCapture({ transcribe: true, model_name: model, diarize });
      setCaptureStatus(await api.audio.status());
      pollJobs();
    } catch (e) {
      setCaptureError(e instanceof Error ? e.message : String(e));
    } finally {
      setCaptureBusy(false);
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────
  const hasSource =
    source === "youtube" ? youtubeUrl.trim().length > 0 : Boolean(droppedPath || droppedFile);
  const canSubmit = hasSource && availableModels.length > 0 && !submitting && !recording;

  async function handleTranscribe() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (source === "youtube") {
        await api.transcribe.youtube({
          url: youtubeUrl.trim(),
          model_name: model,
          language: language || undefined,
          diarize,
        });
      } else if (droppedPath) {
        await api.transcribe.file({
          file_path: droppedPath,
          model_name: model,
          language: language || undefined,
          diarize,
          translate,
        });
      } else if (droppedFile) {
        await api.transcribe.upload(droppedFile, {
          model_name: model,
          language: language || undefined,
          diarize,
          translate,
        });
      }
      setDroppedPath(null);
      setDroppedFile(null);
      setYoutubeUrl("");
      pollJobs();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const cancelJob = useCallback(async (id: string) => {
    try { await api.jobs.cancel(id); } catch { /* already finished */ }
    pollJobs();
  }, [pollJobs]);

  const dismissJob = useCallback(async (id: string) => {
    setJobs((prev) => prev.filter((j) => j.id !== id));
    try { await api.jobs.dismiss(id); } catch { /* already gone */ }
  }, []);

  async function exportTranscript(t: TranscriptSummary) {
    try {
      const detail = await api.transcripts.get(t.id);
      const text = detail.segments
        .map((s) => `${s.speaker_label ? `[${s.speaker_label}] ` : ""}${s.text.trim()}`)
        .join("\n");
      const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeFilename(t.title)}.txt`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  }

  // Keyboard: Ctrl+O browses.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        fileInputRef.current?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const fileName = droppedPath ? droppedPath.split(/[\\/]/).pop() : droppedFile?.name;
  const filtered = transcripts.filter((t) =>
    t.title.toLowerCase().includes(search.toLowerCase())
  );
  const capturing = captureStatus?.active ?? false;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Transcribe"
        subtitle="Everything runs on this machine"
        right={
          <Pill>
            <Zap size={14} strokeWidth={1.75} className="text-accent-ink" />
            <span className="tnum">
              {model}
              {device ? ` · ${device}` : ""}
            </span>
          </Pill>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 pb-6 pt-0.5">
        {/* ── Composer ───────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-[14px] p-4">
          <div className="flex items-center justify-between gap-3">
            <Segmented value={source} onChange={setSource} options={SOURCES} />
            <span className="hidden text-meta text-text-dim sm:block">Ctrl+O to browse</span>
          </div>

          {source === "youtube" ? (
            <div className="flex h-[34px] items-center gap-2 rounded-control border border-stroke-strong bg-input px-3">
              <Youtube size={15} strokeWidth={1.75} className="flex-shrink-0 text-text-dim" />
              <input
                value={youtubeUrl}
                onChange={(e) => setYoutubeUrl(e.target.value)}
                placeholder="Paste a YouTube link"
                className="flex-1 bg-transparent text-[12.5px] text-text-secondary outline-none placeholder:text-text-dim"
              />
            </div>
          ) : source === "record" ? (
            <RecordPanel
              recording={recording}
              seconds={recordSeconds}
              fileName={fileName}
              onStart={startRecording}
              onStop={stopRecording}
            />
          ) : source === "system" ? (
            <SystemPanel
              capturing={capturing}
              status={captureStatus}
              busy={captureBusy}
              error={captureError}
              unavailable={loopbackDevices?.length === 0}
              onStart={startSystemCapture}
              onStop={stopSystemCapture}
            />
          ) : (
            <DropZone
              dragging={isDragging}
              fileName={fileName ?? pendingName ?? undefined}
              model={model}
              language={LANGUAGES.find((l) => l.value === language)?.label ?? "Auto-detect"}
              onBrowse={() => fileInputRef.current?.click()}
            />
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*,video/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) { setDroppedFile(f); setDroppedPath(null); setSource("file"); }
            }}
          />

          {/* Options */}
          <div className="flex flex-wrap items-center gap-3">
            <Select
              label="Model"
              value={model}
              onChange={setModel}
              minWidth={132}
              options={
                availableModels.length
                  ? availableModels.map((m) => ({ value: m, label: m }))
                  : [{ value: model, label: "No models yet" }]
              }
            />
            <Select
              label="Language"
              value={language}
              onChange={setLanguage}
              minWidth={150}
              options={LANGUAGES}
            />
            <span className="h-[22px] w-px bg-stroke-strong" />
            <Toggle checked={diarize} onChange={setDiarize} label="Speaker labels" />
            <Toggle
              checked={translate}
              onChange={setTranslate}
              label="Translate to English"
              disabled={source === "youtube"}
            />
            <div className="flex-1" />
            <PrimaryButton
              onClick={handleTranscribe}
              disabled={!canSubmit}
              className={cn(source === "system" && "hidden")}
            >
              {submitting ? (
                <Loader size={15} strokeWidth={1.75} className="animate-spin" />
              ) : (
                <Play size={15} strokeWidth={1.75} />
              )}
              Transcribe
            </PrimaryButton>
          </div>

          {submitError && (
            <div className="flex items-start gap-2 text-meta text-danger">
              <AlertCircle size={14} strokeWidth={1.75} className="mt-px flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
          {availableModels.length === 0 && (
            <p className="text-meta text-text-dim">
              No model on disk yet — download one from the Models page to start transcribing.
            </p>
          )}
        </Card>

        {/* ── Active / failed jobs ───────────────────────────────────── */}
        {jobs.map((job) => (
          <JobCard
            key={job.id}
            job={job}
            now={now}
            onCancel={() => cancelJob(job.id)}
            onDismiss={() => dismissJob(job.id)}
          />
        ))}

        {/* ── Recent ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <SectionLabel>Recent</SectionLabel>
            <div className="flex items-center gap-2">
              <Pill className="w-[220px]">
                <Search size={14} strokeWidth={1.75} className="flex-shrink-0 text-text-dim" />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search transcripts"
                  className="w-full bg-transparent text-[12.5px] text-text-secondary outline-none placeholder:text-text-dim"
                />
              </Pill>
              <button
                type="button"
                aria-label="Refresh"
                title="Refresh"
                onClick={loadTranscripts}
                className="flex h-[30px] w-[30px] items-center justify-center rounded-full border border-stroke-strong bg-input text-text-tertiary transition-colors duration-[120ms] hover:bg-fill-strong"
              >
                <RefreshCw size={14} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          {!loadingTranscripts && filtered.length === 0 ? (
            <EmptyState
              searching={search.length > 0}
              onBrowse={() => fileInputRef.current?.click()}
              onRecord={() => setSource("record")}
            />
          ) : (
            <Card className="overflow-hidden">
              {filtered.map((t, i) => (
                <TranscriptRow
                  key={t.id}
                  transcript={t}
                  first={i === 0}
                  onOpen={() => navigate(`/editor/${t.id}`)}
                  onExport={() => exportTranscript(t)}
                  onDelete={async () => {
                    await api.transcripts.delete(t.id);
                    loadTranscripts();
                  }}
                />
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Composer panels ────────────────────────────────────────────────────── */

function DropZone({
  dragging,
  fileName,
  model,
  language,
  onBrowse,
}: {
  dragging: boolean;
  fileName?: string;
  model: string;
  language: string;
  onBrowse: () => void;
}) {
  return (
    <div
      onClick={onBrowse}
      className={cn(
        "flex h-[122px] cursor-pointer flex-col items-center justify-center gap-[9px] rounded-[9px] border border-dashed transition-colors duration-[120ms]",
        dragging
          ? "border-accent-ink/40 bg-accent-ink/[0.06]"
          : "border-dropline bg-fill-faint"
      )}
    >
      <div
        className={cn(
          "flex h-[42px] w-[42px] items-center justify-center rounded-full transition-colors duration-[120ms]",
          dragging ? "bg-accent-ink/[0.18]" : "bg-accent-ink/[0.12]"
        )}
      >
        <Upload size={19} strokeWidth={1.75} className="text-accent-ink" />
      </div>
      {dragging ? (
        <>
          <p className="text-title text-text-secondary">
            Drop to transcribe{fileName ? ` ${fileName}` : ""}
          </p>
          <p className="text-meta text-text-dim">
            {model} · {language}
          </p>
        </>
      ) : fileName ? (
        <>
          <p className="max-w-[420px] truncate text-title text-text-secondary">{fileName}</p>
          <p className="text-meta text-text-dim">Ready — press Transcribe</p>
        </>
      ) : (
        <>
          <p className="text-title text-text-secondary">Drop an audio or video file</p>
          <p className="text-meta text-text-dim">
            MP3 · WAV · M4A · FLAC · MP4 · MKV · up to 8 hours
          </p>
        </>
      )}
    </div>
  );
}

function RecordPanel({
  recording,
  seconds,
  fileName,
  onStart,
  onStop,
}: {
  recording: boolean;
  seconds: number;
  fileName?: string;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex h-[122px] flex-col items-center justify-center gap-[9px] rounded-[9px] border border-stroke bg-fill-faint">
      {recording ? (
        <>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse-dot rounded-full bg-danger" />
            <span className="tnum text-[15px] font-semibold text-text-strong">
              {formatDuration(seconds)}
            </span>
          </div>
          <SecondaryButton onClick={onStop}>
            <Square size={14} strokeWidth={1.75} className="fill-current" />
            Stop recording
          </SecondaryButton>
        </>
      ) : (
        <>
          <div className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-accent-ink/[0.12]">
            <Mic size={19} strokeWidth={1.75} className="text-accent-ink" />
          </div>
          <p className="text-title text-text-secondary">
            {fileName ? `Ready — ${fileName}` : "Record from your microphone"}
          </p>
          <SecondaryButton onClick={onStart}>
            <Mic size={14} strokeWidth={1.75} />
            Start recording
          </SecondaryButton>
        </>
      )}
    </div>
  );
}

function SystemPanel({
  capturing,
  status,
  busy,
  error,
  unavailable,
  onStart,
  onStop,
}: {
  capturing: boolean;
  status: CaptureStatus | null;
  busy: boolean;
  error: string | null;
  unavailable?: boolean;
  onStart: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex h-[122px] flex-col items-center justify-center gap-[9px] rounded-[9px] border border-stroke bg-fill-faint px-4 text-center">
      {capturing ? (
        <>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse-dot rounded-full bg-danger" />
            <span className="tnum text-[15px] font-semibold text-text-strong">
              {formatDuration(status?.duration_seconds ?? 0)}
            </span>
          </div>
          {status?.device_name && (
            <p className="max-w-[420px] truncate text-meta text-text-dim">{status.device_name}</p>
          )}
          <PrimaryButton onClick={onStop} disabled={busy}>
            {busy ? (
              <Loader size={15} strokeWidth={1.75} className="animate-spin" />
            ) : (
              <Square size={15} strokeWidth={1.75} className="fill-current" />
            )}
            Stop &amp; transcribe
          </PrimaryButton>
        </>
      ) : (
        <>
          <div className="flex h-[42px] w-[42px] items-center justify-center rounded-full bg-accent-ink/[0.12]">
            <MonitorSpeaker size={19} strokeWidth={1.75} className="text-accent-ink" />
          </div>
          <p className="text-title text-text-secondary">Record what your computer is playing</p>
          <p className="max-w-[380px] text-meta text-text-dim">
            Calls, videos, anything on your speakers — never your microphone.
          </p>
          <SecondaryButton onClick={onStart} disabled={busy || unavailable}>
            <MonitorSpeaker size={14} strokeWidth={1.75} />
            Start capture
          </SecondaryButton>
        </>
      )}
      {error && <p className="text-meta text-danger">{error}</p>}
    </div>
  );
}

/* ── Job card ───────────────────────────────────────────────────────────── */

function JobCard({
  job,
  now,
  onCancel,
  onDismiss,
}: {
  job: JobResponse;
  now: number;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  const failed = job.status === "failed";
  const percent = Math.round((job.progress ?? 0) * 100);

  const badge = failed
    ? "Failed"
    : job.status === "queued"
    ? "Queued"
    : job.stage?.startsWith("Downloading")
    ? "Downloading audio"
    : "Transcribing";

  return (
    <div
      className={cn(
        "flex flex-col gap-[11px] rounded-card border px-4 py-[14px]",
        failed
          ? "border-danger/20 bg-gradient-to-r from-danger/[0.09] to-danger/[0.02]"
          : "border-accent-ink/20 bg-gradient-to-r from-accent-ink/[0.09] to-accent-ink/[0.02]"
      )}
    >
      <div className="flex items-center gap-3">
        {failed ? (
          <AlertCircle size={15} strokeWidth={1.75} className="flex-shrink-0 text-danger" />
        ) : (
          <Loader size={15} strokeWidth={1.75} className="flex-shrink-0 animate-spin text-accent-ink" />
        )}
        <span className="max-w-[520px] truncate text-title font-semibold text-text-strong">
          {job.source_name ?? "Untitled"}
        </span>
        <span
          className={cn(
            "flex h-[22px] flex-shrink-0 items-center rounded-[11px] px-2.5 text-[11px] font-semibold",
            failed ? "bg-danger/[0.16] text-danger" : "bg-accent-ink/[0.16] text-accent-badge"
          )}
        >
          {badge}
        </span>
        <div className="flex-1" />
        {!failed && (
          <span className="tnum flex-shrink-0 text-meta text-text-muted">
            {percent}% · {formatElapsed(job.created_at, now)}
          </span>
        )}
        <button
          type="button"
          aria-label={failed ? "Dismiss" : "Cancel"}
          title={failed ? "Dismiss" : "Cancel"}
          onClick={failed ? onDismiss : onCancel}
          className="flex-shrink-0 text-text-dim transition-colors duration-[120ms] hover:text-text-strong"
        >
          <X size={15} strokeWidth={1.75} />
        </button>
      </div>

      {!failed && <Track value={percent} />}

      {failed ? (
        <p className="text-meta text-danger">{job.error_message ?? "Transcription failed."}</p>
      ) : (
        <p className="tnum text-meta text-text-dim">
          {/* The badge already names the phase — don't repeat it here. */}
          {[
            job.model_name,
            job.job_type === "youtube" ? "YouTube" : job.job_type === "file" ? "File" : job.job_type,
            job.stage?.startsWith("Loading") ? job.stage : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      {/* Live transcript preview — the tail of what has been decoded so far. */}
      {job.partial_text && <LivePreview text={job.partial_text} />}
    </div>
  );
}

function LivePreview({ text }: { text: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div
      ref={boxRef}
      className="max-h-16 overflow-y-auto rounded-segment bg-preview px-2.5 py-2 text-[12px] leading-relaxed text-text-muted"
    >
      {text}
      <span className="ml-0.5 inline-block h-3 w-[3px] translate-y-0.5 animate-pulse bg-accent-ink/70" />
    </div>
  );
}

/* ── Recent list ────────────────────────────────────────────────────────── */

function TranscriptRow({
  transcript: t,
  first,
  onOpen,
  onExport,
  onDelete,
}: {
  transcript: TranscriptSummary;
  first: boolean;
  onOpen: () => void;
  onExport: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  const tint =
    t.source_type === "youtube"
      ? "bg-danger/[0.12] text-danger"
      : t.source_type === "microphone"
      ? "bg-accent-ink/[0.12] text-accent-ink"
      : "bg-fill text-text-muted";

  const Icon = t.source_type === "youtube" ? Youtube : t.source_type === "microphone" ? Mic : FileAudio;

  return (
    <div
      onClick={onOpen}
      className={cn(
        "group flex cursor-pointer items-center gap-[13px] px-[14px] py-3 transition-colors duration-[120ms] hover:bg-fill-subtle",
        !first && "border-t border-hairline"
      )}
    >
      <div className={cn("flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-tile", tint)}>
        <Icon size={16} strokeWidth={1.75} />
      </div>

      <div className="min-w-0 flex-1">
        <p className="truncate text-title font-medium text-text-strong">{t.title}</p>
        <p className="tnum mt-0.5 truncate text-meta text-text-dim">
          {[
            t.duration != null ? formatDuration(t.duration) : null,
            `${t.word_count.toLocaleString()} words`,
            t.language ? t.language.toUpperCase() : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>

      <span className="tnum w-[62px] flex-shrink-0 text-right text-meta text-text-dim group-hover:hidden">
        {formatRelativeTime(t.created_at)}
      </span>

      <div className="hidden flex-shrink-0 items-center gap-1 group-hover:flex">
        <RowAction label="Export as TXT" onClick={onExport}>
          <Download size={14} strokeWidth={1.75} />
        </RowAction>
        <RowAction
          label="Delete"
          danger
          onClick={() => {
            if (!deleting) {
              setDeleting(true);
              onDelete().finally(() => setDeleting(false));
            }
          }}
        >
          {deleting ? (
            <Loader size={14} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <Trash2 size={14} strokeWidth={1.75} />
          )}
        </RowAction>
      </div>
    </div>
  );
}

function RowAction({
  children,
  onClick,
  label,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-segment text-text-muted transition-colors duration-[120ms]",
        danger ? "hover:bg-danger/[0.12] hover:text-danger" : "hover:bg-fill-strong hover:text-text-strong"
      )}
    >
      {children}
    </button>
  );
}

function EmptyState({
  searching,
  onBrowse,
  onRecord,
}: {
  searching: boolean;
  onBrowse: () => void;
  onRecord: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-card border border-stroke px-6 py-14 text-center">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-fill-subtle">
        <Mark size={40} className="text-text-muted opacity-[0.28]" />
      </div>
      <p className="text-[15px] font-semibold text-text-tertiary">
        {searching ? "No transcripts match your search" : "No transcripts yet"}
      </p>
      {!searching && (
        <>
          <p className="max-w-[320px] text-[12.5px] leading-[1.55] text-text-dim">
            Drop a file above, paste a YouTube link, or record straight from your mic.
          </p>
          <div className="flex items-center gap-2">
            <SecondaryButton onClick={onBrowse}>
              <FolderOpen size={14} strokeWidth={1.75} />
              Browse files
            </SecondaryButton>
            <SecondaryButton onClick={onRecord}>
              <Mic size={14} strokeWidth={1.75} />
              Record
            </SecondaryButton>
          </div>
        </>
      )}
    </div>
  );
}
