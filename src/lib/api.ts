let BASE_URL = import.meta.env.VITE_ENGINE_URL ?? "http://127.0.0.1:49200";

export function setEnginePort(port: number) {
  BASE_URL = `http://127.0.0.1:${port}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface JobResponse {
  id: string;
  status: "queued" | "processing" | "done" | "failed" | "cancelled";
  job_type: string;
  source_name: string | null;
  model_name: string;
  progress: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  transcript_id: string | null;
  /** What the worker is doing right now, e.g. "Transcribing with large-v3". */
  stage: string | null;
  /** Tail of the transcript as it is produced. Null unless actively transcribing. */
  partial_text: string | null;
}

export interface TranscriptSummary {
  id: string;
  title: string;
  language: string | null;
  duration: number | null;
  word_count: number;
  source_type: string;
  created_at: string;
}

export interface Segment {
  id: number;
  segment_index: number;
  start: number;
  end: number;
  text: string;
  speaker_label: string | null;
  confidence: number | null;
  cps: number | null;
  words: Array<{ word: string; start: number; end: number; probability: number }> | null;
}

export interface Speaker {
  id: number;
  label: string;
  name: string | null;
  color: string | null;
}

export interface TranscriptDetail extends TranscriptSummary {
  job_id: string;
  language_probability: number | null;
  /** Original media path, from the owning job. */
  source_path: string | null;
  /** Whether that file still exists — uploads/YouTube temp files are deleted after transcription. */
  source_available: boolean;
  /** Size of the source file, for the reader's Source panel. */
  source_size_bytes: number | null;
  segments: Segment[];
  speakers: Speaker[];
}

export interface ModelInfo {
  name: string;
  repo_id: string;
  size_mb: number;
  speed: string;
  description: string;
  is_downloaded: boolean;
  is_active: boolean;
  is_downloading: boolean;
  download_progress: number | null;
  /** Actual bytes on disk once downloaded; null for models not installed. */
  size_bytes_local: number | null;
  compute_type: string | null;
}

export interface DictationStatus {
  active: boolean;
  hotkey: string | null;
  model_loaded: boolean;
  loaded_model: string | null;
  /** True while the hotkey is held — drives the floating dictation HUD. */
  is_recording: boolean;
}

export interface YouTubeMetadata {
  title: string;
  duration: number;
  uploader: string;
  thumbnail: string | null;
}

export interface AudioDevice {
  index: number;
  name: string;
  channels: number;
  sample_rate: number;
  is_loopback: boolean;
  is_default_output: boolean;
  is_default_input: boolean;
}

export interface CaptureStatus {
  active: boolean;
  loopback: boolean;
  duration_seconds: number;
  device_name: string | null;
  /** RMS of the latest chunk, 0..1 — drives the recorder's level meter. */
  level: number;
}

export interface WatchFolderStatus {
  running: boolean;
  folder_path: string | null;
  supported_extensions: string[];
}

export const api = {
  health: () => request<{ status: string; version: string }>("/health"),
  status: () => request<Record<string, unknown>>("/status"),
  storage: () =>
    request<{
      models_bytes: number;
      transcripts_bytes: number;
      cache_bytes: number;
      total_bytes: number;
      models_dir: string;
    }>("/storage"),

  jobs: {
    list: (params?: { status?: string; limit?: number }) => {
      const q = new URLSearchParams(params as Record<string, string>).toString();
      return request<JobResponse[]>(`/jobs${q ? `?${q}` : ""}`);
    },
    get: (id: string) => request<JobResponse>(`/jobs/${id}`),
    cancel: (id: string) =>
      request<{ cancelled: boolean; job_id: string }>(`/jobs/${id}/cancel`, { method: "POST" }),
    /** Removes the job row entirely — used to dismiss a failed job from the UI. */
    dismiss: (id: string) =>
      fetch(`${BASE_URL}/jobs/${id}`, { method: "DELETE" }),
  },

  transcripts: {
    list: () => request<TranscriptSummary[]>("/transcripts"),
    get: (id: string) => request<TranscriptDetail>(`/transcripts/${id}`),
    delete: (id: string) =>
      fetch(`${BASE_URL}/transcripts/${id}`, { method: "DELETE" }),
    updateSpeaker: (transcriptId: string, speakerId: number, name: string, color?: string) =>
      request<Speaker>(`/transcripts/${transcriptId}/speakers/${speakerId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color }),
      }),
  },

  transcribe: {
    file: (body: { file_path: string; model_name?: string; language?: string; diarize?: boolean; translate?: boolean; word_timestamps?: boolean; vad_filter?: boolean }) =>
      request<{ job_id: string; status: string }>("/transcribe/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),

    upload: (file: File, opts: { model_name?: string; language?: string; diarize?: boolean; translate?: boolean }) => {
      const form = new FormData();
      form.append("file", file);
      if (opts.model_name) form.append("model_name", opts.model_name);
      if (opts.language) form.append("language", opts.language);
      if (opts.diarize) form.append("diarize", String(opts.diarize));
      if (opts.translate) form.append("translate", String(opts.translate));
      return request<{ job_id: string; status: string }>("/transcribe/upload", {
        method: "POST",
        body: form,
      });
    },

    youtube: (body: { url: string; model_name?: string; language?: string; diarize?: boolean }) =>
      request<{ job_id: string; status: string }>("/transcribe/youtube", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),

    youtubeMetadata: (url: string) =>
      request<YouTubeMetadata>(`/youtube/metadata?url=${encodeURIComponent(url)}`),
  },

  models: {
    list: () => request<ModelInfo[]>("/models"),
    download: (name: string) =>
      request<{ status: string; model: string }>(`/models/${name}/download`, { method: "POST" }),
    cancelDownload: (name: string) =>
      request<{ cancelled: boolean; model: string }>(`/models/${name}/download/cancel`, { method: "POST" }),
    activate: (name: string) =>
      request<{ active_model: string }>(`/models/${name}/activate`, { method: "POST" }),
    delete: (name: string) =>
      fetch(`${BASE_URL}/models/${name}`, { method: "DELETE" }),
    progressUrl: (name: string) => `${BASE_URL}/models/${name}/download/progress`,
  },

  audio: {
    devices: () => request<AudioDevice[]>("/audio/devices"),
    startCapture: (body: { loopback?: boolean; device_index?: number }) =>
      request<{ status: string; loopback: boolean; device: string | null }>("/audio/capture/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    // The body is required — FastAPI rejects this endpoint with 422 without one.
    stopCapture: (body: { transcribe?: boolean; model_name?: string; diarize?: boolean } = {}) =>
      request<{ status: string; job_id?: string; job_type?: string; file: string | null }>(
        "/audio/capture/stop",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ transcribe: true, ...body }),
        }
      ),
    status: () => request<CaptureStatus>("/audio/capture/status"),
  },

  dictation: {
    status: () => request<DictationStatus>("/dictation/status"),
    start: (hotkey?: string) =>
      request<{ status: string; hotkey: string }>("/dictation/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hotkey }),
      }),
    stop: () => request<{ status: string }>("/dictation/stop", { method: "POST" }),
  },

  watchFolder: {
    status: () => request<WatchFolderStatus>("/watch-folder/status"),
    start: (body: { folder_path: string; model_name?: string; diarize?: boolean }) =>
      request<{ status: string; path: string; model: string }>("/watch-folder/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    stop: () => request<{ status: string }>("/watch-folder/stop", { method: "POST" }),
  },

  settings: {
    getAll: () => request<Record<string, unknown>>("/settings"),
    get: (key: string) => request<{ key: string; value: unknown }>(`/settings/${key}`),
    update: (key: string, value: unknown) =>
      request<{ key: string; value: unknown }>(`/settings/${key}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ value }),
      }),
    patch: (updates: Record<string, unknown>) =>
      request<{ updated: string[] }>("/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }),
  },
};
