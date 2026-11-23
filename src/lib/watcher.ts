import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Kind = "device" | "twin" | "heat" | "disk" | "autostart" | "crash" | "threat" | "sensor";
export const KINDS: Kind[] = ["device", "twin", "heat", "disk", "autostart", "crash", "threat", "sensor"];

export interface Settings {
  enabled: boolean;
  off: string[];
  weekly: boolean;
  trayOnClose: boolean;
  lang: string;
}

export interface Alert {
  id: number;
  at: number;
  kind: Kind;
  level: "info" | "warn" | "risk";
  values: Record<string, unknown>;
  read: boolean;
}

interface WatcherStore {
  settings: Settings | null;
  alerts: Alert[];
  autostart: boolean | null;
}

export const useWatcher = create<WatcherStore>(() => ({ settings: null, alerts: [], autostart: null }));

export const unread = (alerts: Alert[]) => alerts.filter((a) => !a.read).length;

export async function loadWatcher() {
  const [settings, alerts, autostart] = await Promise.all([
    invoke<Settings>("watcher_settings"),
    invoke<Alert[]>("watcher_alerts", { limit: 200 }),
    invoke<boolean>("watcher_autostart", { enable: null }).catch(() => null),
  ]);
  useWatcher.setState({ settings, alerts, autostart });
}

export async function saveWatcher(patch: Partial<Settings>) {
  const current = useWatcher.getState().settings;
  if (!current) return;
  const settings = { ...current, ...patch };
  useWatcher.setState({ settings });
  await invoke("watcher_save", { settings });
}

export async function setAutostart(enable: boolean) {
  const autostart = await invoke<boolean>("watcher_autostart", { enable });
  useWatcher.setState({ autostart });
}

export async function readAll() {
  await invoke("watcher_read_all");
  useWatcher.setState((s) => ({ alerts: s.alerts.map((a) => ({ ...a, read: true })) }));
}

export const testNotification = () => invoke("watcher_test");

let started = false;
/** Loads the watcher's state and keeps the list current as alerts arrive. */
export function startWatcher(lang: string) {
  if (started) return;
  started = true;
  loadWatcher()
    .then(() => {
      // Notifications are written by the backend: tell it the interface language.
      if (useWatcher.getState().settings?.lang !== lang) saveWatcher({ lang });
    })
    .catch(console.error);
  listen("watcher:alert", () => invoke<Alert[]>("watcher_alerts", { limit: 200 }).then((alerts) => useWatcher.setState({ alerts })));
}
