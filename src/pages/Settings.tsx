import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Cpu,
  ExternalLink,
  Folder,
  FolderOpen,
  Keyboard,
  Loader,
  Moon,
  Power,
  Save,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { api, DevicesResponse, DictationStatus, ModelInfo, WatchFolderStatus } from "@/lib/api";
import {
  Card,
  Hint,
  PageHeader,
  SecondaryButton,
  SectionLabel,
  Segmented,
  Select,
  Toggle,
} from "@/components/ui/primitives";
import { cn, formatFileSize } from "@/lib/utils";

type ThemeChoice = "system" | "light" | "dark";

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "transcription", label: "Transcription" },
  { id: "automation", label: "Automation" },
  { id: "devices", label: "Devices" },
  { id: "storage", label: "Storage" },
  { id: "about", label: "About" },
] as const;

const EXPORT_FORMATS = ["TXT", "SRT", "VTT", "JSON"] as const;

/** Applies a theme choice to <html>, following the OS when set to System. */
function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  const prefersLight =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: light)").matches;
  const effective = choice === "system" ? (prefersLight ? "light" : "dark") : choice;
  root.classList.remove("light", "dark");
  root.classList.add(effective);
  localStorage.setItem("ww-theme", choice);
}

export default function Settings() {
  const [theme, setTheme] = useState<ThemeChoice>(
    () => (localStorage.getItem("ww-theme") as ThemeChoice) || "dark"
  );

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState("base");
  const [diarize, setDiarize] = useState(false);
  const [autoExport, setAutoExport] = useState<string[]>([]);

  // Devices + sharing
  const [devices, setDevices] = useState<DevicesResponse | null>(null);
  const [sharing, setSharing] = useState(false);
  const [startAtLogin, setStartAtLogin] = useState(false);

  const [watchStatus, setWatchStatus] = useState<WatchFolderStatus | null>(null);
  const [watchPath, setWatchPath] = useState("");
  const [watchBusy, setWatchBusy] = useState(false);

  const [dictStatus, setDictStatus] = useState<DictationStatus | null>(null);
  const [dictHotkey, setDictHotkey] = useState("ctrl+shift+space");
  const [capturingHotkey, setCapturingHotkey] = useState(false);
  const [dictBusy, setDictBusy] = useState(false);

  const [hfToken, setHfToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState<string | null>(null);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [active, setActive] = useState<string>("appearance");
  const [storage, setStorage] = useState<{
    models_bytes: number;
    transcripts_bytes: number;
    cache_bytes: number;
    total_bytes: number;
    models_dir: string;
  } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    api.health().then((h) => setVersion(h.version)).catch(() => {});
    api.storage().then(setStorage).catch(() => {});
    try {
      const [ms, ws, ds, all] = await Promise.all([
        api.models.list(),
        api.watchFolder.status(),
        api.dictation.status(),
        api.settings.getAll(),
      ]);
      setModels(ms);
      const act = ms.find((m) => m.is_active);
      if (act) setActiveModel(act.name);
      setWatchStatus(ws);
      setWatchPath(ws.folder_path ?? "");
      setDictStatus(ds);
      setDictHotkey(ds.hotkey ?? "ctrl+shift+space");
      if (all["diarization_enabled"]) setDiarize(Boolean(all["diarization_enabled"]));
      if (all["hf_token"]) setHfToken(String(all["hf_token"]));
      if (Array.isArray(all["auto_export"])) setAutoExport(all["auto_export"] as string[]);
    } catch {
      // Engine not ready — the page still renders.
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api.devices()
      .then((d) => {
        setDevices(d);
        setSharing(d.sharing);
      })
      .catch(() => {});
    invoke<boolean>("get_start_at_login")
      .then(setStartAtLogin)
      .catch(() => {});   // not running under Tauri
  }, []);

  async function handleSharing(next: boolean) {
    setSharing(next);
    try {
      await api.settings.update("share_engine", next);
      setSavedKey("sharing");
      setTimeout(() => setSavedKey(null), 1600);
    } catch (e) {
      setSharing(!next);
      setError(e instanceof Error ? e.message : "Could not change sharing.");
    }
  }

  async function handleStartAtLogin(next: boolean) {
    setStartAtLogin(next);
    try {
      await invoke("set_start_at_login", { enabled: next });
    } catch (e) {
      setStartAtLogin(!next);
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  useEffect(() => { applyTheme(theme); }, [theme]);

  // Follows the OS while the choice is System.
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // Section nav scroll-spy.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible) setActive(visible.target.id);
      },
      { root, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    );
    SECTIONS.forEach((s) => {
      const el = document.getElementById(s.id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  function flash(key: string) {
    setSavedKey(key);
    setTimeout(() => setSavedKey(null), 2000);
  }

  async function handleActivateModel(name: string) {
    setSaving(true);
    try {
      await api.models.activate(name);
      setActiveModel(name);
      setModels((prev) => prev.map((m) => ({ ...m, is_active: m.name === name })));
      flash("model");
    } finally {
      setSaving(false);
    }
  }

  async function handleDiarize(v: boolean) {
    setDiarize(v);
    try { await api.settings.update("diarization_enabled", v); } catch { /* non-fatal */ }
  }

  async function toggleExportFormat(f: string) {
    const next = autoExport.includes(f)
      ? autoExport.filter((x) => x !== f)
      : [...autoExport, f];
    setAutoExport(next);
    try { await api.settings.update("auto_export", next); } catch { /* non-fatal */ }
  }

  async function handleWatchToggle(enabled: boolean) {
    setWatchBusy(true);
    setError(null);
    try {
      if (enabled) {
        if (!watchPath.trim()) { setError("Enter a folder path to watch."); return; }
        await api.watchFolder.start({ folder_path: watchPath.trim(), model_name: activeModel });
      } else {
        await api.watchFolder.stop();
      }
      setWatchStatus(await api.watchFolder.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWatchBusy(false);
    }
  }

  async function handleDictToggle(enabled: boolean) {
    setDictBusy(true);
    setError(null);
    try {
      if (enabled) await api.dictation.start(dictHotkey);
      else await api.dictation.stop();
      setDictStatus(await api.dictation.status());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDictBusy(false);
    }
  }

  // Hotkey capture: collect the chord, then commit on the first non-modifier.
  useEffect(() => {
    if (!capturingHotkey) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("ctrl");
      if (e.shiftKey) parts.push("shift");
      if (e.altKey) parts.push("alt");
      const key = e.key.toLowerCase();
      if (["control", "shift", "alt", "meta"].includes(key)) return;
      parts.push(key === " " ? "space" : key);
      setDictHotkey(parts.join("+"));
      setCapturingHotkey(false);
      api.settings.update("dictation_hotkey", parts.join("+")).catch(() => {});
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [capturingHotkey]);

  async function saveHfToken() {
    setSaving(true);
    try {
      await api.settings.update("hf_token", hfToken);
      flash("hfToken");
    } finally {
      setSaving(false);
    }
  }

  async function checkForUpdates() {
    try {
      await invoke("open_external", {
        url: "https://github.com/moorew/winwhisper/releases",
      });
      setUpdateMsg("Opening the releases page in your browser…");
    } catch {
      setUpdateMsg("Visit github.com/moorew/winwhisper/releases");
    }
  }

  const downloaded = models.filter((m) => m.is_downloaded);
  const modelsBytes = downloaded.reduce((s, m) => s + m.size_mb * 1024 * 1024, 0);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Settings"
        right={
          <span className="tnum text-[12px] text-text-dim">
            WinWhisper {version ?? "…"} · engine {version ?? "…"}
          </span>
        }
      />

      <div className="flex min-h-0 flex-1 gap-[22px] px-6 pb-6 pt-0.5">
        {/* Section nav */}
        <nav className="hidden w-[172px] flex-shrink-0 flex-col gap-0.5 lg:flex">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() =>
                document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className={cn(
                "flex h-8 items-center rounded-segment px-2.5 text-left text-[12.5px] transition-colors duration-[120ms]",
                active === s.id
                  ? "bg-fill text-text-strong"
                  : "text-text-muted hover:text-text-tertiary"
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <div ref={scrollRef} className="flex min-w-0 flex-1 flex-col gap-[22px] overflow-y-auto pb-10">
          {error && (
            <div className="rounded-card border border-danger/25 bg-danger/[0.08] px-4 py-3 text-[12.5px] text-danger">
              {error}
            </div>
          )}

          {/* ── Appearance ─────────────────────────────────────────── */}
          <Group id="appearance" label="Appearance">
            <Row
              icon={<Moon size={16} strokeWidth={1.75} />}
              title="Theme"
              description="Follows your Windows setting unless you pick one"
              hint={
                <>
                  System tracks the light/dark mode in Windows Settings and switches
                  with it. Light and Dark override that and stay put.
                </>
              }
            >
              <Segmented
                size="sm"
                value={theme}
                onChange={(v) => setTheme(v)}
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </Row>
          </Group>

          {/* ── Transcription ──────────────────────────────────────── */}
          <Group id="transcription" label="Transcription defaults">
            <Row
              title="Default model"
              description="Used when a job doesn't name one"
              hint={
                <>
                  Bigger models are more accurate and slower, and every one of them
                  runs entirely on this PC.
                  <br />
                  <br />
                  <strong>tiny / base</strong> are fast enough for clear speech and
                  quick notes. <strong>small / medium</strong> handle accents and
                  crosstalk better. <strong>large-v3</strong> is the most accurate and
                  wants a GPU — on CPU it can run slower than real time.
                  <br />
                  <br />
                  You can still pick a different model per job on the dashboard.
                </>
              }
            >
              {downloaded.length ? (
                <div className="flex items-center gap-2">
                  {savedKey === "model" && (
                    <Check size={14} strokeWidth={1.75} className="text-accent-ink" />
                  )}
                  <Select
                    label=""
                    value={activeModel}
                    onChange={handleActivateModel}
                    minWidth={132}
                    disabled={saving}
                    options={downloaded.map((m) => ({ value: m.name, label: m.name }))}
                  />
                </div>
              ) : (
                <span className="text-meta text-text-dim">No models downloaded</span>
              )}
            </Row>
            <Row
              title="Speaker diarization"
              description={
                <>
                  Label who is speaking · needs a free token ·{" "}
                  <a href="https://huggingface.co/pyannote/speaker-diarization-3.1" target="_blank" rel="noreferrer">
                    setup guide
                  </a>
                </>
              }
              hint={
                <>
                  Splits the transcript by voice, so each line is tagged Speaker 1,
                  Speaker 2 and so on — useful for interviews and meetings, pointless
                  for a single narrator.
                  <br />
                  <br />
                  It runs after transcription and adds roughly a third again to the
                  time. It needs the Hugging Face token below; without one the
                  transcript is still produced, just without speaker labels.
                </>
              }
            >
              <Toggle checked={diarize} onChange={handleDiarize} label="" />
            </Row>
            <Row
              title="Hugging Face token"
              description="Only for speaker diarization · stored on this PC"
              hint={
                <>
                  Speaker diarization uses <strong>pyannote</strong>, a model whose
                  authors require you to accept their licence before downloading it.
                  The token is how that acceptance is checked — it is the only thing
                  it is used for.
                  <br />
                  <br />
                  Transcription itself needs nothing here. Leave this blank unless you
                  want speaker labels.
                  <br />
                  <br />
                  To get one: create a free account at huggingface.co, accept the
                  conditions on the <em>speaker-diarization-3.1</em> and{" "}
                  <em>segmentation-3.0</em> model pages, then make a read token under
                  Settings → Access Tokens.
                  <br />
                  <br />
                  It is saved in WinWhisper's local database and sent only to
                  huggingface.co, to download the model the first time.
                </>
              }
            >
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={hfToken}
                  onChange={(e) => setHfToken(e.target.value)}
                  placeholder="hf_…"
                  className="h-[34px] w-[200px] rounded-control border border-stroke-strong bg-input px-3 font-mono text-[12.5px] text-text-secondary outline-none placeholder:text-text-dim"
                />
                <SecondaryButton onClick={saveHfToken} disabled={saving}>
                  {saving ? (
                    <Loader size={14} strokeWidth={1.75} className="animate-spin" />
                  ) : savedKey === "hfToken" ? (
                    <Check size={14} strokeWidth={1.75} className="text-accent-ink" />
                  ) : (
                    <Save size={14} strokeWidth={1.75} />
                  )}
                </SecondaryButton>
              </div>
            </Row>
            <Row
              title="Auto-export on finish"
              description="Write these alongside every finished transcript"
              hint={
                <>
                  Every transcript is saved in the app regardless. This additionally
                  writes files next to the source audio the moment a job finishes, so
                  you never have to come back and export by hand.
                  <br />
                  <br />
                  <strong>TXT</strong> plain text · <strong>SRT</strong> and{" "}
                  <strong>VTT</strong> timed subtitles for video editors and players ·{" "}
                  <strong>JSON</strong> everything, including per-word timings,
                  confidence and speakers.
                </>
              }
            >
              <div className="flex flex-wrap gap-1.5">
                {EXPORT_FORMATS.map((f) => {
                  const on = autoExport.includes(f);
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => toggleExportFormat(f)}
                      className={cn(
                        "h-7 rounded-chip border px-2.5 text-meta transition-colors duration-[120ms]",
                        on
                          ? "border-accent-ink/[0.24] bg-accent-ink/[0.14] text-accent-badge"
                          : "border-stroke-strong bg-fill-subtle text-text-dim hover:text-text-tertiary"
                      )}
                    >
                      {f}
                    </button>
                  );
                })}
              </div>
            </Row>
          </Group>

          {/* ── Automation ─────────────────────────────────────────── */}
          {/* ── Devices ────────────────────────────────────────────── */}
          <Group id="devices" label="Your devices">
            <Row
              icon={<Cpu size={16} strokeWidth={1.75} />}
              title="Share this machine's engine"
              description={
                devices?.tailscale_available === false
                  ? "Needs Tailscale running and signed in on this machine"
                  : sharing
                  ? `Offering ${devices?.this_device ?? "this machine"} to your other devices`
                  : "Let your other devices transcribe using this machine"
              }
              hint={
                <>
                  With this on, your other WinWhisper devices can pick this
                  machine in their model list and transcribe here instead. Worth
                  doing on whichever machine has the fastest GPU.
                  <br />
                  <br />
                  The transcript is always saved on the device that asked for it
                  — this machine does the work and keeps nothing.
                  <br />
                  <br />
                  Only devices signed into your own Tailscale account are
                  accepted, checked against Tailscale itself. Machines other
                  people have shared into your network are refused, and nothing
                  is exposed to your local network or the internet.
                  <br />
                  <br />
                  Takes effect when WinWhisper restarts.
                </>
              }
            >
              {devices?.tailscale_available === false ? (
                <span className="text-meta text-text-dim">Tailscale not detected</span>
              ) : (
                <Toggle checked={sharing} onChange={handleSharing} label="" />
              )}
            </Row>

            <Row
              icon={<Power size={16} strokeWidth={1.75} />}
              title="Start with Windows"
              description="Opens quietly in the tray, not on screen"
              hint={
                <>
                  WinWhisper signs in with you and waits in the notification
                  area. No window appears.
                  <br />
                  <br />
                  Worth turning on wherever you share an engine: another device
                  can only borrow this machine's GPU while WinWhisper is
                  actually running on it.
                </>
              }
            >
              <Toggle checked={startAtLogin} onChange={handleStartAtLogin} label="" />
            </Row>

            {devices && devices.devices.length > 0 && (
              <div className="border-t border-hairline px-4 py-[14px]">
                <p className="section-label mb-2.5">Found on your Tailscale network</p>
                <div className="flex flex-col gap-1.5">
                  {devices.devices.map((d) => (
                    <div key={d.hostname} className="flex items-center gap-2.5 text-meta">
                      <span
                        className={cn(
                          "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                          d.reachable
                            ? "bg-accent-ink"
                            : d.online
                            ? "bg-warning"
                            : "bg-text-dim/50"
                        )}
                      />
                      <span className="w-[150px] truncate text-text-secondary">
                        {d.hostname}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-text-dim">
                        {d.reachable
                          ? `${d.gpu_name ?? "no GPU"} · ${d.models.length} model${
                              d.models.length === 1 ? "" : "s"
                            }`
                          : d.online
                          ? "not sharing its engine"
                          : "offline"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Group>

          <Group id="automation" label="Automation">
            <Row
              icon={<Folder size={16} strokeWidth={1.75} />}
              title="Watch folder"
              description="Files dropped here are transcribed automatically"
              hint={
                <>
                  While this is on, any audio or video file that appears in the folder
                  is queued with your default model — no need to open WinWhisper and
                  add it.
                  <br />
                  <br />
                  Existing files are left alone; only ones added after you switch it on
                  are picked up. The originals are never moved or deleted.
                </>
              }
            >
              <div className="flex items-center gap-2">
                <div className="flex h-[34px] w-[268px] items-center gap-2 rounded-control border border-stroke-strong bg-input px-3">
                  <input
                    value={watchPath}
                    onChange={(e) => setWatchPath(e.target.value)}
                    disabled={watchStatus?.running}
                    placeholder="C:\Users\you\Recordings"
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-text-secondary outline-none placeholder:text-text-dim disabled:opacity-50"
                  />
                  <FolderOpen size={14} strokeWidth={1.75} className="flex-shrink-0 text-text-dim" />
                </div>
                {watchBusy ? (
                  <Loader size={16} strokeWidth={1.75} className="animate-spin text-text-dim" />
                ) : (
                  <Toggle
                    checked={watchStatus?.running ?? false}
                    onChange={handleWatchToggle}
                    label=""
                  />
                )}
              </div>
            </Row>
            <Row
              icon={<Keyboard size={16} strokeWidth={1.75} />}
              title="Global dictation"
              description="Hold the hotkey, speak, release — text lands in the focused window"
              hint={
                <>
                  Works anywhere in Windows, not just in WinWhisper. Hold the hotkey,
                  say your piece, let go, and the text is typed into whatever had focus
                  — an email, a chat box, a code editor.
                  <br />
                  <br />
                  Click the keys to record a different shortcut. Nothing is captured
                  unless the hotkey is held down.
                </>
              }
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCapturingHotkey(true)}
                  aria-label="Change dictation hotkey"
                  className="flex items-center gap-1"
                >
                  {capturingHotkey ? (
                    <span className="flex h-7 items-center rounded-chip border border-accent-ink/40 bg-input px-2.5 text-meta text-accent-ink">
                      Press keys…
                    </span>
                  ) : (
                    dictHotkey.split("+").map((k) => (
                      <kbd
                        key={k}
                        className="flex h-7 min-w-[34px] items-center justify-center rounded-chip border border-stroke-strong bg-input px-1.5 text-meta text-text-secondary"
                      >
                        {k}
                      </kbd>
                    ))
                  )}
                </button>
                {dictBusy ? (
                  <Loader size={16} strokeWidth={1.75} className="animate-spin text-text-dim" />
                ) : (
                  <Toggle
                    checked={dictStatus?.active ?? false}
                    onChange={handleDictToggle}
                    label=""
                  />
                )}
              </div>
            </Row>
          </Group>

          {/* ── Storage ────────────────────────────────────────────── */}
          <Group id="storage" label="Storage">
            <div className="px-4 py-[14px]">
              <div className="flex items-center gap-1.5">
                <p className="text-title font-medium text-text-strong">
                  {formatFileSize(storage?.total_bytes ?? modelsBytes)} used
                </p>
                <Hint label="storage">
                  <strong>Models</strong> are the downloaded speech models — delete any
                  you do not use from the Models page.
                  <br />
                  <br />
                  <strong>Transcripts</strong> is the database of everything you have
                  transcribed.
                  <br />
                  <br />
                  <strong>Cache</strong> is working files: audio pulled from YouTube,
                  uploads awaiting transcription. It is cleared as jobs finish and is
                  safe to lose.
                </Hint>
              </div>
              {/* Proportional stack: models, then transcripts, then cache. */}
              <div className="mt-2.5 flex h-1.5 overflow-hidden rounded-[3px] bg-track">
                {storage && storage.total_bytes > 0 && (
                  <>
                    <span
                      className="h-full bg-accent-ink"
                      style={{ width: `${(storage.models_bytes / storage.total_bytes) * 100}%` }}
                    />
                    <span
                      className="h-full bg-meter"
                      style={{ width: `${(storage.transcripts_bytes / storage.total_bytes) * 100}%` }}
                    />
                    <span
                      className="h-full bg-text-dim"
                      style={{ width: `${(storage.cache_bytes / storage.total_bytes) * 100}%` }}
                    />
                  </>
                )}
              </div>
              <div className="tnum mt-2 flex flex-wrap gap-4 text-meta text-text-dim">
                <span>Models {formatFileSize(storage?.models_bytes ?? modelsBytes)}</span>
                <span>Transcripts {formatFileSize(storage?.transcripts_bytes ?? 0)}</span>
                <span>Cache {formatFileSize(storage?.cache_bytes ?? 0)}</span>
              </div>
              {storage?.models_dir && (
                <p className="mt-2 break-all text-meta text-text-dim opacity-70">
                  {storage.models_dir}
                </p>
              )}
            </div>
          </Group>

          {/* ── About ──────────────────────────────────────────────── */}
          <Group id="about" label="About">
            <Row title="Version" description="WinWhisper is free and open source, MIT licensed">
              <span className="tnum text-[12.5px] text-text-secondary">{version ?? "…"}</span>
            </Row>
            <Row title="Updates" description="Releases are published on GitHub">
              <div className="flex flex-col items-end gap-1">
                <SecondaryButton onClick={checkForUpdates}>
                  <ExternalLink size={14} strokeWidth={1.75} />
                  Check for updates
                </SecondaryButton>
                {updateMsg && <span className="text-meta text-text-dim">{updateMsg}</span>}
              </div>
            </Row>
          </Group>
        </div>
      </div>
    </div>
  );
}

function Group({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-4 flex-col gap-3">
      <SectionLabel>{label}</SectionLabel>
      <Card className="overflow-hidden">{children}</Card>
    </section>
  );
}

function Row({
  icon,
  title,
  description,
  hint,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  /** The longer explanation, behind the ? beside the title. */
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-[14px] border-t border-hairline px-4 py-[14px] first:border-t-0">
      {icon && (
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-tile bg-fill text-text-muted">
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="truncate text-title font-medium text-text-strong">{title}</p>
          {hint && <Hint label={title}>{hint}</Hint>}
        </div>
        {description && <p className="mt-0.5 text-meta text-text-dim">{description}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}
