import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { go, useApp } from "./app";
import { useMetrics, type Snapshot, type SystemInfo } from "./metrics";
import { useMonitor, type CoolingProfile, type QuickReport, type Throttle } from "./monitor";
import type { Adapter, Listener, NetApp, Wifi } from "./network";
import type { Proc } from "./processes";
import type { ScanReport } from "./security";
import type { Boot, Entry } from "./startup";

/** Everything a helper needs to see a relative's computer, in one file. */
export interface HelpReport {
  kind: "delpheye-report";
  format: 1;
  /** Unix milliseconds. */
  created: number;
  version: string;
  elevated: boolean;
  /** What is bothering the person, in their own words. */
  note: string;
  system: SystemInfo | null;
  snapshot: Snapshot | null;
  throttle: Throttle | null;
  quick: QuickReport | null;
  security: ScanReport | null;
  startup: { entries: Entry[]; boots: Boot[]; total: number } | null;
  network: { adapters: Adapter[]; wifi: Wifi[]; apps: NetApp[]; listeners: Listener[] } | null;
  processes: { name: string; description: string | null; company: string | null; count: number; cpu: number; memory: number }[] | null;
  cooling: CoolingProfile[];
}

export type Step = "crashes" | "security" | "startup" | "network" | "processes" | "saving";

interface State {
  building: boolean;
  step: Step | null;
  saved: string | null;
  error: string | null;
  /** The report being viewed, and where it came from. */
  viewing: HelpReport | null;
  viewingFile: string | null;
}

export const useReport = create<State>(() => ({ building: false, step: null, saved: null, error: null, viewing: null, viewingFile: null }));

async function attempt<T>(step: Step, work: () => Promise<T>): Promise<T | null> {
  useReport.setState({ step });
  try {
    return await work();
  } catch (e) {
    console.error(`report ${step} failed`, e);
    return null;
  }
}

/** Programs grouped by their file, heaviest first. */
function groupProcesses(rows: Proc[]) {
  const groups = new Map<string, { name: string; description: string | null; company: string | null; count: number; cpu: number; memory: number }>();
  for (const p of rows) {
    if (p.level === "own") continue;
    const id = (p.exe ?? p.name).toLowerCase();
    const g = groups.get(id) ?? { name: p.name, description: p.description, company: p.company, count: 0, cpu: 0, memory: 0 };
    g.count += 1;
    g.cpu += p.cpu;
    g.memory += p.memory;
    groups.set(id, g);
  }
  return [...groups.values()].sort((a, b) => b.memory - a.memory).slice(0, 15);
}

const today = () => new Date().toISOString().slice(0, 10);

/** Gathers every check, then asks where to save the file. Changes nothing on the computer. */
export async function buildReport(note: string) {
  if (useReport.getState().building) return;
  useReport.setState({ building: true, step: null, saved: null, error: null });
  const metrics = useMetrics.getState();
  const monitor = useMonitor.getState();

  const quick = await attempt("crashes", () => invoke<QuickReport>("health_quick"));
  const security = await attempt("security", () => invoke<ScanReport>("security_scan"));
  const startup = await attempt("startup", async () => {
    const r = await invoke<{ entries: Entry[]; boots: Boot[] }>("startup_list");
    // The person's own programs, heaviest first; Windows' parts say little to a helper.
    const own = r.entries.filter((e) => !e.windows && (e.enabled || e.start === "auto"));
    return { entries: own.slice(0, 40), boots: r.boots.slice(0, 10), total: own.length };
  });
  const network = await attempt("network", async () => {
    const s = await invoke<{ adapters: Adapter[]; wifi: Wifi[]; apps: NetApp[]; listeners: Listener[] }>("network_snapshot");
    return { adapters: s.adapters.filter((a) => a.up), wifi: s.wifi, apps: s.apps.slice(0, 25), listeners: s.listeners.filter((l) => l.exposed) };
  });
  const processes = await attempt("processes", async () => groupProcesses((await invoke<{ rows: Proc[] }>("processes_list")).rows));
  const cooling = (await attempt("processes", () => invoke<CoolingProfile[]>("cooling_history"))) ?? [];

  const report: HelpReport = {
    kind: "delpheye-report",
    format: 1,
    created: Date.now(),
    version: useApp.getState().status?.version ?? "",
    elevated: useApp.getState().status?.elevated ?? false,
    note: note.trim(),
    system: metrics.info,
    snapshot: metrics.current,
    throttle: monitor.frame?.throttle ?? null,
    quick,
    security,
    startup,
    network,
    processes,
    cooling,
  };

  useReport.setState({ step: "saving" });
  try {
    const host = (metrics.info?.hostName || "PC").replace(/[^\p{L}\p{N}_-]+/gu, "-");
    // Development builds can be handed a path so the flow can be tested without the native dialog.
    const testPath = import.meta.env.DEV ? (window as unknown as { __delpheyeReportPath?: string }).__delpheyeReportPath : undefined;
    const path = testPath ?? (await save({ defaultPath: `DelphEye-${host}-${today()}.delpheye`, filters: [{ name: "DelphEye", extensions: ["delpheye"] }] }));
    if (!path) {
      useReport.setState({ building: false, step: null });
      return;
    }
    await invoke("report_write", { path, contents: JSON.stringify(report) });
    useReport.setState({ building: false, step: null, saved: path });
  } catch (e) {
    useReport.setState({ building: false, step: null, error: String(e) });
  }
}

export const revealSaved = () => {
  const path = useReport.getState().saved;
  if (path) revealItemInDir(path).catch(console.error);
};

/** Opens a report someone sent and shows it. */
export async function openReport() {
  try {
    const testPath = import.meta.env.DEV ? (window as unknown as { __delpheyeReportPath?: string }).__delpheyeReportPath : undefined;
    const path = testPath ?? (await open({ multiple: false, directory: false, filters: [{ name: "DelphEye", extensions: ["delpheye"] }] }));
    if (!path || Array.isArray(path)) return;
    const data = JSON.parse(await invoke<string>("report_read", { path })) as HelpReport;
    if (data?.kind !== "delpheye-report") throw new Error("not-a-report");
    useReport.setState({ viewing: data, viewingFile: path, error: null });
    go("report");
  } catch (e) {
    useReport.setState({ error: String(e) });
  }
}
