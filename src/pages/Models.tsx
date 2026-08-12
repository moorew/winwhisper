import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Cpu,
  Download,
  Loader,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { api, ModelInfo } from "@/lib/api";
import {
  Card,
  PageHeader,
  SecondaryButton,
  SectionLabel,
  Track,
} from "@/components/ui/primitives";
import { cn, formatFileSize } from "@/lib/utils";

interface DownloadState {
  status: string;
  progress: number;
}

/** Speed / accuracy out of 5, as shown by the meters. */
const RATINGS: Record<string, { speed: number; accuracy: number }> = {
  tiny: { speed: 5, accuracy: 1 },
  base: { speed: 4, accuracy: 2 },
  small: { speed: 3, accuracy: 3 },
  medium: { speed: 2, accuracy: 4 },
  "large-v3": { speed: 1, accuracy: 5 },
};

const DESCRIPTIONS: Record<string, string> = {
  tiny: "Fastest, roughest. Fine for a quick draft or a quiet, clear voice.",
  base: "The best starting point — quick, and accurate enough for most speech.",
  small: "Noticeably better with accents and background noise.",
  medium: "Strong accuracy for interviews and podcasts, at half the speed.",
  "large-v3": "The most accurate model. Slow on CPU, comfortable on a GPU.",
};

/** English-only variants are collapsed — they otherwise double the list. */
const isEnglishOnly = (name: string) => name.endsWith(".en");

export default function Models() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [engineError, setEngineError] = useState(false);
  const [downloadStates, setDownloadStates] = useState<Record<string, DownloadState>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [showEnglishOnly, setShowEnglishOnly] = useState(false);
  const esRefs = useRef<Record<string, EventSource>>({});

  const load = useCallback((resetLoading = false) => {
    if (resetLoading) setLoading(true);
    api.models
      .list()
      .then((ms) => { setModels(ms); setEngineError(false); })
      .catch(() => setEngineError(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(true); }, [load]);

  useEffect(() => {
    if (!engineError) return;
    const id = setInterval(() => load(false), 6000);
    return () => clearInterval(id);
  }, [engineError, load]);

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
        const data = JSON.parse(event.data) as DownloadState;
        setDownloadStates((prev) => ({ ...prev, [name]: data }));
        if (["done", "failed", "cancelled"].includes(data.status)) {
          es.close();
          delete esRefs.current[name];
          load();
        }
      } catch { /* ignore malformed frame */ }
    };
    es.onerror = () => { es.close(); delete esRefs.current[name]; };
  }

  async function handleDownload(name: string) {
    setBusy((b) => ({ ...b, [name]: true }));
    setDownloadStates((p) => ({ ...p, [name]: { status: "downloading", progress: 0 } }));
    try {
      await api.models.download(name);
      startProgressStream(name);
    } catch {
      setDownloadStates((p) => { const n = { ...p }; delete n[name]; return n; });
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
      setDownloadStates((p) => { const n = { ...p }; delete n[name]; return n; });
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
    if (!confirm(`Delete "${name}"? You'll need to download it again to use it.`)) return;
    setBusy((b) => ({ ...b, [name]: true }));
    try {
      await api.models.delete(name);
      load();
    } finally {
      setBusy((b) => ({ ...b, [name]: false }));
    }
  }

  const downloading = (m: ModelInfo) =>
    m.is_downloading || downloadStates[m.name]?.status === "downloading";
  const progressOf = (m: ModelInfo) =>
    (downloadStates[m.name]?.progress ?? m.download_progress ?? 0) * 100;

  const installed = models.filter((m) => m.is_downloaded);
  const available = models.filter((m) => !m.is_downloaded && !isEnglishOnly(m.name));
  const englishOnly = models.filter((m) => !m.is_downloaded && isEnglishOnly(m.name));

  const onDiskBytes = installed.reduce((sum, m) => sum + (m.size_mb ?? 0) * 1024 * 1024, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Models"
        subtitle={
          installed.length
            ? `${formatFileSize(onDiskBytes)} across ${installed.length} model${installed.length === 1 ? "" : "s"} on disk`
            : "No models on disk yet"
        }
        right={
          <SecondaryButton onClick={() => load(false)}>
            <RefreshCw size={14} strokeWidth={1.75} />
            Refresh
          </SecondaryButton>
        }
      />

      <div className="flex min-h-0 flex-1 flex-col gap-[22px] overflow-y-auto px-6 pb-6 pt-0.5">
        {loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-text-dim">
            <Loader size={18} strokeWidth={1.75} className="animate-spin" />
            <span className="text-body">Loading models…</span>
          </div>
        ) : engineError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-text-dim">
            <Cpu size={36} strokeWidth={1.5} className="opacity-30" />
            <p className="text-body font-medium text-text-tertiary">Engine is starting…</p>
            <p className="max-w-xs text-meta">
              The transcription engine is still loading. This usually takes a few seconds.
            </p>
            <SecondaryButton onClick={() => load(true)}>Try again</SecondaryButton>
          </div>
        ) : (
          <>
            {installed.length > 0 && (
              <section className="flex flex-col gap-3">
                <SectionLabel>Installed</SectionLabel>
                <Card className="overflow-hidden">
                  {installed.map((m, i) => (
                    <InstalledRow
                      key={m.name}
                      model={m}
                      first={i === 0}
                      busy={busy[m.name]}
                      onActivate={() => handleActivate(m.name)}
                      onDelete={() => handleDelete(m.name)}
                    />
                  ))}
                </Card>
              </section>
            )}

            <section className="flex flex-col gap-3">
              <SectionLabel>Available</SectionLabel>
              <Card className="overflow-hidden">
                {available.map((m, i) => (
                  <AvailableRow
                    key={m.name}
                    model={m}
                    first={i === 0 && installed.length >= 0}
                    downloading={downloading(m)}
                    progress={progressOf(m)}
                    busy={busy[m.name]}
                    onDownload={() => handleDownload(m.name)}
                    onCancel={() => handleCancel(m.name)}
                  />
                ))}

                {showEnglishOnly &&
                  englishOnly.map((m) => (
                    <AvailableRow
                      key={m.name}
                      model={m}
                      first={false}
                      downloading={downloading(m)}
                      progress={progressOf(m)}
                      busy={busy[m.name]}
                      onDownload={() => handleDownload(m.name)}
                      onCancel={() => handleCancel(m.name)}
                    />
                  ))}

                {englishOnly.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowEnglishOnly((v) => !v)}
                    className="flex w-full items-center gap-2 border-t border-hairline px-4 py-3 text-left text-[12px] text-text-dim transition-colors duration-[120ms] hover:text-text-tertiary"
                  >
                    <ChevronDown
                      size={13}
                      strokeWidth={1.75}
                      className={cn("transition-transform duration-[120ms]", showEnglishOnly && "rotate-180")}
                    />
                    {showEnglishOnly ? "Hide" : "Show"} English-only variants (
                    {englishOnly.map((m) => m.name).join(", ")})
                  </button>
                )}
              </Card>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function InstalledRow({
  model: m,
  first,
  busy,
  onActivate,
  onDelete,
}: {
  model: ModelInfo;
  first: boolean;
  busy?: boolean;
  onActivate: () => void;
  onDelete: () => void;
}) {
  const rating = RATINGS[m.name] ?? { speed: 3, accuracy: 3 };
  return (
    <div
      className={cn(
        "flex items-center gap-4 px-4 py-[14px]",
        !first && "border-t border-hairline",
        m.is_active && "bg-accent-ink/[0.04]"
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-model font-semibold text-text-strong">{m.name}</span>
          {m.is_active && (
            <span className="flex h-5 items-center rounded-[10px] bg-accent-ink/[0.16] px-2 text-[10.5px] font-bold uppercase tracking-[0.04em] text-accent-badge">
              Active
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-muted">
          {DESCRIPTIONS[m.name] ?? m.description}
        </p>
      </div>

      <Meters speed={rating.speed} accuracy={rating.accuracy} />

      <div className="tnum w-24 flex-shrink-0 text-right">
        <p className="text-meta text-text-secondary">
          {formatFileSize((m.size_bytes_local ?? m.size_mb * 1024 * 1024) as number)}
        </p>
        <p className="text-meta text-text-dim">{m.speed}</p>
      </div>

      {m.is_active ? (
        <button
          type="button"
          aria-label={`Delete ${m.name}`}
          title="Active models can't be deleted"
          disabled
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-segment text-text-dim opacity-40"
        >
          <Trash2 size={14} strokeWidth={1.75} />
        </button>
      ) : (
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <SecondaryButton onClick={onActivate} disabled={busy} className="h-[30px]">
            {busy && <Loader size={13} strokeWidth={1.75} className="animate-spin" />}
            Set active
          </SecondaryButton>
          <button
            type="button"
            aria-label={`Delete ${m.name}`}
            title="Delete"
            onClick={onDelete}
            disabled={busy}
            className="flex h-7 w-7 items-center justify-center rounded-segment text-text-dim transition-colors duration-[120ms] hover:bg-danger/[0.12] hover:text-danger"
          >
            <Trash2 size={14} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  );
}

function AvailableRow({
  model: m,
  first,
  downloading,
  progress,
  busy,
  onDownload,
  onCancel,
}: {
  model: ModelInfo;
  first: boolean;
  downloading: boolean;
  progress: number;
  busy?: boolean;
  onDownload: () => void;
  onCancel: () => void;
}) {
  const totalBytes = m.size_mb * 1024 * 1024;
  return (
    <div className={cn("flex items-center gap-4 px-4 py-[13px]", !first && "border-t border-hairline")}>
      <div className="min-w-0 flex-1">
        <p className="text-title font-semibold text-text-strong">{m.name}</p>
        <p className="mt-0.5 text-[12px] text-text-muted">
          {DESCRIPTIONS[m.name] ?? m.description}
        </p>
      </div>

      {downloading ? (
        <div className="w-[190px] flex-shrink-0">
          <Track value={progress} />
          <p className="tnum mt-1.5 text-[11px] text-text-muted">
            {formatFileSize(totalBytes * (progress / 100))} of {formatFileSize(totalBytes)}
          </p>
        </div>
      ) : (
        <div className="tnum w-24 flex-shrink-0 text-right">
          <p className="text-meta text-text-secondary">{formatFileSize(totalBytes)}</p>
          <p className="text-meta text-text-dim">{m.speed}</p>
        </div>
      )}

      {downloading ? (
        <SecondaryButton onClick={onCancel} disabled={busy} className="h-[30px] flex-shrink-0">
          <X size={13} strokeWidth={1.75} />
          Cancel
        </SecondaryButton>
      ) : (
        <SecondaryButton onClick={onDownload} disabled={busy} className="h-[30px] flex-shrink-0">
          {busy ? (
            <Loader size={13} strokeWidth={1.75} className="animate-spin" />
          ) : (
            <Download size={13} strokeWidth={1.75} />
          )}
          Download
        </SecondaryButton>
      )}
    </div>
  );
}

/** Five 4px segments per row: speed in accent, accuracy in grey. */
function Meters({ speed, accuracy }: { speed: number; accuracy: number }) {
  return (
    <div className="hidden w-[130px] flex-shrink-0 flex-col gap-1.5 md:flex">
      <MeterRow label="Speed" value={speed} className="bg-accent-ink" />
      <MeterRow label="Accuracy" value={accuracy} className="bg-meter" />
    </div>
  );
}

function MeterRow({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[42px] flex-shrink-0 text-[10.5px] text-text-dim">{label}</span>
      <div className="flex flex-1 items-center gap-[3px]" aria-label={`${label} ${value} of 5`}>
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn("h-1 flex-1 rounded-[2px]", i < value ? className : "bg-track")}
          />
        ))}
      </div>
    </div>
  );
}
