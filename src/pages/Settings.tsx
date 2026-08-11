import { useCallback, useEffect, useState } from "react";
import {
  Settings as SettingsIcon,
  Folder,
  Keyboard,
  Save,
  Loader2,
  AlertCircle,
  Check,
  Info,
  ExternalLink,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { api, ModelInfo, WatchFolderStatus, DictationStatus } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

function useTheme() {
  const [theme, setThemeSt] = useState<"light" | "dark">(() => {
    const stored = localStorage.getItem("ww-theme");
    return stored === "light" ? "light" : "dark";
  });

  function setTheme(t: "light" | "dark") {
    document.documentElement.classList.remove("light", "dark");
    document.documentElement.classList.add(t);
    localStorage.setItem("ww-theme", t);
    setThemeSt(t);
  }

  return { theme, setTheme };
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        checked ? "bg-primary" : "bg-input"
      )}
    >
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-background shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

export default function Settings() {
  const { theme, setTheme } = useTheme();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [activeModel, setActiveModel] = useState("base");

  const [watchStatus, setWatchStatus] = useState<WatchFolderStatus | null>(null);
  const [watchPath, setWatchPath] = useState("");
  const [watchModel, setWatchModel] = useState("base");
  const [watchDiarize, setWatchDiarize] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);

  const [dictStatus, setDictStatus] = useState<DictationStatus | null>(null);
  const [dictHotkey, setDictHotkey] = useState("ctrl+shift+space");
  const [dictBusy, setDictBusy] = useState(false);

  const [hfToken, setHfToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedKey, setSavedKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Reported by the engine so this never drifts from the shipped build.
    api.health().then((h) => setVersion(h.version)).catch(() => {});
    try {
      const [ms, ws, ds, allSettings] = await Promise.all([
        api.models.list(),
        api.watchFolder.status(),
        api.dictation.status(),
        api.settings.getAll(),
      ]);
      setModels(ms);
      const active = ms.find((m) => m.is_active);
      if (active) setActiveModel(active.name);

      setWatchStatus(ws);
      setWatchPath(ws.folder_path ?? "");

      setDictStatus(ds);
      setDictHotkey(ds.hotkey ?? "ctrl+shift+space");

      if (allSettings["watch_folder_model"]) setWatchModel(String(allSettings["watch_folder_model"]));
      if (allSettings["watch_folder_diarize"]) setWatchDiarize(Boolean(allSettings["watch_folder_diarize"]));
      if (allSettings["hf_token"]) setHfToken(String(allSettings["hf_token"]));
    } catch {
      // Engine might not be ready yet — ignore
    }
  }, []);

  useEffect(() => { load(); }, [load]);

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

  async function handleWatchToggle(enabled: boolean) {
    setWatchBusy(true);
    setError(null);
    try {
      if (enabled) {
        if (!watchPath.trim()) {
          setError("Enter a folder path to watch.");
          return;
        }
        await api.watchFolder.start({ folder_path: watchPath.trim(), model_name: watchModel, diarize: watchDiarize });
      } else {
        await api.watchFolder.stop();
      }
      const ws = await api.watchFolder.status();
      setWatchStatus(ws);
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
      if (enabled) {
        await api.dictation.start(dictHotkey);
      } else {
        await api.dictation.stop();
      }
      const ds = await api.dictation.status();
      setDictStatus(ds);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDictBusy(false);
    }
  }

  async function saveHfToken() {
    setSaving(true);
    try {
      await api.settings.update("hf_token", hfToken);
      flash("hfToken");
    } finally {
      setSaving(false);
    }
  }

  function flash(key: string) {
    setSavedKey(key);
    setTimeout(() => setSavedKey(null), 2000);
  }

  async function handleCheckForUpdates() {
    setCheckingUpdate(true);
    setUpdateMsg(null);
    try {
      await invoke("open_external", { url: "https://github.com/moorew/winwhisper/releases" });
      setUpdateMsg("Opening GitHub releases in your browser…");
    } catch {
      setUpdateMsg("Could not open browser. Visit github.com/moorew/winwhisper/releases manually.");
    } finally {
      setCheckingUpdate(false);
    }
  }

  const downloadedModels = models.filter((m) => m.is_downloaded);

  return (
    <TooltipProvider>
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <SettingsIcon className="h-4 w-4 text-muted-foreground" />
        <h1 className="text-base font-semibold">Settings</h1>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-2xl mx-auto p-6 space-y-8">

          {error && (
            <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* Appearance */}
          <section>
            <h2 className="text-sm font-semibold mb-3">Appearance</h2>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <p className="text-sm font-medium">Theme</p>
                <p className="text-xs text-muted-foreground">Choose light or dark mode</p>
              </div>
              <div className="flex rounded-lg bg-muted p-0.5">
                {(["light", "dark"] as const).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTheme(t)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-medium transition-colors capitalize",
                      theme === t
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <Separator />

          {/* Default Model */}
          <section>
            <h2 className="text-sm font-semibold mb-1">Default Model</h2>
            <p className="text-xs text-muted-foreground mb-3">
              The model used when no model is specified for a transcription job.
            </p>
            {downloadedModels.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No models downloaded yet. Visit the Models page to download one.
              </p>
            ) : (
              <div className="space-y-1.5">
                {downloadedModels.map((m) => (
                  <label key={m.name} className="flex items-center justify-between rounded-lg border border-border p-3 cursor-pointer hover:bg-accent/30 transition-colors">
                    <div>
                      <p className="text-sm font-medium">{m.name}</p>
                      <p className="text-xs text-muted-foreground">{m.description} · {m.speed}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      {activeModel === m.name && savedKey === "model" && (
                        <Check className="h-4 w-4 text-green-500" />
                      )}
                      <input
                        type="radio"
                        name="active_model"
                        value={m.name}
                        checked={activeModel === m.name}
                        onChange={() => handleActivateModel(m.name)}
                        className="accent-primary"
                      />
                    </div>
                  </label>
                ))}
              </div>
            )}
          </section>

          <Separator />

          {/* Watch Folder */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold">Watch Folder</h2>
              {watchBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Automatically transcribe audio/video files dropped into a folder.
            </p>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Enable watch folder</p>
                <Toggle
                  checked={watchStatus?.running ?? false}
                  onChange={handleWatchToggle}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <Input
                    value={watchPath}
                    onChange={(e) => setWatchPath(e.target.value)}
                    placeholder="C:\Users\you\Watch"
                    disabled={watchStatus?.running}
                    className="text-sm"
                  />
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-xs text-muted-foreground">Model</label>
                  <select
                    value={watchModel}
                    onChange={(e) => setWatchModel(e.target.value)}
                    disabled={watchStatus?.running}
                    className="rounded border border-input bg-background px-2 py-1 text-xs text-foreground disabled:opacity-50"
                  >
                    {(downloadedModels.length > 0 ? downloadedModels : models).map((m) => (
                      <option key={m.name} value={m.name}>{m.name}</option>
                    ))}
                  </select>
                </div>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={watchDiarize}
                    onChange={(e) => setWatchDiarize(e.target.checked)}
                    disabled={watchStatus?.running}
                    className="accent-primary"
                  />
                  <span className="text-xs text-muted-foreground">Speaker diarization</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3 w-3 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent>
                      Labels each line with who is speaking. Requires a HuggingFace token below.
                    </TooltipContent>
                  </Tooltip>
                </label>
              </div>
            </div>
          </section>

          <Separator />

          {/* Dictation */}
          <section>
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-sm font-semibold">Global Dictation</h2>
              {dictBusy && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Hold the hotkey to record; release to transcribe and type into the focused window.
              Requires a model to be loaded (run any transcription first).
            </p>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Enable dictation</p>
                <Toggle
                  checked={dictStatus?.active ?? false}
                  onChange={handleDictToggle}
                />
              </div>
              <div className="flex items-center gap-2">
                <Keyboard className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <Input
                  value={dictHotkey}
                  onChange={(e) => setDictHotkey(e.target.value)}
                  placeholder="ctrl+shift+space"
                  disabled={dictStatus?.active}
                  className="text-sm font-mono"
                />
              </div>
            </div>
          </section>

          <Separator />

          {/* HuggingFace Token */}
          <section>
            <div className="flex items-center gap-2 mb-1">
              <h2 className="text-sm font-semibold">HuggingFace Token</h2>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Info className="h-3.5 w-3.5 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent>
                  HuggingFace hosts the speaker diarization model (pyannote.audio). The model is
                  gated — you need a free account and must accept its license before WinWhisper
                  can download it. Your token is stored locally and never sent anywhere else.
                </TooltipContent>
              </Tooltip>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Required for speaker diarization. Get your token at huggingface.co/settings/tokens,
              then accept the license at pyannote/speaker-diarization-3.1.
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                value={hfToken}
                onChange={(e) => setHfToken(e.target.value)}
                placeholder="hf_…"
                className="flex-1 font-mono text-sm"
              />
              <Button onClick={saveHfToken} disabled={saving} variant="outline" size="sm">
                {saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : savedKey === "hfToken" ? (
                  <Check className="h-4 w-4 text-green-500" />
                ) : (
                  <Save className="h-4 w-4" />
                )}
              </Button>
            </div>
          </section>

          <Separator />

          {/* Updates */}
          <section>
            <h2 className="text-sm font-semibold mb-1">Updates</h2>
            <p className="text-xs text-muted-foreground mb-3">
              Current version: <span className="font-mono">{version ?? "…"}</span>
            </p>
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCheckForUpdates}
                disabled={checkingUpdate}
              >
                {checkingUpdate
                  ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  : <ExternalLink className="mr-2 h-3.5 w-3.5" />
                }
                Check for Updates
              </Button>
            </div>
            {updateMsg && (
              <p className="text-xs text-muted-foreground mt-2">{updateMsg}</p>
            )}
          </section>

        </div>
      </ScrollArea>
    </div>
    </TooltipProvider>
  );
}
