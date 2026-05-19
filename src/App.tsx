import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { setEnginePort } from "@/lib/api";
import Layout from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Editor from "@/pages/Editor";
import Models from "@/pages/Models";
import Settings from "@/pages/Settings";

export default function App() {
  // Retrieve the dynamic engine port from Rust state and update the API base URL
  useEffect(() => {
    invoke<number | null>("get_engine_port")
      .then((port) => {
        if (port) setEnginePort(port);
      })
      .catch(() => {
        // Running in dev without Tauri shell — use default port
      });
  }, []);

  return (
    <div className="h-screen bg-background text-foreground overflow-hidden">
      <Layout>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/editor/:id" element={<Editor />} />
          <Route path="/models" element={<Models />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </Layout>
    </div>
  );
}
