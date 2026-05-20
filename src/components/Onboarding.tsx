import { useCallback, useEffect, useRef, useState } from "react";
import {
  Mic,
  Download,
  Loader2,
  X,
  Check,
  ChevronRight,
  Users,
  Folder,
  Youtube,
  FileAudio,
  Zap,
} from "lucide-react";
import { api, ModelInfo } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "ww-onboarded";

interface DownloadState { status: string; progress: number }

export default function Onboarding() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null);
  const [downloading, setDownloading] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  // Check if this is a first launch and no models are downloaded
  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    api.models.list().then((ms) => {
      setModels(ms);
      const hasAny = ms.some((m) => m.is_downloaded);
      if (!hasAny) setVisible(true);
    }).catch(() => {});
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "1");
    esRef.current?.close();
    setVisible(false);
  }, []);

  function startDownload(name: string) {
    setDownloading(true);
    api.models.download(name).then(() => {
      const es = new EventSource(api.models.progressUrl(name));
      esRef.current = es;
      es.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data) as DownloadState;
          setDownloadState(data);
          if (data.status === "done") {
            es.close();
            setDownloading(false);
            // Auto-advance to step 3 after a short pause
            setTimeout(() => setStep(2), 800);
          }
          if (data.status === "failed" || data.status === "cancelled") {
            es.close();
            setDownloading(false);
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => { es.close(); setDownloading(false); };
    }).catch(() => setDownloading(false));
  }

  useEffect(() => () => { esRef.current?.close(); }, []);

  if (!visible) return null;

  const baseModel = models.find((m) => m.name === "base") ?? models[0];
  const progress = (downloadState?.progress ?? 0) * 100;
  const isDone = downloadState?.status === "done";

  const STEPS = ["Welcome", "Download model", "Quick tour"];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        {/* Step indicators */}
        <div className="flex items-center gap-2 px-6 pt-5 pb-0">
          {STEPS.map((label, i) => (
            <div key={i} className="flex items-center gap-2">
              <div className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold transition-colors",
                i < step ? "bg-primary text-primary-foreground"
                  : i === step ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              )}>
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </div>
              <span className={cn(
                "text-xs font-medium",
                i === step ? "text-foreground" : "text-muted-foreground"
              )}>{label}</span>
              {i < STEPS.length - 1 && (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 mx-1" />
              )}
            </div>
          ))}
        </div>

        {/* Close */}
        <button
          onClick={dismiss}
          className="absolute right-4 top-4 text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="p-6 pt-4">
          {/* ── Step 0: Welcome ── */}
          {step === 0 && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <Mic className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h2 className="text-lg font-bold">Welcome to WinWhisper</h2>
                  <p className="text-sm text-muted-foreground">Free, local, private transcription for Windows</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {[
                  { icon: FileAudio, title: "Files & recordings", desc: "Transcribe any audio or video file, or record from your mic" },
                  { icon: Youtube, title: "YouTube", desc: "Paste a YouTube URL to transcribe any public video" },
                  { icon: Users, title: "Speaker labels", desc: "Identify who's speaking in meetings and interviews" },
                  { icon: Folder, title: "Watch folder", desc: "Drop files into a folder and they're transcribed automatically" },
                ].map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Icon className="h-4 w-4 text-primary flex-shrink-0" />
                      <span className="text-xs font-semibold">{title}</span>
                    </div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                  </div>
                ))}
              </div>

              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                <strong className="text-foreground">100% local.</strong> Your audio never leaves your computer. No accounts, no subscriptions, no cloud.
              </div>

              <Button className="w-full" onClick={() => setStep(1)}>
                Get started
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          )}

          {/* ── Step 1: Download model ── */}
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">Download your first model</h2>
                <p className="text-sm text-muted-foreground mt-0.5">
                  WinWhisper uses OpenAI's Whisper speech recognition. You need to download a
                  model before transcribing — this is a one-time setup.
                </p>
              </div>

              <div className="rounded-lg border border-primary/40 bg-primary/5 p-4">
                <div className="flex items-start gap-3 mb-3">
                  <Zap className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-semibold">base <span className="text-xs font-normal text-muted-foreground ml-1">~150 MB · recommended</span></p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Best balance of speed and accuracy. Works well for most speech in English
                      and many other languages. A great starting point.
                    </p>
                  </div>
                </div>

                {isDone ? (
                  <div className="flex items-center gap-2 text-sm font-medium text-green-600">
                    <Check className="h-4 w-4" /> Downloaded successfully
                  </div>
                ) : downloadState ? (
                  <div className="space-y-1.5">
                    <Progress value={progress} className="h-2" />
                    <p className="text-xs text-muted-foreground">{Math.round(progress)}% downloaded…</p>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => baseModel && startDownload(baseModel.name)}
                    disabled={downloading || !baseModel}
                    className="w-full"
                  >
                    {downloading
                      ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Starting download…</>
                      : <><Download className="mr-2 h-3.5 w-3.5" />Download base model</>
                    }
                  </Button>
                )}
              </div>

              <div className="rounded-lg bg-muted/50 p-3 text-xs text-muted-foreground">
                <strong className="text-foreground">Need more accuracy?</strong> You can download larger models (small, medium, large-v3) any time from the Models page. Larger models are slower but more accurate.
              </div>

              <div className="flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setStep(0)}>Back</Button>
                <Button
                  variant={isDone ? "default" : "outline"}
                  size="sm"
                  className="ml-auto"
                  onClick={() => setStep(2)}
                >
                  {isDone ? "Continue" : "Skip for now"}
                  <ChevronRight className="ml-1.5 h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 2: Quick tour ── */}
          {step === 2 && (
            <div className="space-y-4">
              <div>
                <h2 className="text-lg font-bold">You're ready!</h2>
                <p className="text-sm text-muted-foreground mt-0.5">A few things worth knowing before you dive in.</p>
              </div>

              <div className="space-y-2.5">
                {[
                  {
                    icon: FileAudio,
                    title: "Drag & drop to transcribe",
                    desc: "Drop any audio or video file onto the Dashboard, pick your model, and click Transcribe. YouTube URLs work too.",
                  },
                  {
                    icon: Users,
                    title: "Speaker diarization (who said what)",
                    desc: "Turn on \"Speaker diarization\" to label each sentence with who is speaking. Requires a free HuggingFace token — see Settings for the setup guide.",
                  },
                  {
                    icon: Mic,
                    title: "Record from your microphone",
                    desc: "Switch to the Record tab on the Dashboard to capture audio directly. Hit Stop, then Transcribe.",
                  },
                  {
                    icon: Folder,
                    title: "Watch folder (auto-transcribe)",
                    desc: "In Settings → Watch Folder, point WinWhisper at a folder. Any audio file you drop there is transcribed automatically.",
                  },
                ].map(({ icon: Icon, title, desc }) => (
                  <div key={title} className="flex gap-3 rounded-lg border border-border p-3">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-primary/10">
                      <Icon className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">{title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{desc}</p>
                    </div>
                  </div>
                ))}
              </div>

              <Button className="w-full" onClick={dismiss}>
                <Check className="mr-2 h-4 w-4" />
                Let's go!
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
