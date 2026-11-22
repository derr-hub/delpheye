import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { invoke } from "@tauri-apps/api/core";

// Anything the interface does not catch goes to the error log, so problems on other computers
// can be traced afterwards.
const report = (message: string) => {
  if ("__TAURI_INTERNALS__" in window) invoke("log_error", { message }).catch(() => {});
};
window.addEventListener("error", (e) => report(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => report(`unhandled: ${String(e.reason)}`));
import "./i18n";
import "./styles.css";

async function boot() {
  // Plain-browser preview (`npm run dev` without Tauri): feed the UI simulated data.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window)) {
    (await import("./lib/devMock")).installDevMock();
  }
  // The overlay window loads the same page and draws only the island.
  if ("__TAURI_INTERNALS__" in window) {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (getCurrentWindow().label === "overlay") {
      const { Overlay } = await import("./overlay/Overlay");
      ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Overlay />);
      return;
    }
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

boot();
