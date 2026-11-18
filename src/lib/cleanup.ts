import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Risk = "safe" | "caution";
export type Group = "system" | "browsers" | "apps" | "dev";
export const GROUPS: Group[] = ["system", "browsers", "apps", "dev"];

export interface LargeFile {
  path: string;
  bytes: number;
}

export interface TargetReport {
  id: string;
  label: string;
  /** Set when the label is a phrase to translate rather than a proper name. */
  labelKey: string | null;
  bytes: number;
  files: number;
  needsAdmin: boolean;
  blocked: boolean;
  paths: string[];
  largest: LargeFile[];
}

export interface CategoryReport {
  id: string;
  /** A product name; categories without one are named from `id`. */
  title: string | null;
  group: Group;
  risk: Risk;
  bytes: number;
  files: number;
  running: string | null;
  minAgeHours: number | null;
  targets: TargetReport[];
}

export interface ScanReport {
  scanId: number;
  elevated: boolean;
  sandbox: boolean;
  durationMs: number;
  categories: CategoryReport[];
}

export interface Progress {
  phase: "scan" | "clean";
  done: number;
  total: number;
  bytes: number;
  files: number;
  path: string | null;
}

export interface CategoryResult {
  id: string;
  title: string | null;
  freedBytes: number;
  deletedFiles: number;
  skippedFiles: number;
}

export interface CleanReport {
  freedBytes: number;
  deletedFiles: number;
  inUse: number;
  denied: number;
  failed: number;
  durationMs: number;
  cancelled: boolean;
  sandbox: boolean;
  categories: CategoryResult[];
  journalId: number | null;
}

type Phase = "idle" | "scanning" | "report" | "cleaning" | "done";

interface CleanupState {
  phase: Phase;
  progress: Progress | null;
  report: ScanReport | null;
  /** Keys of the ticked targets, see `targetKey`. */
  selected: Set<string>;
  result: CleanReport | null;
  /** Error code from the backend: "busy", "stale", "environment" or a raw message. */
  error: string | null;
}

export const useCleanup = create<CleanupState>(() => ({
  phase: "idle",
  progress: null,
  report: null,
  selected: new Set(),
  result: null,
  error: null,
}));

export const targetKey = (category: string, target: string) => `${category}/${target}`;

/** A target can be ticked if it holds something and this run is allowed to delete it. */
export const isSelectable = (report: ScanReport, target: TargetReport) =>
  target.bytes > 0 && (!target.needsAdmin || report.elevated);

/** Worth showing: it holds something, or we could not look inside. */
export const isVisible = (category: CategoryReport) =>
  category.bytes > 0 || category.targets.some((t) => t.blocked);

export function selectedBytes(report: ScanReport, selected: Set<string>): number {
  let sum = 0;
  for (const c of report.categories)
    for (const t of c.targets) if (selected.has(targetKey(c.id, t.id))) sum += t.bytes;
  return sum;
}

/** Scans for removable files. Nothing is deleted. */
export async function scan() {
  const before = useCleanup.getState();
  if (before.phase === "scanning" || before.phase === "cleaning") return;
  useCleanup.setState({ phase: "scanning", progress: null, error: null, result: null });
  try {
    const report = await invoke<ScanReport>("cleanup_scan");
    // Start with only the risk-free categories ticked; the rest is the user's call.
    const selected = new Set<string>();
    for (const c of report.categories)
      if (c.risk === "safe")
        for (const t of c.targets) if (isSelectable(report, t)) selected.add(targetKey(c.id, t.id));
    useCleanup.setState({ phase: "report", report, selected, progress: null });
  } catch (e) {
    // A cancelled scan leaves the previous report, if any, exactly as it was.
    const code = String(e);
    useCleanup.setState({
      phase: before.report ? "report" : "idle",
      progress: null,
      error: code === "cancelled" ? null : code,
    });
  }
}

export function cancel() {
  invoke("cleanup_cancel").catch(console.error);
}

/** Deletes the ticked targets of the current report. */
export async function clean() {
  const { report, selected, phase } = useCleanup.getState();
  if (!report || phase !== "report" || selected.size === 0) return;
  const selection = report.categories
    .map((c) => ({
      category: c.id,
      targets: c.targets.filter((t) => selected.has(targetKey(c.id, t.id))).map((t) => t.id),
    }))
    .filter((s) => s.targets.length > 0);

  useCleanup.setState({ phase: "cleaning", progress: null, error: null });
  try {
    const result = await invoke<CleanReport>("cleanup_run", { scanId: report.scanId, selection });
    useCleanup.setState({ phase: "done", result, report: null, selected: new Set(), progress: null });
  } catch (e) {
    useCleanup.setState({ phase: "idle", report: null, selected: new Set(), progress: null, error: String(e) });
  }
}

export function toggleTarget(category: string, target: string) {
  const selected = new Set(useCleanup.getState().selected);
  const key = targetKey(category, target);
  if (!selected.delete(key)) selected.add(key);
  useCleanup.setState({ selected });
}

/** Ticks every selectable target of the category, or clears them if all were ticked. */
export function toggleCategory(report: ScanReport, category: CategoryReport) {
  const selected = new Set(useCleanup.getState().selected);
  const keys = category.targets.filter((t) => isSelectable(report, t)).map((t) => targetKey(category.id, t.id));
  const allOn = keys.every((k) => selected.has(k));
  for (const k of keys) allOn ? selected.delete(k) : selected.add(k);
  useCleanup.setState({ selected });
}

let listening = false;

/** Subscribes to backend progress events. Safe to call more than once. */
export function startCleanupEvents() {
  if (listening) return;
  listening = true;
  listen<Progress>("cleanup:progress", ({ payload }) => {
    const { phase, progress } = useCleanup.getState();
    const relevant =
      (payload.phase === "scan" && phase === "scanning") || (payload.phase === "clean" && phase === "cleaning");
    // Most updates carry no path; keep showing the last folder that was named.
    if (relevant) useCleanup.setState({ progress: { ...payload, path: payload.path ?? progress?.path ?? null } });
  }).catch((e) => console.error("cleanup listener failed", e));
}
