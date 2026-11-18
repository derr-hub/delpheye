import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { clamp } from "./format";

export interface SystemInfo {
  osName: string;
  osVersion: string;
  hostName: string;
  cpuBrand: string;
  physicalCores: number;
  logicalCores: number;
  totalMemory: number;
}

export interface DiskInfo {
  name: string;
  mount: string;
  fileSystem: string;
  kind: string;
  total: number;
  available: number;
  removable: boolean;
}

export interface ProcessInfo {
  /** How many processes share this name. */
  count: number;
  name: string;
  cpu: number;
  memory: number;
}

export interface Snapshot {
  cpuUsage: number;
  cpuFrequency: number;
  perCore: number[];
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  disks: DiskInfo[];
  uptime: number;
  processCount: number;
  netRx: number;
  netTx: number;
  topProcesses: ProcessInfo[];
}

const HISTORY = 60;

interface MetricsState {
  info: SystemInfo | null;
  current: Snapshot | null;
  history: { cpu: number[]; mem: number[]; rx: number[]; tx: number[] };
}

const push = (arr: number[], v: number) => [...arr, v].slice(-HISTORY);

export const useMetrics = create<MetricsState>(() => ({
  info: null,
  current: null,
  history: { cpu: [], mem: [], rx: [], tx: [] },
}));

let started = false;

/** Subscribe to the Rust metrics stream. Safe to call more than once. */
export function startMetrics() {
  if (started) return;
  started = true;
  invoke<SystemInfo>("system_info")
    .then((info) => useMetrics.setState({ info }))
    .catch((e) => console.error("system_info failed", e));
  listen<Snapshot>("metrics", ({ payload }) => {
    useMetrics.setState((s) => ({
      current: payload,
      history: {
        cpu: push(s.history.cpu, payload.cpuUsage),
        mem: push(s.history.mem, (payload.memUsed / Math.max(payload.memTotal, 1)) * 100),
        rx: push(s.history.rx, payload.netRx),
        tx: push(s.history.tx, payload.netTx),
      },
    }));
  }).catch((e) => console.error("metrics listener failed", e));
}

export type HealthLevel = "good" | "warn" | "bad";

/** One thing that is pulling the score down. */
export interface HealthIssue {
  kind: "disk" | "memory" | "cpu";
  /** Percent full / in use / loaded. */
  value: number;
  mount?: string;
}

/**
 * 0–100 score. Starts at 100 and loses points for sustained CPU load,
 * high memory pressure and fixed disks that are nearly full.
 */
export function healthScore(
  s: Snapshot,
  cpuHistory: number[],
): { score: number; level: HealthLevel; issues: HealthIssue[] } {
  const cpuAvg = cpuHistory.length
    ? cpuHistory.reduce((a, b) => a + b, 0) / cpuHistory.length
    : s.cpuUsage;
  const memPct = (s.memUsed / Math.max(s.memTotal, 1)) * 100;

  const issues: HealthIssue[] = [];
  let score = 100;
  for (const d of s.disks) {
    if (d.removable || d.total === 0) continue;
    const freePct = (d.available / d.total) * 100;
    if (freePct < 15) {
      score -= (15 - freePct) * 2;
      issues.push({ kind: "disk", value: Math.round(100 - freePct), mount: d.mount.replace(/\\$/, "") });
    }
  }
  if (memPct > 70) {
    score -= (memPct - 70) * 1.2;
    issues.push({ kind: "memory", value: Math.round(memPct) });
  }
  if (cpuAvg > 60) {
    score -= (cpuAvg - 60) * 0.6;
    issues.push({ kind: "cpu", value: Math.round(cpuAvg) });
  }
  score = Math.round(clamp(score, 0, 100));
  return { score, level: score >= 80 ? "good" : score >= 55 ? "warn" : "bad", issues };
}
