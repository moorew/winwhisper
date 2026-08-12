import { useEffect, useState } from "react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { api, setEnginePort } from "@/lib/api";
import Layout from "@/components/Layout";
import Onboarding from "@/components/Onboarding";
import Dashboard from "@/pages/Dashboard";
import Editor from "@/pages/Editor";
import Models from "@/pages/Models";
import Settings from "@/pages/Settings";

export default function App() {
  const [engineReady, setEngineReady] = useState(false);

  useEffect(() => {
    let stopped = false;

    function applyPort(port: number) {
      if (stopped) return;
      setEnginePort(port);
      setEngineReady(true);
      stopped = true; // stop polling once we have the port
    }

    // Primary: listen for the event emitted by Rust when the engine TCP port is live.
    // Do not swallow the rejection quietly — this call is denied outright if the
    // app ships without a capability granting core:event, and that silence is
    // what hid the same failure breaking drag-and-drop for a whole release.
    const unlistenPromise = listen<number>("engine-ready", (event) => {
      applyPort(event.payload);
    }).catch((err) => {
      console.error(
        "[WinWhisper] could not subscribe to engine-ready; falling back to polling.",
        err
      );
      return null;
    });

    // Fallback: poll every 2 s in case the event fires before the listener is attached
    // (e.g. very fast engine startup) or when running in dev without the Tauri shell.
    const poll = setInterval(async () => {
      if (stopped) { clearInterval(poll); return; }
      try {
        const port = await invoke<number | null>("get_engine_port");
        if (port) applyPort(port);
      } catch {
        try {
          const health = await api.health();
          if (health.status === "ok") {
            setEngineReady(true);
            stopped = true;
          }
        } catch {
          // Running in browser dev mode without a reachable engine.
        }
      }
    }, 2000);

    return () => {
      stopped = true;
      clearInterval(poll);
      unlistenPromise.then((fn) => fn?.());
    };
  }, []);

  return (
    <div className="h-screen bg-background text-foreground overflow-hidden">
      <Layout engineReady={engineReady}>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/editor/:id" element={<Editor />} />
          <Route path="/models" element={<Models />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
      {engineReady && <Onboarding />}
    </div>
  );
}
