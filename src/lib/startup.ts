import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Kind = "run" | "folder" | "task" | "service";
export type StartType = "auto" | "delayed" | "manual" | "disabled";
export type Advice = "keep" | "optional" | "disable" | "review" | "broken";
export type Impact = "none" | "low" | "medium" | "high";
export type Category = "windows" | "security" | "hardware" | "launcher" | "updater" | "messenger" | "cloud" | "browser" | "media" | "other";

export interface Entry {
  id: string;
  kind: Kind;
  name: string;
  command: string;
  program: string | null;
  location: string;
  machine: boolean;
  enabled: boolean;
  start: StartType | null;
  running: boolean;
  publisher: string | null;
  description: string | null;
  signed: boolean | null;
  exists: boolean;
  category: Category;
  advice: Advice;
  reasons: string[];
  needsAdmin: boolean;
  /** Part of Windows or Microsoft's system software. */
  windows: boolean;
  editable: boolean;
  removable: boolean;
  footprint: { processes: number; memory: number; cpuSeconds: number; readBytes: number };
  impact: Impact;
  bootDelayMs: number | null;
  changed: { original: string; at: number } | null;
}

export interface Boot {
  at: string;
  totalMs: number;
  mainMs: number;
  postMs: number;
}

export interface Report {
  elevated: boolean;
  entries: Entry[];
  boots: Boot[];
  /** Dead entries DelphEye removed; each can be put back. */
  removed: { id: string; name: string; at: number }[];
  durationMs: number;
}

export type Tab = "apps" | "tasks" | "services";
export type Filter = "all" | "disable" | "review" | "changed";

interface StartupState {
  loading: boolean;
  report: Report | null;
  tab: Tab;
  filter: Filter;
  query: string;
  showWindows: boolean;
  /** Ids with a change on its way to Windows, so their controls wait. */
  busy: Set<string>;
  error: { id: string | null; code: string } | null;
}

export const useStartup = create<StartupState>(() => ({
  loading: false,
  report: null,
  tab: "apps",
  filter: "all",
  query: "",
  showWindows: false,
  busy: new Set(),
  error: null,
}));

export const tabOf = (entry: Entry): Tab => (entry.kind === "service" ? "services" : entry.kind === "task" ? "tasks" : "apps");

/** Shown by default: everything in Programs, and the tasks and services that are not Windows' own. */
export function isListed(entry: Entry, showWindows: boolean): boolean {
  if (entry.kind === "run" || entry.kind === "folder") return true;
  if (entry.windows && !showWindows) return false;
  // A service that does not start with Windows is not autostart, unless DelphEye changed it.
  return entry.kind !== "service" || entry.enabled || entry.changed !== null;
}

/** A program counts as starting with Windows when it is on (for services: automatic). */
export const isOn = (entry: Entry) => entry.enabled;

export async function load() {
  if (useStartup.getState().loading) return;
  useStartup.setState({ loading: true, error: null });
  try {
    useStartup.setState({ report: await invoke<Report>("startup_list"), loading: false });
  } catch (e) {
    useStartup.setState({ loading: false, error: { id: null, code: String(e) } });
  }
}

function replace(entry: Entry) {
  const { report } = useStartup.getState();
  if (!report) return;
  useStartup.setState({ report: { ...report, entries: report.entries.map((e) => (e.id === entry.id ? entry : e)) } });
}

function markBusy(id: string, on: boolean) {
  const busy = new Set(useStartup.getState().busy);
  if (on) busy.add(id);
  else busy.delete(id);
  useStartup.setState({ busy });
}

/** "on" / "off" for programs and tasks, a start type for services. */
export async function setState(id: string, target: string) {
  markBusy(id, true);
  useStartup.setState({ error: null });
  try {
    replace(await invoke<Entry>("startup_set", { id, target }));
  } catch (e) {
    useStartup.setState({ error: { id, code: String(e) } });
  }
  markBusy(id, false);
}

export async function removeBroken(id: string) {
  markBusy(id, true);
  try {
    await invoke("startup_remove", { id });
    const { report } = useStartup.getState();
    const entry = report?.entries.find((e) => e.id === id);
    if (report && entry) {
      useStartup.setState({
        report: {
          ...report,
          entries: report.entries.filter((e) => e.id !== id),
          removed: [{ id, name: entry.name, at: Date.now() / 1000 }, ...report.removed],
        },
      });
    }
  } catch (e) {
    useStartup.setState({ error: { id, code: String(e) } });
  }
  markBusy(id, false);
}

/** Undoes DelphEye's changes to the given entries, or to all when `ids` is empty, then re-reads. */
export async function revert(ids: string[]) {
  try {
    const result = await invoke<{ reverted: number; failed: string[] }>("startup_revert", { ids });
    if (result.failed.length) useStartup.setState({ error: { id: null, code: `revert:${result.failed.join(", ")}` } });
  } catch (e) {
    useStartup.setState({ error: { id: null, code: String(e) } });
  }
  await load();
}

/** Switches off every program the advice says can go, skipping what needs rights we lack. */
export async function disableRecommended(entries: Entry[]) {
  for (const entry of entries) await setState(entry.id, entry.kind === "service" ? "manual" : "off");
}

/** Entries the "switch off what is recommended" button would touch. */
export function recommended(report: Report): Entry[] {
  return report.entries.filter(
    (e) => e.advice === "disable" && e.editable && e.enabled && (!e.needsAdmin || report.elevated) && e.kind !== "service",
  );
}
