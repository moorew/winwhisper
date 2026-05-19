import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
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
} from "lucide-react";
import { api, JobResponse, TranscriptSummary } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatDuration, formatRelativeTime } from "@/lib/utils";

type Tab = "file" | "youtube";

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

interface DragDropPayload {
  paths: string[];
  position: { x: number; y: number };
}

export default function Dashboard() {
  const navigate = useNavigate();

  // Input state
  const [tab, setTab] = useState<Tab>("file");
  const [droppedPath, setDroppedPath] = useState<string | null>(null);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [opts, setOpts] = useState<TranscribeOptions>(DEFAULT_OPTS);
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Data state
  const [transcripts, setTranscripts] = useState<TranscriptSummary[]>([]);
  const [jobs, setJobs] = useState<JobResponse[]>([]);
  const [search, setSearch] = useState("");
  const [models, setModels] = useState<string[]>(["tiny", "base", "small", "medium", "large-v3"]);
  const [loadingTranscripts, setLoadingTranscripts] = useState(true);

  // Load models
  useEffect(() => {
    api.models.list().then((ms) => {
      const downloaded = ms.filter((m) => m.is_downloaded).map((m) => m.name);
      if (downloaded.length > 0) setModels(downloaded);
      const active = ms.find((m) => m.is_active);
      if (active) setOpts((o) => ({ ...o, model: active.name }));
    }).catch(() => {});
  }, []);

  // Load transcripts
  const loadTranscripts = useCallback(() => {
    api.transcripts
      .list()
      .then(setTranscripts)
      .catch(() => {})
      .finally(() => setLoadingTranscripts(false));
  }, []);

  // Poll active jobs
  const pollJobs = useCallback(() => {
    api.jobs
      .list({ status: "processing" })
      .then((active) => {
        setJobs(active);
        // Also pick up queued
        return api.jobs.list({ status: "queued" });
      })
      .then((queued) => {
        setJobs((prev) => {
          const ids = new Set(prev.map((j) => j.id));
          return [...prev, ...queued.filter((j) => !ids.has(j.id))];
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadTranscripts();
    pollJobs();
    const id = setInterval(() => {
      pollJobs();
      // Refresh transcripts when jobs complete
      setJobs((prev) => {
        if (prev.length > 0) loadTranscripts();
        return prev;
      });
    }, 2000);
    return () => clearInterval(id);
  }, [loadTranscripts, pollJobs]);

  // Tauri file drag-drop
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<DragDropPayload>("tauri://drag-drop", (event) => {
      const paths = event.payload.paths;
      if (paths.length > 0) {
        setTab("file");
        setDroppedPath(paths[0]);
        setDroppedFile(null);
        setIsDragging(false);
      }
    }).then((fn) => { unlisten = fn; });
    listen<unknown>("tauri://drag-enter", () => setIsDragging(true)).then((fn) => {
      const prev = unlisten;
      unlisten = () => { fn(); prev?.(); };
    });
    listen<unknown>("tauri://drag-leave", () => setIsDragging(false)).then((fn) => {
      const prev = unlisten;
      unlisten = () => { fn(); prev?.(); };
    });
    return () => unlisten?.();
  }, []);

  // HTML file input change
  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setDroppedFile(file);
      setDroppedPath(null);
    }
  }

  // HTML drag-over (within webview, not Tauri)
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }
  function onDragLeave() {
    setIsDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      setDroppedFile(file);
      setDroppedPath(null);
    }
  }

  async function handleTranscribe() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      if (tab === "file") {
        if (droppedPath) {
          await api.transcribe.file({
            file_path: droppedPath,
            model_name: opts.model,
            language: opts.language || undefined,
            diarize: opts.diarize,
            translate: opts.translate,
          });
        } else if (droppedFile) {
          await api.transcribe.upload(droppedFile, {
            model_name: opts.model,
            language: opts.language || undefined,
            diarize: opts.diarize,
            translate: opts.translate,
          });
        } else {
          setSubmitError("Drop a file or click Browse first.");
          return;
        }
      } else {
        if (!youtubeUrl.trim()) {
          setSubmitError("Enter a YouTube URL.");
          return;
        }
        await api.transcribe.youtube({
          url: youtubeUrl.trim(),
          model_name: opts.model,
          language: opts.language || undefined,
          diarize: opts.diarize,
        });
      }
      // Reset input
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

  const fileName = droppedPath
    ? droppedPath.split(/[\\/]/).pop()
    : droppedFile?.name;

  const filtered = transcripts.filter((t) =>
    t.title.toLowerCase().includes(search.toLowerCase())
  );

  const statusColor: Record<string, string> = {
    queued: "secondary",
    processing: "default",
    done: "success",
    failed: "destructive",
    cancelled: "outline",
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left: New Transcription panel */}
      <div className="flex w-72 flex-shrink-0 flex-col gap-4 border-r border-border p-4 overflow-y-auto">
        <h2 className="text-sm font-semibold text-foreground">New Transcription</h2>

        {/* Tabs */}
        <div className="flex rounded-lg bg-muted p-0.5">
          {(["file", "youtube"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "flex-1 rounded-md py-1.5 text-xs font-medium transition-colors",
                tab === t ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t === "file" ? "File" : "YouTube"}
            </button>
          ))}
        </div>

        {tab === "file" && (
          <>
            {/* Drop zone */}
            <div
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              className={cn(
                "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center cursor-pointer transition-colors",
                isDragging
                  ? "border-primary bg-primary/10"
                  : "border-border hover:border-muted-foreground/50"
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
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*,video/*"
              className="hidden"
              onChange={handleFileInput}
            />
          </>
        )}

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
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
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
            <input
              type="checkbox"
              checked={opts.diarize}
              onChange={(e) => setOpts((o) => ({ ...o, diarize: e.target.checked }))}
              className="accent-primary"
            />
            <span className="text-xs text-muted-foreground">Speaker diarization</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={opts.translate}
              onChange={(e) => setOpts((o) => ({ ...o, translate: e.target.checked }))}
              className="accent-primary"
            />
            <span className="text-xs text-muted-foreground">Translate to English</span>
          </label>
        </div>

        {submitError && (
          <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{submitError}</span>
          </div>
        )}

        <Button onClick={handleTranscribe} disabled={submitting} className="w-full">
          {submitting ? (
            <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Queuing…</>
          ) : (
            <><Upload className="mr-2 h-4 w-4" />Transcribe</>
          )}
        </Button>
      </div>

      {/* Right: Transcripts + Jobs */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Active jobs */}
        {jobs.length > 0 && (
          <div className="border-b border-border px-4 py-3 space-y-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">In Progress</p>
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.id} className="rounded-md bg-muted p-3 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium truncate">{job.source_name ?? "Untitled"}</span>
                    <Badge variant={(statusColor[job.status] ?? "secondary") as "default" | "secondary" | "destructive" | "outline" | "success"}>
                      {job.status}
                    </Badge>
                  </div>
                  {job.status === "processing" && (
                    <Progress value={(job.progress ?? 0) * 100} />
                  )}
                  {job.status === "failed" && job.error_message && (
                    <p className="text-xs text-destructive">{job.error_message}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Transcripts list */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search transcripts…"
            className="border-0 p-0 shadow-none focus-visible:ring-0 h-auto text-sm"
          />
          <button
            onClick={loadTranscripts}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
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
              {!search && (
                <p className="text-xs mt-1 opacity-70">Drop an audio file to get started</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {filtered.map((t) => (
                <TranscriptRow
                  key={t.id}
                  transcript={t}
                  onOpen={() => navigate(`/editor/${t.id}`)}
                  onDelete={async () => {
                    await api.transcripts.delete(t.id);
                    loadTranscripts();
                  }}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>
    </div>
  );
}

function TranscriptRow({
  transcript: t,
  onOpen,
  onDelete,
}: {
  transcript: TranscriptSummary;
  onOpen: () => void;
  onDelete: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);

  return (
    <div
      className="flex items-center gap-3 px-4 py-3 hover:bg-accent/50 cursor-pointer group transition-colors"
      onClick={onOpen}
    >
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
          if (!deleting) {
            setDeleting(true);
            onDelete().finally(() => setDeleting(false));
          }
        }}
        className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
      >
        {deleting ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Trash2 className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}
