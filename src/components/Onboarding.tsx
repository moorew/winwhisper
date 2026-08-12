import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Download, Loader, ShieldCheck } from "lucide-react";
import { api, ModelInfo } from "@/lib/api";
import { PrimaryButton, Track } from "@/components/ui/primitives";
import { MarkTile } from "@/components/Mark";
import { formatFileSize } from "@/lib/utils";

const STORAGE_KEY = "ww-onboarded";

interface DownloadState {
  status: string;
  progress: number;
}

/**
 * First run is a single decision — download a model — not a three-step wizard.
 * The dashboard stays visible behind a scrim so it is obvious what the app is.
 */
export default function Onboarding() {
  const [visible, setVisible] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [state, setState] = useState<DownloadState | null>(null);
  const [starting, setStarting] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY)) return;
    api.models
      .list()
      .then((ms) => {
        setModels(ms);
        if (!ms.some((m) => m.is_downloaded)) setVisible(true);
      })
      .catch(() => {});
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, "1");
    esRef.current?.close();
    setVisible(false);
  }, []);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") dismiss(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, dismiss]);

  useEffect(() => () => esRef.current?.close(), []);

  function startDownload(name: string) {
    setStarting(true);
    setState({ status: "downloading", progress: 0 });
    api.models
      .download(name)
      .then(() => {
        const es = new EventSource(api.models.progressUrl(name));
        esRef.current = es;
        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data) as DownloadState;
            setState(data);
            if (["done", "failed", "cancelled"].includes(data.status)) {
              es.close();
              setStarting(false);
            }
          } catch { /* ignore malformed frame */ }
        };
        es.onerror = () => { es.close(); setStarting(false); };
      })
      .catch(() => { setStarting(false); setState(null); });
  }

  if (!visible) return null;

  const base = models.find((m) => m.name === "base") ?? models[0];
  const totalBytes = (base?.size_mb ?? 145) * 1024 * 1024;
  const percent = Math.round((state?.progress ?? 0) * 100);
  const done = state?.status === "done";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(8,10,13,0.62)]">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ww-onboard-title"
        className="w-[560px] rounded-modal border border-white/10 bg-gradient-to-b from-card to-pane p-[30px] shadow-modal"
        style={{ animation: "ww-modal-in 160ms ease-out" }}
      >
        <div className="flex items-center gap-4">
          <MarkTile size={52} />
          <div className="min-w-0">
            <h2 id="ww-onboard-title" className="text-modal font-semibold text-text">
              One download and you're set
            </h2>
            <p className="mt-1 text-body text-text-muted">
              Whisper runs on your machine, so it needs a model file first.
            </p>
          </div>
        </div>

        <div className="mt-[22px] rounded-card border border-accent-ink/[0.22] bg-accent-ink/[0.06] p-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[15px] font-semibold text-text-strong">{base?.name ?? "base"}</span>
            <span className="tnum text-[12px] text-text-muted">
              {formatFileSize(totalBytes)} · {base?.speed ?? "~16× realtime"} · recommended
            </span>
          </div>
          <p className="mt-2 text-[12.5px] text-text-muted">
            A good balance of speed and accuracy for most speech. You can add larger,
            more accurate models later from the Models page.
          </p>

          <div className="mt-3">
            {done ? (
              <p className="flex items-center gap-2 text-[12.5px] font-medium text-accent-ink">
                <Check size={15} strokeWidth={1.75} />
                Ready — drop a file to start
              </p>
            ) : state ? (
              <>
                <Track value={percent} height={4} />
                <div className="tnum mt-2 flex justify-between text-meta text-text-muted">
                  <span>Downloading… {percent}%</span>
                  <span>
                    {formatFileSize(totalBytes * (percent / 100))} of {formatFileSize(totalBytes)}
                  </span>
                </div>
              </>
            ) : (
              <PrimaryButton
                onClick={() => base && startDownload(base.name)}
                disabled={starting || !base}
              >
                {starting ? (
                  <Loader size={15} strokeWidth={1.75} className="animate-spin" />
                ) : (
                  <Download size={15} strokeWidth={1.75} />
                )}
                Download {base?.name ?? "base"} model
              </PrimaryButton>
            )}
          </div>
        </div>

        <div className="mt-[22px] flex items-center gap-2 text-[12px] text-text-dim">
          <ShieldCheck size={14} strokeWidth={1.75} className="flex-shrink-0 text-accent-ink" />
          <span>Nothing you transcribe is ever uploaded. No account, no telemetry.</span>
          <div className="flex-1" />
          <button
            type="button"
            onClick={dismiss}
            className="text-text-muted transition-colors duration-[120ms] hover:text-text-strong"
          >
            {done ? "Start using WinWhisper" : "Skip for now"}
          </button>
        </div>
      </div>
    </div>
  );
}
