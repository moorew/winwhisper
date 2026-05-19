import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Clock,
  AlignLeft,
  Globe,
  Download,
  Loader2,
  AlertCircle,
  Edit2,
  Check,
  X,
} from "lucide-react";
import { api, TranscriptDetail, Speaker } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDuration } from "@/lib/utils";

const SPEAKER_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b",
  "#8b5cf6", "#ec4899", "#06b6d4", "#84cc16",
];

export default function Editor() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [transcript, setTranscript] = useState<TranscriptDetail | null>(null);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editSpeaker, setEditSpeaker] = useState<number | null>(null);
  const [speakerName, setSpeakerName] = useState("");

  const load = useCallback(() => {
    if (!id) return;
    setLoading(true);
    api.transcripts
      .get(id)
      .then((t) => {
        setTranscript(t);
        setSpeakers(t.speakers);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { load(); }, [load]);

  function speakerForLabel(label: string | null): Speaker | undefined {
    return label ? speakers.find((s) => s.label === label) : undefined;
  }

  function colorForLabel(label: string | null): string {
    const sp = speakerForLabel(label);
    if (sp?.color) return sp.color;
    const idx = speakers.findIndex((s) => s.label === label);
    return SPEAKER_COLORS[idx % SPEAKER_COLORS.length] ?? "#94a3b8";
  }

  function displayName(label: string | null): string {
    const sp = speakerForLabel(label);
    return sp?.name || sp?.label || label || "Unknown";
  }

  async function saveSpeakerName(speaker: Speaker) {
    if (!id || !speakerName.trim()) return;
    const updated = await api.transcripts.updateSpeaker(id, speaker.id, speakerName.trim());
    setSpeakers((prev) => prev.map((s) => (s.id === speaker.id ? updated : s)));
    setEditSpeaker(null);
  }

  // Client-side exports
  function exportTxt() {
    if (!transcript) return;
    const text = transcript.segments.map((s) => {
      const name = displayName(s.speaker_label);
      const prefix = s.speaker_label ? `[${name}] ` : "";
      return `${prefix}${s.text.trim()}`;
    }).join("\n");
    download(text, `${transcript.title}.txt`, "text/plain");
  }

  function exportSrt() {
    if (!transcript) return;
    const lines = transcript.segments.map((s, i) => {
      const start = toSrtTime(s.start);
      const end = toSrtTime(s.end);
      return `${i + 1}\n${start} --> ${end}\n${s.text.trim()}\n`;
    });
    download(lines.join("\n"), `${transcript.title}.srt`, "text/plain");
  }

  function exportVtt() {
    if (!transcript) return;
    const lines = ["WEBVTT", ""];
    transcript.segments.forEach((s, i) => {
      lines.push(
        `${i + 1}`,
        `${toVttTime(s.start)} --> ${toVttTime(s.end)}`,
        s.text.trim(),
        ""
      );
    });
    download(lines.join("\n"), `${transcript.title}.vtt`, "text/vtt");
  }

  function exportJson() {
    if (!transcript) return;
    download(JSON.stringify(transcript, null, 2), `${transcript.title}.json`, "application/json");
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin mr-2" />
        <span className="text-sm">Loading transcript…</span>
      </div>
    );
  }

  if (error || !transcript) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm">{error ?? "Transcript not found"}</p>
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
          <ArrowLeft className="mr-2 h-4 w-4" />Back
        </Button>
      </div>
    );
  }

  const uniqueSpeakers = [...new Set(transcript.segments.map((s) => s.speaker_label).filter(Boolean))];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon" onClick={() => navigate("/")}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold truncate">{transcript.title}</h1>
          <div className="flex items-center gap-4 mt-0.5 text-xs text-muted-foreground">
            {transcript.duration != null && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {formatDuration(transcript.duration)}
              </span>
            )}
            <span className="flex items-center gap-1">
              <AlignLeft className="h-3 w-3" />
              {transcript.word_count.toLocaleString()} words
            </span>
            {transcript.language && (
              <span className="flex items-center gap-1">
                <Globe className="h-3 w-3" />
                {transcript.language.toUpperCase()}
              </span>
            )}
          </div>
        </div>
        {/* Export menu */}
        <div className="flex items-center gap-1">
          {[
            { label: "TXT", fn: exportTxt },
            { label: "SRT", fn: exportSrt },
            { label: "VTT", fn: exportVtt },
            { label: "JSON", fn: exportJson },
          ].map(({ label, fn }) => (
            <Button key={label} variant="outline" size="sm" onClick={fn}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {label}
            </Button>
          ))}
        </div>
      </div>

      {/* Speaker chips */}
      {uniqueSpeakers.length > 0 && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-wrap">
          {speakers.filter((s) => uniqueSpeakers.includes(s.label)).map((sp) => (
            <div key={sp.id} className="flex items-center gap-1">
              {editSpeaker === sp.id ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={speakerName}
                    onChange={(e) => setSpeakerName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveSpeakerName(sp);
                      if (e.key === "Escape") setEditSpeaker(null);
                    }}
                    className="w-28 rounded border border-input bg-background px-2 py-0.5 text-xs"
                  />
                  <button onClick={() => saveSpeakerName(sp)} className="text-green-500">
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => setEditSpeaker(null)} className="text-muted-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ) : (
                <Badge
                  style={{ backgroundColor: colorForLabel(sp.label), color: "#fff" }}
                  className="cursor-pointer gap-1 pr-1.5"
                  onClick={() => {
                    setEditSpeaker(sp.id);
                    setSpeakerName(sp.name ?? sp.label);
                  }}
                >
                  {displayName(sp.label)}
                  <Edit2 className="h-2.5 w-2.5 opacity-70" />
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Segments */}
      <ScrollArea className="flex-1">
        <div className="divide-y divide-border/50">
          {transcript.segments.map((seg) => (
            <div key={seg.id} className="flex gap-3 px-4 py-3 hover:bg-accent/30 transition-colors">
              <span className="text-xs text-muted-foreground tabular-nums pt-0.5 w-16 flex-shrink-0">
                {formatDuration(seg.start)}
              </span>
              {seg.speaker_label && (
                <span
                  className="text-xs font-medium pt-0.5 w-20 flex-shrink-0 truncate"
                  style={{ color: colorForLabel(seg.speaker_label) }}
                >
                  {displayName(seg.speaker_label)}
                </span>
              )}
              <p className="text-sm leading-relaxed flex-1">{seg.text.trim()}</p>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function toSrtTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

function toVttTime(seconds: number): string {
  return toSrtTime(seconds).replace(",", ".");
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

function download(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
