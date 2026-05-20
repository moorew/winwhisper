import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  Trash2,
  Check,
  Loader2,
  X,
  Cpu,
  Zap,
  Info,
} from "lucide-react";
import { api, ModelInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatFileSize } from "@/lib/utils";

interface DownloadState {
  status: string;
  progress: number;
}

const MODEL_DESCRIPTIONS: Record<string, string> = {
  tiny: "Fastest, lowest accuracy. Great for quick drafts or testing.",
  base: "Good balance of speed and quality. Best starting point.",
  small: "Better accuracy than base, still fast. Recommended for most uses.",
  medium: "High accuracy with moderate speed. Good for interviews and podcasts.",
  "large-v3": "Highest accuracy. Best for complex audio, accents, and technical content.",
};

export default function Models() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [engineError, setEngineError] = useState(false);
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const esRefs = useRef<Record<string, EventSource>>({});

  const load = useCallback(() => {
    setEngineError(false);
    api.models
      .list()
      .then(setModels)
      .catch(() => setEngineError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const refs = esRefs.current;
    return () => { Object.values(refs).forEach((es) => es.close()); };
  }, []);

  function startProgressStream(name: string) {
    esRefs.current[name]?.close();
    const es = new EventSource(api.models.progressUrl(name));
    esRefs.current[name] = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { status: string; progress: number };
        setDownloadStates((prev) => ({ ...prev, [name]: data }));
        if (data.status === "done" || data.status === "failed" || data.status === "cancelled") {
          es.close();
          delete esRefs.current[name];
          load();
        }
      } catch { /* ignore */ }
    };

    es.onerror = () => {
      es.close();
      delete esRefs.current[name];
    };
  }

  async function handleDownload(name: string) {
    setBusy((b) => ({ ...b, [name]: true }));
    try {
      await api.models.download(name);
      startProgressStream(name);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy((b) => ({ ...b, [name]: false }));
    }
  }

  async function handleCancel(name: string) {
    setBusy((b) => ({ ...b, [name]: true }));
    try {
      await api.models.cancelDownload(name);
      esRefs.current[name]?.close();
      delete esRefs.current[name];
      setDownloadStates((prev) => { const n = { ...prev }; delete n[name]; return n; });
      load();
    } finally {
      setBusy((b) => ({ ...b, [name]: false }));
    }
  }

  async function handleActivate(name: string) {
    setBusy((b) => ({ ...b, [name]: true }));
    try {
      await api.models.activate(name);
      setModels((prev) => prev.map((m) => ({ ...m, is_active: m.name === name })));
    } finally {
      setBusy((b) => ({ ...b, [name]: false }));
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete model "${name}"? You'll need to re-download it.`)) return;
    setBusy((b) => ({ ...b, [name]: true }));
    try {
      await api.models.delete(name);
      load();
    } finally {
      setBusy((b) => ({ ...b, [name]: false }));
    }
  }

  const effectiveDownloading = (m: ModelInfo) =>
    m.is_downloading || downloadStates[m.name]?.status === "downloading";

  const downloadProgress = (m: ModelInfo): number => {
    const local = downloadStates[m.name]?.progress;
    if (local != null) return local * 100;
    if (m.download_progress != null) return m.download_progress * 100;
    return 0;
  };

  const hasDownloaded = models.some((m) => m.is_downloaded);

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            <h1 className="text-base font-semibold">Whisper Models</h1>
            <Tooltip>
              <TooltipTrigger asChild>
                <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
              </TooltipTrigger>
              <TooltipContent>
                Models are AI speech recognition engines. Larger models are more accurate but
                slower and use more disk space. Download at least one to start transcribing.
              </TooltipContent>
            </Tooltip>
          </div>
          <Button variant="ghost" size="sm" onClick={load}>
            Refresh
          </Button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            <span className="text-sm">Loading models…</span>
          </div>
        ) : engineError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <Cpu className="h-10 w-10 opacity-30" />
            <p className="text-sm font-medium">Engine is starting…</p>
            <p className="text-xs opacity-70 max-w-xs">
              The transcription engine is still loading. This usually takes a few seconds.
            </p>
            <Button variant="outline" size="sm" onClick={load}>
              Try Again
            </Button>
          </div>
        ) : (
          <ScrollArea className="flex-1">
            <div className="divide-y divide-border">
              {/* Get-started banner — shown until at least one model is downloaded */}
              {!hasDownloaded && (
                <div className="m-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
                  <div className="flex items-start gap-3">
                    <Zap className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                    <div>
                      <p className="text-sm font-semibold text-foreground">Get started — download a model</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        WinWhisper needs a Whisper model to transcribe audio. Not sure which to pick?
                        Start with <strong>base</strong> — it's fast, accurate enough for most content, and only ~150 MB.
                      </p>
                      <p className="text-xs text-muted-foreground mt-1">
                        You'll need a <strong>HuggingFace token</strong> in Settings if you want speaker
                        identification (who said what). Transcription works fine without it.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {models.map((m) => {
                const isDownloading = effectiveDownloading(m);
                const progress = downloadProgress(m);
                const hint = MODEL_DESCRIPTIONS[m.name] ?? m.description;

                return (
                  <div key={m.name} className="flex items-start gap-4 px-4 py-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-medium text-sm">{m.name}</span>
                        {m.is_active && (
                          <Badge variant="success" className="text-[10px]">Active</Badge>
                        )}
                        {m.is_downloaded && !m.is_active && (
                          <Badge variant="secondary" className="text-[10px]">Downloaded</Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{hint}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                        <span>{formatFileSize(m.size_mb * 1024 * 1024)}</span>
                        <span>·</span>
                        <span>{m.speed}</span>
                      </div>
                      {isDownloading && (
                        <div className="mt-2 space-y-1">
                          <Progress value={progress} className="h-1.5" />
                          <p className="text-xs text-muted-foreground">{Math.round(progress)}% downloaded</p>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
                      {isDownloading ? (
                        <Button variant="outline" size="sm" onClick={() => handleCancel(m.name)} disabled={busy[m.name]}>
                          <X className="mr-1.5 h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      ) : m.is_downloaded ? (
                        <>
                          {!m.is_active && (
                            <Button variant="outline" size="sm" onClick={() => handleActivate(m.name)} disabled={busy[m.name]}>
                              {busy[m.name] ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1.5 h-3.5 w-3.5" />}
                              Use
                            </Button>
                          )}
                          <Button
                            variant="ghost" size="sm"
                            onClick={() => handleDelete(m.name)}
                            disabled={busy[m.name] || m.is_active}
                            className="text-destructive hover:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      ) : (
                        <Button variant="outline" size="sm" onClick={() => handleDownload(m.name)} disabled={busy[m.name]}>
                          {busy[m.name] ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="mr-1.5 h-3.5 w-3.5" />}
                          Download
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </div>
    </TooltipProvider>
  );
}
