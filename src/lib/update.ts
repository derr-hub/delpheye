import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

type Phase = "idle" | "checking" | "none" | "available" | "downloading" | "ready" | "error";

interface State {
  phase: Phase;
  version: string | null;
  notes: string | null;
  /** 0–1 while downloading. */
  progress: number;
  error: string | null;
}

export const useUpdate = create<State>(() => ({ phase: "idle", version: null, notes: null, progress: 0, error: null }));

let pending: Update | null = null;
const LAST_CHECK = "delpheye.updateChecked";
const DAY = 24 * 60 * 60 * 1000;

/** Asks GitHub whether a newer release exists. `quiet` checks at most once a day and stays silent on errors. */
export async function checkForUpdate(quiet = false) {
  if (!("__TAURI_INTERNALS__" in window) || import.meta.env.DEV) return;
  if (quiet) {
    try {
      const last = Number(localStorage.getItem(LAST_CHECK) ?? 0);
      if (Date.now() - last < DAY) return;
      localStorage.setItem(LAST_CHECK, String(Date.now()));
    } catch {
      /* storage unavailable: just check */
    }
  }
  useUpdate.setState({ phase: "checking", error: null });
  try {
    pending = await check();
    useUpdate.setState(pending ? { phase: "available", version: pending.version, notes: pending.body ?? null } : { phase: "none" });
  } catch (e) {
    useUpdate.setState(quiet ? { phase: "idle" } : { phase: "error", error: String(e) });
  }
}

/** Downloads and installs the update, then restarts into the new version. */
export async function installUpdate() {
  if (!pending) return;
  let total = 0;
  let done = 0;
  useUpdate.setState({ phase: "downloading", progress: 0 });
  try {
    await pending.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        done += event.data.chunkLength;
        useUpdate.setState({ progress: total ? done / total : 0 });
      } else if (event.event === "Finished") useUpdate.setState({ phase: "ready", progress: 1 });
    });
    await relaunch();
  } catch (e) {
    useUpdate.setState({ phase: "error", error: String(e) });
  }
}
