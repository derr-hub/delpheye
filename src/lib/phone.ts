import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Pairing {
  addresses: string[];
  port: number;
  code: string;
  link: string;
  paired: boolean;
  device: string | null;
}

export interface Heard {
  bssid: string;
  ssid: string;
  rssi: number;
  freq: number;
}

export interface Frame {
  t: number;
  heading: number | null;
  steps: number;
  scan: Heard[];
  scanAt: number | null;
  linkBssid: string | null;
  linkRssi: number | null;
}

/** One reading of the phone's own connection against the way it faced. */
export interface Bearing {
  t: number;
  heading: number;
  rssi: number;
}

interface PhoneStore {
  pairing: Pairing | null;
  frame: Frame | null;
  /** When the last frame arrived (computer clock). */
  at: number;
  bearings: Bearing[];
  error: string | null;
}

export const usePhone = create<PhoneStore>(() => ({ pairing: null, frame: null, at: 0, bearings: [], error: null }));

export const live = (s: PhoneStore) => !!s.frame && Date.now() - s.at < 5000;

let listening = false;
function listenOnce() {
  if (listening) return;
  listening = true;
  listen<Frame>("phone:frame", ({ payload }) => {
    usePhone.setState((s) => {
      const now = Date.now();
      const bearings =
        payload.heading !== null && payload.linkRssi !== null
          ? [...s.bearings.filter((b) => now - b.t < 90_000), { t: now, heading: payload.heading, rssi: payload.linkRssi }]
          : s.bearings;
      return { frame: { ...payload, scan: payload.scan.map((h) => ({ ...h, bssid: h.bssid.toUpperCase() })), linkBssid: payload.linkBssid?.toUpperCase() ?? null }, at: now, bearings };
    });
  });
  listen("phone:paired", () => invoke<Pairing>("companion_state").then((pairing) => usePhone.setState({ pairing })));
  listen<string>("phone:code", ({ payload }) => usePhone.setState((s) => ({ pairing: s.pairing ? { ...s.pairing, code: payload, link: s.pairing.link.replace(/c=\d+/, `c=${payload}`) } : s.pairing })));
}

export async function startPairing() {
  listenOnce();
  try {
    usePhone.setState({ pairing: await invoke<Pairing>("companion_start"), error: null });
  } catch (e) {
    usePhone.setState({ error: String(e) });
  }
}

export async function refreshPairing() {
  listenOnce();
  usePhone.setState({ pairing: await invoke<Pairing>("companion_state") });
}

export async function stopPairing() {
  await invoke("companion_stop");
  usePhone.setState({ pairing: null, frame: null, bearings: [] });
}

/**
 * The router's direction from the phone's own body shadow: as the user turns on the spot, the
 * connection is weakest with the router behind. Readings are grouped into 12 sectors of 30°; once
 * enough of the circle is covered, the power-weighted mean of the sectors points to the router.
 */
export function routerBearing(bearings: Bearing[]): { angle: number; coverage: number; spread: number } | null {
  const sectors: number[][] = Array.from({ length: 12 }, () => []);
  for (const b of bearings) sectors[Math.floor(((b.heading % 360) + 360) % 360 / 30)].push(b.rssi);
  const covered = sectors.filter((s) => s.length).length;
  const coverage = covered / 12;
  if (covered < 8) return { angle: NaN, coverage, spread: 0 };
  const means = sectors.map((s) => (s.length ? s.reduce((a, b) => a + b, 0) / s.length : null));
  const values = means.filter((m): m is number => m !== null);
  const floor = Math.min(...values.map((m) => 10 ** (m / 10)));
  let x = 0;
  let y = 0;
  means.forEach((m, k) => {
    if (m === null) return;
    const p = 10 ** (m / 10) - floor;
    const a = ((k * 30 + 15) * Math.PI) / 180;
    x += p * Math.sin(a);
    y += p * Math.cos(a);
  });
  return { angle: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360, coverage, spread: Math.max(...values) - Math.min(...values) };
}
