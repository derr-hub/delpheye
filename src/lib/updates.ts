import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Package {
  name: string;
  id: string;
  version: string;
  available: string;
  source: string;
  /** winget only updates it when asked for it by name. */
  explicit: boolean;
}

export type RowState = { state: "running" } | { state: "done" } | { state: "failed"; reason: string; code: number };

interface UpdatesState {
  phase: "idle" | "loading" | "list" | "installing";
  list: Package[];
  error: string | null;
  checkedAt: number | null;
  rows: Record<string, RowState>;
}

export const useUpdates = create<UpdatesState>(() => ({ phase: "idle", list: [], error: null, checkedAt: null, rows: {} }));

let listening = false;
function startEvents() {
  if (listening) return;
  listening = true;
  listen<{ id: string; state: "running" | "done" | "failed"; reason?: string; code?: number }>("updates:progress", ({ payload }) => {
    const row: RowState =
      payload.state === "failed" ? { state: "failed", reason: payload.reason ?? "failed", code: payload.code ?? -1 } : { state: payload.state };
    useUpdates.setState((s) => ({ rows: { ...s.rows, [payload.id]: row } }));
  });
}

export async function checkUpdates() {
  startEvents();
  useUpdates.setState({ phase: "loading", error: null });
  try {
    const list = await invoke<Package[]>("updates_list");
    useUpdates.setState({ phase: "list", list, checkedAt: Date.now(), rows: {} });
  } catch (e) {
    useUpdates.setState({ phase: "idle", error: String(e) });
  }
}

export async function installUpdates(ids: string[]) {
  startEvents();
  useUpdates.setState((s) => {
    const rows = { ...s.rows };
    for (const id of ids) delete rows[id];
    return { phase: "installing", rows };
  });
  try {
    await invoke<string>("restore_before", { what: "updates" }).catch(() => "");
    await invoke("updates_install", { ids });
  } catch (e) {
    useUpdates.setState({ error: String(e) });
  }
  useUpdates.setState({ phase: "list" });
}

export const cancelUpdates = () => invoke("updates_cancel");
