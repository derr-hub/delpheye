import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface OverlaySettings {
  enabled: boolean;
  pc: boolean;
  fps: boolean;
  net: boolean;
  alerts: boolean;
}

export interface Fps {
  fps: number;
  frameMs: number;
  worstMs: number;
  app: string;
}

/** What the overlay window gets once a second, besides the `metrics` event. */
export interface Tick {
  cpuTemp: number | null;
  gpuTemp: number | null;
  gpuLoad: number | null;
  fps: Fps | null;
  fpsStatus: "listening" | "off" | "failed";
  routerMs: number | null;
  internetMs: number | null;
  loss: number | null;
  wifi: { ssid: string; rssi: number; quality: number } | null;
  elevated: boolean;
}

export const TOGGLE_KEY = "Ctrl+Shift+F12";
export const OPEN_KEY = "Ctrl+Shift+F11";

export const useOverlay = create<{ settings: OverlaySettings | null }>(() => ({ settings: null }));

let listening = false;
export async function loadOverlay() {
  if (!listening) {
    listening = true;
    listen<OverlaySettings>("overlay:settings", ({ payload }) => useOverlay.setState({ settings: payload }));
  }
  useOverlay.setState({ settings: await invoke<OverlaySettings>("overlay_settings") });
}

export async function saveOverlay(patch: Partial<OverlaySettings>) {
  const current = useOverlay.getState().settings;
  if (!current) return;
  const settings = { ...current, ...patch };
  useOverlay.setState({ settings });
  await invoke("overlay_save", { settings });
}

export const testOverlay = () => invoke<boolean>("overlay_test");
