import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { api, JobResponse } from "@/lib/api";
import { formatDuration } from "@/lib/utils";

/** Opens a floating capture window; a no-op outside Tauri. */
export async function openCaptureWindow(kind: string, query = "") {
  try {
    await invoke("open_capture_window", { kind, query });
  } catch {
    /* running in a browser */
  }
}

export async function closeCaptureWindow(kind: string) {
  try {
    await invoke("close_capture_window", { kind });
  } catch {
    /* running in a browser */
  }
}

/**
 * Drives the floating dictation HUD and completion toast from engine state.
 *
 * The HUD is shown for exactly as long as the dictation hotkey is held, and a
 * toast appears when a job reaches "done". Both are triggered here, in the main
 * window, because it is the only place already polling the engine.
 */
export function useCaptureWindows(engineReady: boolean) {
  const hudOpen = useRef(false);
  const seenDone = useRef<Set<string>>(new Set());
  const primed = useRef(false);

  // ── Dictation HUD ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!engineReady) return;
    let stopped = false;

    const poll = async () => {
      try {
        const s = await api.dictation.status();
        if (stopped) return;
        if (s.is_recording && !hudOpen.current) {
          hudOpen.current = true;
          await openCaptureWindow("dictation");
        } else if (!s.is_recording && hudOpen.current) {
          hudOpen.current = false;
          await closeCaptureWindow("dictation");
        }
      } catch {
        /* engine unreachable */
      }
    };

    const id = setInterval(poll, 400);
    return () => { stopped = true; clearInterval(id); };
  }, [engineReady]);

  // ── Completion toast ──────────────────────────────────────────────────
  useEffect(() => {
    if (!engineReady) return;
    let stopped = false;

    const poll = async () => {
      let done: JobResponse[] = [];
      try {
        done = await api.jobs.list({ status: "done", limit: 5 });
      } catch {
        return;
      }
      if (stopped) return;

      // The first pass only records what already existed, so opening the app
      // does not fire a toast for every transcript made yesterday.
      if (!primed.current) {
        done.forEach((j) => seenDone.current.add(j.id));
        primed.current = true;
        return;
      }

      for (const job of done) {
        if (seenDone.current.has(job.id)) continue;
        seenDone.current.add(job.id);
        if (!job.transcript_id) continue;

        let meta = "";
        try {
          const t = await api.transcripts.get(job.transcript_id);
          meta = [
            t.duration != null ? formatDuration(t.duration) : null,
            `${t.word_count.toLocaleString()} words`,
          ]
            .filter(Boolean)
            .join(" · ");
        } catch {
          /* toast still works without the detail line */
        }

        const query =
          `&name=${encodeURIComponent(job.source_name ?? "Transcript")}` +
          `&meta=${encodeURIComponent(meta)}` +
          `&id=${encodeURIComponent(job.transcript_id)}`;
        await openCaptureWindow("toast", query);
      }
    };

    const id = setInterval(poll, 2500);
    return () => { stopped = true; clearInterval(id); };
  }, [engineReady]);
}

/**
 * The toast's "Open" action hands a transcript id over through localStorage,
 * since the two windows share an origin but not a router.
 */
export function useToastNavigation(navigate: (path: string) => void) {
  useEffect(() => {
    const check = () => {
      const id = localStorage.getItem("ww-open-transcript");
      if (id) {
        localStorage.removeItem("ww-open-transcript");
        navigate(`/editor/${id}`);
      }
    };
    check();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "ww-open-transcript") check();
    };
    window.addEventListener("storage", onStorage);
    const id = setInterval(check, 800);
    return () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(id);
    };
  }, [navigate]);
}
