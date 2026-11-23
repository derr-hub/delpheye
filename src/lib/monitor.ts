import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Sensor {
  id: string;
  name: string;
  type: string;
  value: number;
}

export interface Hardware {
  id: string;
  name: string;
  type: string;
  parent?: string | null;
  sensors: Sensor[];
}

export type ThrottleState = "unknown" | "idle" | "full" | "power" | "thermal";

export interface Throttle {
  state: ThrottleState;
  /** Current clock as a share of the recent best under load, in percent. */
  speed: number | null;
  mhz: number | null;
  peakMhz: number | null;
  load: number | null;
  temp: number | null;
  tempSource: "sensor" | "acpi" | null;
  firmwareCap: number | null;
  onBattery: boolean;
  session: { busy: number; full: number; power: number; thermal: number };
}

export interface Frame {
  at: number;
  elevated: boolean;
  hardware: Hardware[];
  disks: { name: string; media: string; health: string; size: number }[];
  windows?: { perf: number | null; nominalMhz: number | null; utility: number | null; zones: { name: string; temp: number; passive: number | null }[] } | null;
  throttle?: Throttle | null;
}

export interface CoolingProfile {
  at: number;
  idle: number;
  plateau: number;
  peak: number;
  heatRate: number;
  sustained: number | null;
  thermalSeconds: number;
  cooled: number;
  source: "sensor" | "acpi";
}

export type Level = "unknown" | "ok" | "warn" | "bad";

export interface Check {
  id: string;
  subject: string | null;
  level: Level;
  reasons: string[];
  values: Record<string, unknown> | null;
}

export interface SensorStatus {
  running: boolean;
  problem: string | null;
}

export interface QuickReport {
  elevated: boolean;
  sensors: SensorStatus;
  logDays: number;
  checks: Check[];
}

export interface Point {
  t: number;
  phase: "idle" | "load" | "cool";
  load: number;
  mhz: number;
  cpuTemp: number | null;
  gpuTemp: number | null;
  errors: number;
  fans: [string, number][];
  throttle: ThrottleState | null;
  gpuLoad: number | null;
  gpuClock: number | null;
  gpuMem: number | null;
  gpuPower: number | null;
  ramErrors: number;
  gpuErrors: number;
}

export interface StressOptions {
  cpu: boolean;
  ram: boolean;
  /** DXGI adapter index of the graphics card to test. */
  gpu: number | null;
  minutes: number;
}

export interface StressPlan {
  idle: number;
  load: number;
  cool: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  vram: number;
  integrated: boolean;
}

const STANDARD_PLAN: StressPlan = { idle: 20, load: 120, cool: 40 };
const OPTIONS_KEY = "delpheye.stressOptions";

function savedOptions(): StressOptions {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (saved && typeof saved.cpu === "boolean") return { cpu: saved.cpu, ram: !!saved.ram, gpu: typeof saved.gpu === "number" ? saved.gpu : null, minutes: [3, 10, 30].includes(saved.minutes) ? saved.minutes : 3 };
  } catch {
    /* ignore */
  }
  return { cpu: true, ram: false, gpu: null, minutes: 3 };
}

export function planFor(o: StressOptions): StressPlan {
  return { ...STANDARD_PLAN, load: o.minutes >= 30 ? 1740 : o.minutes >= 10 ? 540 : 120 };
}

export interface StressReport {
  completed: boolean;
  elevated: boolean;
  threads: number;
  rounds: number;
  points: Point[];
  checks: Check[];
  tempSource: "sensor" | "acpi" | null;
  cooling: CoolingProfile | null;
  history: CoolingProfile[];
  options: StressOptions;
  plan: StressPlan;
  ram: { bytes: number; passes: number; errors: number } | null;
  gpu: { name: string; vramBytes: number; rounds: number; computeErrors: number; vramErrors: number; lost: boolean; problem: string | null } | null;
}

/** Five minutes of one-per-second readings. */
export const HISTORY = 300;

interface MonitorState {
  status: { sensors: SensorStatus; elevated: boolean } | null;
  frame: Frame | null;
  /** Sensor id → recent values, oldest first. */
  history: Record<string, number[]>;
  tab: "sensors" | "stability" | "history";
  quick: QuickReport | null;
  quickLoading: boolean;
  stress: { running: boolean; total: number; points: Point[]; report: StressReport | null; error: string | null; options: StressOptions; plan: StressPlan };
  /** What the next stress test will cover. */
  stressOptions: StressOptions;
  gpus: GpuInfo[];
  /** Kept cooling profiles, oldest first. */
  cooling: CoolingProfile[];
}

export const useMonitor = create<MonitorState>(() => ({
  status: null,
  frame: null,
  history: {},
  tab: "sensors",
  quick: null,
  quickLoading: false,
  stress: { running: false, total: 180, points: [], report: null, error: null, options: savedOptions(), plan: STANDARD_PLAN },
  stressOptions: savedOptions(),
  gpus: [],
  cooling: [],
}));

/** History key of the firmware's hottest thermal zone, charted when the CPU's own sensor is unreadable. */
export const ACPI_TEMP = "acpi:cpu";

/** Only these are charted, so only these are kept. */
const KEPT = new Set(["Temperature", "Fan", "Load", "Power", "Clock"]);

function remember(history: Record<string, number[]>, frame: Frame) {
  const next = { ...history };
  for (const hw of frame.hardware) {
    for (const s of hw.sensors) {
      if (!KEPT.has(s.type)) continue;
      const series = next[s.id] ? [...next[s.id], s.value] : [s.value];
      next[s.id] = series.length > HISTORY ? series.slice(-HISTORY) : series;
    }
  }
  const zone = frame.throttle?.tempSource === "acpi" ? frame.throttle.temp : null;
  if (zone !== null && zone !== undefined) {
    const series = [...(next[ACPI_TEMP] ?? []), zone];
    next[ACPI_TEMP] = series.length > HISTORY ? series.slice(-HISTORY) : series;
  }
  return next;
}

let started = false;

export async function startMonitor() {
  if (started) return;
  started = true;
  listen<Frame>("sensors", ({ payload }) => {
    useMonitor.setState((s) => ({ frame: payload, history: remember(s.history, payload) }));
  }).catch((e) => console.error("sensors listener failed", e));
  listen<{ point: Point; total: number; plan?: StressPlan }>("stability:progress", ({ payload }) => {
    useMonitor.setState((s) => ({ stress: { ...s.stress, total: payload.total, plan: payload.plan ?? s.stress.plan, points: [...s.stress.points, payload.point] } }));
  }).catch((e) => console.error("stability listener failed", e));
  try {
    // Fill the charts with what was recorded before this page was opened.
    const frames = await invoke<Frame[]>("monitor_history", { seconds: HISTORY });
    let history: Record<string, number[]> = {};
    for (const frame of frames) history = remember(history, frame);
    useMonitor.setState((s) => ({ history: Object.keys(s.history).length ? s.history : history, frame: s.frame ?? frames[frames.length - 1] ?? null }));
  } catch (e) {
    console.error("monitor_history failed", e);
  }
}

export async function loadStatus() {
  try {
    useMonitor.setState({ status: await invoke("monitor_status") });
  } catch (e) {
    console.error("monitor_status failed", e);
  }
}

export async function runQuick() {
  if (useMonitor.getState().quickLoading) return;
  useMonitor.setState({ quickLoading: true });
  try {
    useMonitor.setState({ quick: await invoke<QuickReport>("health_quick") });
  } catch (e) {
    console.error("health_quick failed", e);
  }
  useMonitor.setState({ quickLoading: false });
}

export async function loadGpus() {
  try {
    const gpus = await invoke<GpuInfo[]>("gpu_adapters");
    useMonitor.setState((s) => ({ gpus, stressOptions: s.stressOptions.gpu !== null && !gpus.some((g) => g.index === s.stressOptions.gpu) ? { ...s.stressOptions, gpu: gpus[0]?.index ?? null } : s.stressOptions }));
  } catch (e) {
    console.error("gpu_adapters failed", e);
  }
}

export async function runStress() {
  const { stress, stressOptions: options } = useMonitor.getState();
  if (stress.running) return;
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(options));
  } catch {
    /* ignore */
  }
  const plan = planFor(options);
  useMonitor.setState({ stress: { running: true, total: plan.idle + plan.load + plan.cool, points: [], report: null, error: null, options, plan } });
  try {
    const report = await invoke<StressReport>("stability_run", { options });
    useMonitor.setState((s) => ({ stress: { ...s.stress, running: false, report }, cooling: report.history.length ? report.history : s.cooling }));
  } catch (e) {
    useMonitor.setState((s) => ({ stress: { ...s.stress, running: false, error: String(e) } }));
  }
}

export async function loadCooling() {
  try {
    useMonitor.setState({ cooling: await invoke<CoolingProfile[]>("cooling_history") });
  } catch (e) {
    console.error("cooling_history failed", e);
  }
}

export const cancelStress = () => invoke("stability_cancel").catch(console.error);

/** Helpers for picking readings out of a frame. */
export function find(hw: Hardware | undefined, type: string, ...names: string[]): Sensor | undefined {
  if (!hw) return undefined;
  for (const name of names) {
    const hit = hw.sensors.find((s) => s.type === type && s.name === name);
    if (hit) return hit;
  }
  return hw.sensors.find((s) => s.type === type && names.some((n) => s.name.includes(n)));
}

export const isGpu = (hw: Hardware) => hw.type.startsWith("Gpu");
