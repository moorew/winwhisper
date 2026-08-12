import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import {
  CompletionToast,
  DictationHud,
  RecorderWindow,
} from "./windows/CaptureWindows";
import "./globals.css";

/*
 * One bundle serves the main window and the floating capture windows; the
 * `?window=` parameter picks which. A query parameter rather than a route,
 * because Tauri's asset protocol serves files and would 404 on a client-side
 * path like /capture/recorder.
 */
const captureWindow = new URLSearchParams(location.search).get("window");

// Theme choice may be "system"; resolve it the same way Settings does.
const stored = localStorage.getItem("ww-theme") ?? "dark";
const effective =
  stored === "system"
    ? window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark"
    : stored;
// The floating windows are dark only — they sit over other applications.
document.documentElement.classList.add(captureWindow ? "dark" : effective);

const CAPTURE_WINDOWS: Record<string, () => JSX.Element> = {
  recorder: RecorderWindow,
  dictation: DictationHud,
  toast: CompletionToast,
};

const root = ReactDOM.createRoot(document.getElementById("root")!);

if (captureWindow && CAPTURE_WINDOWS[captureWindow]) {
  const Window = CAPTURE_WINDOWS[captureWindow];
  root.render(
    <React.StrictMode>
      <Window />
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>
  );
}
