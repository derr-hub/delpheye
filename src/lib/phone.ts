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

// ───────────────────────── the phone on the home map ─────────────────────────

export interface PhonePlace {
  x: number;
  y: number;
  vec: Record<string, number>;
}

interface MapStore {
  /** Fingerprints taken with the phone, per home map (network). */
  places: Record<string, PhonePlace[]>;
  /** The phone's compass heading when facing the top of the plan, per map. */
  offset: Record<string, number>;
  /** Where the phone is now, per map, in metres on the plan. */
  pos: Record<string, { x: number; y: number; heading: number | null; at: number } | undefined>;
}

const MAP_KEY = "phone.map";
const loadMap = (): Pick<MapStore, "places" | "offset"> => {
  try {
    return { places: {}, offset: {}, ...JSON.parse(localStorage.getItem(MAP_KEY) ?? "{}") };
  } catch {
    return { places: {}, offset: {} };
  }
};
export const usePhoneMap = create<MapStore>(() => ({ ...loadMap(), pos: {} }));
const saveMap = () => {
  const { places, offset } = usePhoneMap.getState();
  try {
    localStorage.setItem(MAP_KEY, JSON.stringify({ places, offset }));
  } catch {
    /* this session only */
  }
};

/** The phone's signal from one network over the next `ms`: its own connection when it is on it. */
export async function measurePhone(bssid: string, ssid: string, ms: number): Promise<number | null> {
  const got: number[] = [];
  const unsub = usePhone.subscribe((s, prev) => {
    if (s.frame === prev.frame || !s.frame) return;
    const f = s.frame;
    const own = f.linkBssid === bssid || (f.linkBssid && f.scan.find((h) => h.bssid === f.linkBssid)?.ssid === ssid);
    if (own && f.linkRssi !== null) got.push(f.linkRssi);
    else {
      const h = f.scan.find((x) => x.bssid === bssid) ?? f.scan.filter((x) => x.ssid === ssid).sort((a, b) => b.rssi - a.rssi)[0];
      if (h) got.push(h.rssi);
    }
  });
  await new Promise((r) => setTimeout(r, ms));
  unsub();
  return got.length ? Math.round((got.reduce((a, b) => a + b, 0) / got.length) * 10) / 10 : null;
}

export function calibrate(key: string) {
  const h = usePhone.getState().frame?.heading;
  if (h === null || h === undefined) return false;
  usePhoneMap.setState((s) => ({ offset: { ...s.offset, [key]: h } }));
  saveMap();
  return true;
}

/** Remembers what the phone hears at (x, y): 6 s of scans, averaged per access point. */
export async function rememberPhonePlace(key: string, x: number, y: number) {
  const sums: Record<string, number[]> = {};
  const unsub = usePhone.subscribe((s, prev) => {
    if (s.frame === prev.frame || !s.frame) return;
    for (const h of s.frame.scan) (sums[h.bssid] ??= []).push(h.rssi);
  });
  await new Promise((r) => setTimeout(r, 6000));
  unsub();
  const vec = Object.fromEntries(Object.entries(sums).map(([b, v]) => [b, v.reduce((a, c) => a + c, 0) / v.length]));
  if (!Object.keys(vec).length) return false;
  usePhoneMap.setState((s) => ({ places: { ...s.places, [key]: [...(s.places[key] ?? []), { x, y, vec }] } }));
  saveMap();
  return true;
}

export function forgetPhonePlaces(key: string) {
  usePhoneMap.setState((s) => ({ places: { ...s.places, [key]: [] }, pos: { ...s.pos, [key]: undefined } }));
  saveMap();
}

/** Mean dB difference over clearly heard access points; one-sided ones cost a fixed amount. */
function fpDistance(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => (a[k] ?? -95) > -80 || (b[k] ?? -95) > -80));
  if (!keys.size) return Infinity;
  let sum = 0;
  for (const k of keys) sum += a[k] !== undefined && b[k] !== undefined ? Math.abs(a[k] - b[k]) : 6;
  return sum / keys.size;
}

/** Weighted k-nearest remembered places: where the current scan best fits. */
export function fingerprintPosition(places: PhonePlace[], scan: Heard[]): { x: number; y: number } | null {
  if (places.length < 2 || !scan.length) return null;
  const now = Object.fromEntries(scan.map((h) => [h.bssid, h.rssi]));
  const ranked = places.map((p) => ({ p, d: fpDistance(now, p.vec) })).sort((a, b) => a.d - b.d).slice(0, 3);
  let wx = 0;
  let wy = 0;
  let w = 0;
  for (const { p, d } of ranked) {
    const k = 1 / Math.max(0.5, d) ** 2;
    wx += p.x * k;
    wy += p.y * k;
    w += k;
  }
  return { x: wx / w, y: wy / w };
}

const STEP_M = 0.7;
let tracked: { steps: number; scanAt: number | null } = { steps: -1, scanAt: null };

/**
 * Moves the phone's point on `key`'s map with each frame: a step forward along the compass between
 * scans (dead reckoning), and pulled towards the fingerprint estimate whenever a new scan arrives.
 */
export function trackPhone(key: string, w: number, d: number) {
  const f = usePhone.getState().frame;
  if (!f) return;
  const { places, offset, pos } = usePhoneMap.getState();
  let p = pos[key] ? { ...pos[key]! } : null;
  // Steps since the last frame, along the heading turned into plan directions.
  if (p && tracked.steps >= 0 && f.steps > tracked.steps && f.heading !== null && offset[key] !== undefined) {
    const n = Math.min(6, f.steps - tracked.steps);
    const a = ((f.heading - offset[key]) * Math.PI) / 180;
    p.x += Math.sin(a) * STEP_M * n;
    p.y -= Math.cos(a) * STEP_M * n;
  }
  tracked.steps = f.steps;
  // A fresh scan: blend in where the fingerprints put the phone.
  if (f.scanAt !== tracked.scanAt) {
    tracked.scanAt = f.scanAt;
    const fp = fingerprintPosition(places[key] ?? [], f.scan);
    if (fp) p = p ? { ...p, x: p.x * 0.4 + fp.x * 0.6, y: p.y * 0.4 + fp.y * 0.6 } : { ...fp, heading: null, at: 0 };
  }
  if (!p) return;
  p.x = Math.max(0, Math.min(w, p.x));
  p.y = Math.max(0, Math.min(d, p.y));
  p.heading = f.heading !== null && offset[key] !== undefined ? f.heading - offset[key] : null;
  p.at = Date.now();
  usePhoneMap.setState((s) => ({ pos: { ...s.pos, [key]: p } }));
}
