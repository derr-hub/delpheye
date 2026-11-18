import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type Confidence = "high" | "medium" | "low";

export interface FolderReport {
  path: string;
  bytes: number;
  files: number;
  /** Unix seconds of the latest change inside. */
  lastUsed: number;
  hasPrograms: boolean;
  hasSaves: boolean;
  needsAdmin: boolean;
  confidence: Confidence;
}

export interface Leftover {
  id: number;
  name: string;
  /** "folders": leftover folders and their settings keys. "entry": an Apps & features entry with no program. */
  kind: "folders" | "entry";
  confidence: Confidence;
  bytes: number;
  files: number;
  lastUsed: number;
  hasPrograms: boolean;
  hasSaves: boolean;
  needsAdmin: boolean;
  folders: FolderReport[];
  keys: { path: string; needsAdmin: boolean }[];
}

export interface ScanReport {
  scanId: number;
  elevated: boolean;
  sandbox: boolean;
  durationMs: number;
  installed: number;
  checked: number;
  items: Leftover[];
}

export interface Failure {
  path: string;
  reason: string;
}

export interface HoldReport {
  held: number;
  heldBytes: number;
  failed: Failure[];
}

export interface Held {
  id: number;
  at: number;
  /** When it will be deleted for good, unix seconds. */
  expires: number;
  name: string;
  kind: "folder" | "registry";
  original: string;
  bytes: number;
  admin: boolean;
}

export interface ActResult {
  done: number;
  bytes: number;
  failed: Failure[];
}

export const CONFIDENCES: Confidence[] = ["high", "medium", "low"];

interface LeftoversState {
  phase: "idle" | "scanning" | "report" | "holding";
  tab: "found" | "quarantine";
  progress: { done: number; total: number; path: string } | null;
  report: ScanReport | null;
  selected: Set<number>;
  held: Held[];
  /** The last action's outcome, shown above the list until dismissed. */
  notice: { kind: "held" | "restored" | "purged"; count: number; bytes: number; failed: Failure[] } | null;
  error: string | null;
}

export const useLeftovers = create<LeftoversState>(() => ({
  phase: "idle",
  tab: "found",
  progress: null,
  report: null,
  selected: new Set(),
  held: [],
  notice: null,
  error: null,
}));

export const isSelectable = (report: ScanReport, item: Leftover) => !item.needsAdmin || report.elevated;

export async function loadHeld() {
  try {
    useLeftovers.setState({ held: await invoke<Held[]>("quarantine_list") });
  } catch (e) {
    console.error("quarantine_list failed", e);
  }
}

/** Looks for leftovers. Changes nothing. */
export async function scan() {
  const before = useLeftovers.getState();
  if (before.phase === "scanning" || before.phase === "holding") return;
  useLeftovers.setState({ phase: "scanning", progress: null, error: null, tab: "found" });
  try {
    const report = await invoke<ScanReport>("leftovers_scan");
    // Only the leftovers we are most sure of start ticked; the rest is the user's call.
    const selected = new Set(report.items.filter((i) => i.confidence === "high" && isSelectable(report, i)).map((i) => i.id));
    useLeftovers.setState({ phase: "report", report, selected, progress: null });
  } catch (e) {
    const code = String(e);
    useLeftovers.setState({ phase: before.report ? "report" : "idle", progress: null, error: code === "cancelled" ? null : code });
  }
}

export const cancelScan = () => invoke("leftovers_cancel").catch(console.error);

export function toggle(id: number) {
  const selected = new Set(useLeftovers.getState().selected);
  if (!selected.delete(id)) selected.add(id);
  useLeftovers.setState({ selected });
}

/** Ticks every selectable item of one confidence level, or clears them if all were ticked. */
export function toggleLevel(report: ScanReport, level: Confidence) {
  const selected = new Set(useLeftovers.getState().selected);
  const ids = report.items.filter((i) => i.confidence === level && isSelectable(report, i)).map((i) => i.id);
  const allOn = ids.every((id) => selected.has(id));
  for (const id of ids) allOn ? selected.delete(id) : selected.add(id);
  useLeftovers.setState({ selected });
}

/** Moves the ticked leftovers into quarantine, then rescans so the list reflects the disk. */
export async function quarantineSelected() {
  const { report, selected, phase } = useLeftovers.getState();
  if (!report || phase !== "report" || selected.size === 0) return;
  useLeftovers.setState({ phase: "holding", error: null });
  try {
    const result = await invoke<HoldReport>("leftovers_quarantine", { scanId: report.scanId, ids: [...selected] });
    useLeftovers.setState({ phase: "idle", report: null, selected: new Set(), notice: { kind: "held", count: result.held, bytes: result.heldBytes, failed: result.failed } });
    await loadHeld();
    await scan();
  } catch (e) {
    useLeftovers.setState({ phase: "idle", report: null, selected: new Set(), error: String(e) });
  }
}

/** Puts entries back (`restore`) or deletes them for good. */
export async function actOnHeld(ids: number[], restore: boolean) {
  try {
    const result = await invoke<ActResult>("quarantine_act", { ids, restore });
    useLeftovers.setState({ notice: { kind: restore ? "restored" : "purged", count: result.done, bytes: result.bytes, failed: result.failed } });
  } catch (e) {
    useLeftovers.setState({ error: String(e) });
  }
  await loadHeld();
}

let listening = false;

export function startLeftoversEvents() {
  if (listening) return;
  listening = true;
  listen<{ done: number; total: number; path: string }>("leftovers:progress", ({ payload }) => {
    if (useLeftovers.getState().phase === "scanning") useLeftovers.setState({ progress: payload });
  }).catch((e) => console.error("leftovers listener failed", e));
}
