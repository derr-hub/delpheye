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
    trackLinked();
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
  /** Where the phone is now, per map, in metres on the plan; `spread` is how unsure (m). */
  pos: Record<string, { x: number; y: number; heading: number | null; at: number; spread: number } | undefined>;
  /** A sample of the particle cloud, to draw. */
  cloud: Record<string, { x: number; y: number }[] | undefined>;
  /** Signal samples from walking around with the phone, per map: the phone's heat map. */
  walk: Record<string, WalkSample[]>;
  /** Walk samples are being recorded. */
  recording: boolean;
}

export interface WalkSample {
  x: number;
  y: number;
  rssi: number;
  t: number;
}

const MAP_KEY = "phone.map";
const loadMap = (): Pick<MapStore, "places" | "offset"> => {
  try {
    return { places: {}, offset: {}, ...JSON.parse(localStorage.getItem(MAP_KEY) ?? "{}") };
  } catch {
    return { places: {}, offset: {} };
  }
};
const WALK_KEY = "phone.walk";
const loadWalk = (): Record<string, WalkSample[]> => {
  try {
    return JSON.parse(localStorage.getItem(WALK_KEY) ?? "{}");
  } catch {
    return {};
  }
};
export const usePhoneMap = create<MapStore>(() => ({ ...loadMap(), pos: {}, cloud: {}, walk: loadWalk(), recording: false }));
const saveWalk = () => {
  try {
    localStorage.setItem(WALK_KEY, JSON.stringify(usePhoneMap.getState().walk));
  } catch {
    /* this session only */
  }
};
export const setRecording = (on: boolean) => usePhoneMap.setState({ recording: on });
export function clearWalk(key: string) {
  usePhoneMap.setState((s) => ({ walk: { ...s.walk, [key]: [] } }));
  saveWalk();
}
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
  usePhoneMap.setState((s) => ({ places: { ...s.places, [key]: [] } }));
  saveMap();
  resetTrack(key);
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

// ───────────────────────── live location: a particle filter ─────────────────────────
//
// 400 guesses ("particles") of where the phone is. Each step moves every guess along the compass,
// each with its own small error in step length and direction; a guess that would walk through a
// wall of the plan or off it dies. Each fresh Wi-Fi scan weighs every guess by how well what the
// phone hears matches what was heard near that spot (the remembered fingerprints, interpolated).
// The cloud's centre is the position; its width is how unsure it is.

interface PlanInfo {
  w: number;
  d: number;
  walls: { x1: number; y1: number; x2: number; y2: number }[];
}
interface Particle {
  x: number;
  y: number;
  w: number;
}
interface Track {
  particles: Particle[];
  steps: number;
  scanAt: number | null;
  lastWalk: { x: number; y: number; t: number } | null;
}

const N = 400;
const STEP_M = 0.7;
const tracks: Record<string, Track> = {};
const gauss = () => {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};

function crossesWall(ax: number, ay: number, bx: number, by: number, w: PlanInfo["walls"][number]) {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, w.x1, w.y1) * o(ax, ay, bx, by, w.x2, w.y2) < 0 && o(w.x1, w.y1, w.x2, w.y2, ax, ay) * o(w.x1, w.y1, w.x2, w.y2, bx, by) < 0;
}

/** What should be heard at (x, y): the remembered fingerprints, weighted by closeness. */
export function expectedAt(places: PhonePlace[], x: number, y: number): Record<string, number> {
  const out: Record<string, number> = {};
  const sum: Record<string, number> = {};
  for (const p of places) {
    const k = 1 / Math.max(0.25, (p.x - x) ** 2 + (p.y - y) ** 2);
    for (const [b, v] of Object.entries(p.vec)) {
      out[b] = (out[b] ?? 0) + v * k;
      sum[b] = (sum[b] ?? 0) + k;
    }
  }
  for (const b of Object.keys(out)) out[b] /= sum[b];
  return out;
}

function spawn(cx: number, cy: number, sd: number, plan: PlanInfo): Particle[] {
  return Array.from({ length: N }, () => ({
    x: Math.max(0, Math.min(plan.w, cx + gauss() * sd)),
    y: Math.max(0, Math.min(plan.d, cy + gauss() * sd)),
    w: 1 / N,
  }));
}

function resample(ps: Particle[]): Particle[] {
  // Systematic resampling, with a little jitter so copies spread out again.
  const out: Particle[] = [];
  const step = 1 / N;
  let u = Math.random() * step;
  let c = ps[0].w;
  let i = 0;
  for (let m = 0; m < N; m++) {
    while (u > c && i < ps.length - 1) c += ps[++i].w;
    out.push({ x: ps[i].x + gauss() * 0.08, y: ps[i].y + gauss() * 0.08, w: step });
    u += step;
  }
  return out;
}

/** One frame for the map `key`: move with the steps, weigh with a fresh scan, estimate. */
export function trackPhone(key: string, plan: PlanInfo) {
  const f = usePhone.getState().frame;
  if (!f) return;
  const { places, offset } = usePhoneMap.getState();
  const known = places[key] ?? [];
  let tr = tracks[key];
  const fresh = f.scanAt !== tr?.scanAt;
  if (!tr) {
    const fp = fingerprintPosition(known, f.scan);
    if (!fp) return;
    tr = tracks[key] = { particles: spawn(fp.x, fp.y, 1.5, plan), steps: f.steps, scanAt: null, lastWalk: null };
  }
  let ps = tr.particles;

  // Move: every new step, along the compass turned to the plan.
  const n = Math.max(0, Math.min(8, f.steps - tr.steps));
  tr.steps = f.steps;
  const heading = f.heading !== null && offset[key] !== undefined ? f.heading - offset[key] : null;
  ps = ps.map((p) => {
    let nx = p.x + gauss() * 0.03;
    let ny = p.y + gauss() * 0.03;
    if (n > 0) {
      if (heading !== null) {
        const a = ((heading + gauss() * 14) * Math.PI) / 180;
        const len = n * (STEP_M + gauss() * 0.12);
        nx += Math.sin(a) * len;
        ny -= Math.cos(a) * len;
      } else {
        // No direction known: the steps only say "somewhere nearby".
        nx += gauss() * 0.5 * n;
        ny += gauss() * 0.5 * n;
      }
    }
    const blocked = nx < 0 || ny < 0 || nx > plan.w || ny > plan.d || plan.walls.some((w) => crossesWall(p.x, p.y, nx, ny, w));
    return blocked ? { x: p.x, y: p.y, w: p.w * 0.02 } : { x: nx, y: ny, w: p.w };
  });

  // Weigh: what the phone hears now against what is expected at each guess.
  if (fresh && known.length >= 2 && f.scan.length) {
    tr.scanAt = f.scanAt;
    const now = Object.fromEntries(f.scan.map((h) => [h.bssid, h.rssi]));
    ps = ps.map((p) => {
      const d = fpDistance(now, expectedAt(known, p.x, p.y));
      return { ...p, w: p.w * Math.exp(-(Math.min(d, 30) ** 2) / (2 * 5 ** 2)) };
    });
  }
  let total = ps.reduce((a, p) => a + p.w, 0);
  if (!(total > 1e-300)) {
    // Every guess died (a jump the model could not follow): start again from the fingerprints.
    const fp = fingerprintPosition(known, f.scan);
    if (!fp) return;
    ps = spawn(fp.x, fp.y, 1.5, plan);
    total = 1;
  }
  ps = ps.map((p) => ({ ...p, w: p.w / total }));
  const neff = 1 / ps.reduce((a, p) => a + p.w * p.w, 0);
  if (neff < N / 2) ps = resample(ps);
  tr.particles = ps;

  // Estimate: the weighted centre and spread.
  const x = ps.reduce((a, p) => a + p.x * p.w, 0);
  const y = ps.reduce((a, p) => a + p.y * p.w, 0);
  const spread = Math.sqrt(ps.reduce((a, p) => a + ((p.x - x) ** 2 + (p.y - y) ** 2) * p.w, 0));
  const pos = { x, y, heading, at: Date.now(), spread: Math.round(spread * 10) / 10 };
  const cloud = ps.filter((_, i) => i % 4 === 0).map((p) => ({ x: p.x, y: p.y }));

  // The walk: the phone's own signal where it is, while recording and fairly sure.
  const st = usePhoneMap.getState();
  let walk = st.walk;
  if (st.recording && f.linkRssi !== null && spread < 2.2) {
    const last = tr.lastWalk;
    if (!last || Math.hypot(last.x - x, last.y - y) > 0.6 || Date.now() - last.t > 6000) {
      tr.lastWalk = { x, y, t: Date.now() };
      walk = { ...walk, [key]: [...(walk[key] ?? []), { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, rssi: f.linkRssi, t: Date.now() }].slice(-1500) };
    }
  }
  usePhoneMap.setState((s) => ({ pos: { ...s.pos, [key]: pos }, cloud: { ...s.cloud, [key]: cloud }, walk }));
  if (walk !== st.walk) saveWalk();
}

let plansAt = 0;
let plans: Record<string, PlanInfo & { image?: string }> = {};
/** Tracks the phone on the map of the network it is connected to, whichever page is open. */
function trackLinked() {
  const f = usePhone.getState().frame;
  if (!f?.linkBssid) return;
  const own = f.scan.find((h) => h.bssid === f.linkBssid);
  if (Date.now() - plansAt > 10_000) {
    plansAt = Date.now();
    try {
      plans = JSON.parse(localStorage.getItem("wifi.plan") ?? "{}");
    } catch {
      plans = {};
    }
  }
  const key = own?.ssid && plans[own.ssid] ? own.ssid : plans[f.linkBssid] ? f.linkBssid : null;
  if (!key) return;
  const p = plans[key];
  trackPhone(key, { w: p.w, d: p.d, walls: p.walls ?? [] });
}

/** Forgets the live track of a map (after its fingerprints change). */
export function resetTrack(key: string) {
  delete tracks[key];
  usePhoneMap.setState((s) => ({ pos: { ...s.pos, [key]: undefined }, cloud: { ...s.cloud, [key]: undefined } }));
}
