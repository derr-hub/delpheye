import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Band = "2.4" | "5" | "6";

export interface Bss {
  bssid: string;
  ssid: string;
  hidden: boolean;
  rssi: number;
  quality: number;
  mhz: number;
  band: Band;
  channel: number;
  width: number;
  lowMhz: number;
  highMhz: number;
  generation: number;
  security: "open" | "owe" | "wep" | "wpa" | "wpa2" | "wpa2-wpa3" | "wpa3" | "enterprise";
  tkip: boolean;
  pmf: boolean;
  wps: boolean;
  stations: number | null;
  utilization: number | null;
  country: string | null;
  beaconMs: number;
  connected: boolean;
  randomMac: boolean;
  distanceM: number;
}

export interface Link {
  interface: string;
  ssid: string;
  bssid: string;
  rssi: number;
  quality: number;
  rxMbps: number;
  txMbps: number;
}

export interface ChannelLoad {
  channel: number;
  width: number;
  lowMhz: number;
  highMhz: number;
  interference: number;
  networks: number;
  dfs: boolean;
}

export interface Analysis {
  own: {
    ssid: string;
    bssid: string;
    band: Band;
    channel: number;
    width: number;
    rssi: number;
    signal: "excellent" | "good" | "fair" | "weak" | "bad";
    congestion: "free" | "moderate" | "busy" | "crowded";
    interference: number;
    overlapping: number;
    best: ChannelLoad | null;
    gain: number;
  } | null;
  bands: { band: Band; networks: number; candidates: ChannelLoad[] }[];
  advice: { id: string; level: "ok" | "info" | "warn" | "risk"; values: Record<string, unknown> }[];
  total: number;
  names: number;
  hidden: number;
  open: number;
  /** Access points of the user's own router: its main network, guest network, other band. */
  mine: string[];
}

export interface Snapshot {
  state: "ok" | "off" | "none" | "denied" | "error";
  interface: string | null;
  link: Link | null;
  networks: Bss[];
  analysis: Analysis | null;
  at: number;
}

export type Sample = { t: number; rssi: number };

interface WifiState {
  snap: Snapshot | null;
  link: Link | null;
  scanning: boolean;
  /** Per access point, the signal at each scan, last 10 minutes. */
  history: Record<string, Sample[]>;
  /** The connection's own signal, once a second, last 5 minutes. */
  linkHistory: Sample[];
  mode: "simple" | "advanced" | "pro";
  /** First time each access point was heard in this session. */
  firstSeen: Record<string, number>;
}

const savedMode = (() => {
  try {
    const m = localStorage.getItem("wifi.mode");
    return m === "advanced" || m === "pro" ? m : "simple";
  } catch {
    return "simple";
  }
})();

export const useWifi = create<WifiState>(() => ({
  snap: null,
  link: null,
  scanning: false,
  history: {},
  linkHistory: [],
  mode: savedMode,
  firstSeen: {},
}));

export function setMode(mode: "simple" | "advanced" | "pro") {
  useWifi.setState({ mode });
  try {
    localStorage.setItem("wifi.mode", mode);
  } catch {
    /* per-viewer convenience only */
  }
}

const KEEP_MS = 10 * 60_000;

function absorb(snap: Snapshot) {
  useWifi.setState((s) => {
    const history = { ...s.history };
    const firstSeen = { ...s.firstSeen };
    for (const b of snap.networks) {
      const list = (history[b.bssid] ?? []).filter((x) => snap.at - x.t < KEEP_MS);
      list.push({ t: snap.at, rssi: b.rssi });
      history[b.bssid] = list;
      firstSeen[b.bssid] ??= snap.at;
    }
    return { snap, history, firstSeen, link: snap.link ?? s.link };
  });
}

let running = false;
let linkTimer = 0;

/** Scans continuously while the page is open: one scan takes ~3 s, then a short pause. */
export function startWifi() {
  if (running) return;
  running = true;
  invoke<Snapshot>("wifi_snapshot", { scan: false }).then(absorb).catch(console.error);
  (async () => {
    while (running) {
      useWifi.setState({ scanning: true });
      try {
        absorb(await invoke<Snapshot>("wifi_snapshot", { scan: true }));
      } catch (e) {
        console.error("wifi_snapshot failed", e);
      }
      useWifi.setState({ scanning: false });
      const state = useWifi.getState().snap?.state;
      await new Promise((r) => setTimeout(r, state === "ok" ? 1500 : 4000));
    }
  })();
  linkTimer = window.setInterval(async () => {
    try {
      const link = await invoke<Link | null>("wifi_link");
      useWifi.setState((s) => ({
        link,
        linkHistory: link ? [...s.linkHistory.filter((x) => Date.now() - x.t < 5 * 60_000), { t: Date.now(), rssi: link.rssi }] : s.linkHistory,
      }));
    } catch {
      /* the next tick tries again */
    }
  }, 1000);
}

export function stopWifi() {
  running = false;
  window.clearInterval(linkTimer);
}

export const BAND_COLORS: Record<Band, string> = { "2.4": "#F5A35C", "5": "#4CC2FF", "6": "#B48CFF" };

/** Windows' 0–100 scale: linear from −100 dBm to −50 dBm. */
export const percent = (rssi: number) => Math.max(0, Math.min(100, 2 * (rssi + 100)));

export function signalLevel(rssi: number): "excellent" | "good" | "fair" | "weak" | "bad" {
  if (rssi >= -55) return "excellent";
  if (rssi >= -67) return "good";
  if (rssi >= -75) return "fair";
  if (rssi >= -82) return "weak";
  return "bad";
}

export const LEVEL_COLOR = {
  excellent: "var(--color-safe)",
  good: "var(--color-safe)",
  fair: "var(--color-warn)",
  weak: "var(--color-warn)",
  bad: "var(--color-risk)",
} as const;

/** Display name, with hidden networks named by their address. */
export const nameOf = (b: Bss, hidden: string) => (b.hidden ? `${hidden} · ${b.bssid.slice(-5)}` : b.ssid);

/**
 * The average signal of one access point over the next `ms` milliseconds: once-a-second readings
 * for the connected network, scan results for any other (one reading jumps by several dB).
 */
export async function measure(bssid: string, ms: number): Promise<number | null> {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  const st = useWifi.getState();
  const live = st.link?.bssid === bssid;
  const pool = (live ? st.linkHistory : (st.history[bssid] ?? [])).filter((s) => s.t >= start - (live ? 0 : 1500));
  if (pool.length) return Math.round((pool.reduce((a, b) => a + b.rssi, 0) / pool.length) * 10) / 10;
  return st.snap?.networks.find((n) => n.bssid === bssid)?.rssi ?? null;
}

export const isLive = (bssid: string | null) => !!bssid && useWifi.getState().link?.bssid === bssid;
