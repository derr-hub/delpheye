import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Page = "overview" | "cleanup" | "leftovers" | "startup" | "disk" | "monitoring" | "processes" | "network" | "security" | "journal";

export interface AppStatus {
  elevated: boolean;
  /** Debug-only mode in which cleanup works on a fake folder tree. */
  sandbox: boolean;
  version: string;
  /** The window has the Mica backdrop (Windows 11). */
  mica: boolean;
}

interface AppState {
  page: Page;
  status: AppStatus | null;
}

export const useApp = create<AppState>(() => ({ page: "overview", status: null }));

export const go = (page: Page) => useApp.setState({ page });

export function loadAppStatus() {
  invoke<AppStatus>("app_status")
    .then((status) => {
      useApp.setState({ status });
      document.documentElement.classList.toggle("mica", status.mica);
    })
    .catch((e) => console.error("app_status failed", e));
}

/** Restarts the app with administrator rights. Resolves to false if the user declined. */
export async function relaunchElevated(): Promise<boolean> {
  try {
    await invoke("relaunch_elevated");
    return true;
  } catch {
    return false;
  }
}
