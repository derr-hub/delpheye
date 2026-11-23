import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Kind = "webcam" | "microphone" | "location";

export interface Use {
  key: string;
  name: string;
  path: string | null;
  packaged: boolean;
  system: boolean;
  /** Unix milliseconds. */
  started: number | null;
  stopped: number | null;
  active: boolean;
  /** Windows still marks it in use, but the program has gone (crashed or was killed). */
  stale: boolean;
  permission: "allow" | "deny" | null;
}

export interface Capability {
  kind: Kind;
  allowed: boolean;
  desktopAllowed: boolean;
  uses: Use[];
}

interface PrivacyState {
  caps: Capability[] | null;
  error: string | null;
}

export const usePrivacy = create<PrivacyState>(() => ({ caps: null, error: null }));

export async function refreshPrivacy() {
  try {
    const caps = await invoke<Capability[]>("privacy_usage");
    usePrivacy.setState({ caps, error: null });
  } catch (e) {
    usePrivacy.setState({ error: String(e) });
  }
}

let timer = 0;
/** Keeps the list current, so a camera turning on shows up anywhere in the app within seconds. */
export function startPrivacy() {
  if (timer) return;
  refreshPrivacy();
  timer = window.setInterval(() => {
    // In the tray nothing shows it; the watcher keeps the history itself in the background.
    if (!document.hidden) refreshPrivacy();
  }, 4000);
}

/** What is using the camera, microphone or location at this moment. */
export function useActiveUses(): { kind: Kind; use: Use }[] {
  const caps = usePrivacy((s) => s.caps);
  return (caps ?? []).flatMap((c) => c.uses.filter((u) => u.active).map((use) => ({ kind: c.kind, use })));
}

export const SETTINGS: Record<Kind, string> = {
  webcam: "ms-settings:privacy-webcam",
  microphone: "ms-settings:privacy-microphone",
  location: "ms-settings:privacy-location",
};
