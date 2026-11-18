import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Level = "critical" | "windows" | "app" | "own";
export type Kind = "app" | "service" | "background";

export interface Proc {
  pid: number;
  parent: number | null;
  start: number;
  name: string;
  exe: string | null;
  description: string | null;
  company: string | null;
  cpu: number;
  memory: number;
  /** Bytes read and written per second. */
  disk: number;
  window: string | null;
  kind: Kind;
  level: Level;
  known: string | null;
  category: string;
  impostor: boolean;
  services: string[];
  connections: number;
  listening: number;
}

export interface Listing {
  rows: Proc[];
  ownPid: number;
  elevated: boolean;
}

export interface Details {
  cmd: string;
  signed: boolean | null;
  connections: { local: string; remote: string; state: "listen" | "established" | "other" }[];
}

export type SortKey = "name" | "cpu" | "memory" | "disk" | "net";
export type Filter = "all" | "apps" | "background" | "windows";

/** A process is the same one only while both its id and its start time match. */
export const keyOf = (p: { pid: number; start: number }) => `${p.pid}:${p.start}`;

const SPARK = 40;

interface State {
  listing: Listing | null;
  error: string | null;
  view: "tree" | "list";
  filter: Filter;
  query: string;
  sort: { key: SortKey; desc: boolean };
  /** Tree nodes the user opened or closed, by key; others follow the default. */
  toggled: Record<string, boolean>;
  selected: string | null;
  icons: Record<string, string | null>;
  /** Recent CPU and memory per process, oldest first. */
  spark: Record<string, { cpu: number[]; memory: number[] }>;
  details: Record<string, Details>;
  ending: string | null;
  endResult: { key: string; ok: boolean; message: string } | null;
}

export const useProcesses = create<State>(() => ({
  listing: null,
  error: null,
  view: "tree",
  filter: "all",
  query: "",
  sort: { key: "memory", desc: true },
  toggled: {},
  selected: null,
  icons: {},
  spark: {},
  details: {},
  ending: null,
  endResult: null,
}));

const pendingIcons = new Set<string>();

async function loadIcons(rows: Proc[]) {
  return ensureIcons(rows.map((r) => r.exe));
}

/** Fetches the icons of these program files that are not known yet. */
export async function ensureIcons(paths: (string | null)[]) {
  const { icons } = useProcesses.getState();
  const wanted = [...new Set(paths.filter((e): e is string => !!e && !(e in icons) && !pendingIcons.has(e)))];
  if (!wanted.length) return;
  wanted.forEach((p) => pendingIcons.add(p));
  try {
    const found = await invoke<Record<string, string | null>>("process_icons", { paths: wanted });
    useProcesses.setState((s) => ({ icons: { ...s.icons, ...found } }));
  } catch (e) {
    console.error("process_icons failed", e);
  } finally {
    wanted.forEach((p) => pendingIcons.delete(p));
  }
}

export async function refresh() {
  try {
    const listing = await invoke<Listing>("processes_list");
    useProcesses.setState((s) => {
      const spark: State["spark"] = {};
      for (const r of listing.rows) {
        const k = keyOf(r);
        const old = s.spark[k];
        spark[k] = { cpu: [...(old?.cpu ?? []), r.cpu].slice(-SPARK), memory: [...(old?.memory ?? []), r.memory].slice(-SPARK) };
      }
      return { listing, spark, error: null };
    });
    loadIcons(listing.rows);
  } catch (e) {
    useProcesses.setState({ error: String(e) });
  }
}

/** Polls while the page is open; returns the function that stops it. */
export function startPolling(): () => void {
  refresh();
  const timer = window.setInterval(refresh, 1500);
  return () => window.clearInterval(timer);
}

export async function loadDetails(p: Proc) {
  try {
    const details = await invoke<Details>("process_details", { pid: p.pid, start: p.start });
    useProcesses.setState((s) => ({ details: { ...s.details, [keyOf(p)]: details } }));
  } catch (e) {
    console.error("process_details failed", e);
  }
}

export async function endProcess(p: Proc, tree: boolean): Promise<void> {
  const key = keyOf(p);
  useProcesses.setState({ ending: key, endResult: null });
  try {
    const result = await invoke<{ ended: number; failed: { name: string; reason: string }[] }>("process_end", { pid: p.pid, start: p.start, tree });
    const ok = result.ended > 0;
    useProcesses.setState({
      endResult: { key, ok, message: ok ? `ended:${result.ended}:${result.failed.length}` : `failed:${result.failed[0]?.reason ?? "failed"}` },
      selected: ok && !tree ? null : useProcesses.getState().selected,
    });
    if (ok && tree) useProcesses.setState({ selected: null });
  } catch (e) {
    useProcesses.setState({ endResult: { key, ok: false, message: `failed:${String(e)}` } });
  }
  useProcesses.setState({ ending: null });
  refresh();
}

export interface Node {
  proc: Proc;
  children: Node[];
  depth: number;
  /** This process and everything below it. */
  total: { cpu: number; memory: number; disk: number; net: number; count: number };
}

/** Builds the process tree; roots are processes whose parent is gone. */
export function buildTree(rows: Proc[]): Node[] {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const children = new Map<number, Proc[]>();
  const roots: Proc[] = [];
  for (const r of rows) {
    if (r.parent !== null && byPid.has(r.parent)) {
      const list = children.get(r.parent) ?? [];
      list.push(r);
      children.set(r.parent, list);
    } else roots.push(r);
  }
  const make = (proc: Proc, depth: number, seen: Set<number>): Node => {
    seen.add(proc.pid);
    const kids = (children.get(proc.pid) ?? []).filter((c) => !seen.has(c.pid)).map((c) => make(c, depth + 1, seen));
    const total = { cpu: proc.cpu, memory: proc.memory, disk: proc.disk, net: proc.connections, count: 1 };
    for (const k of kids) {
      total.cpu += k.total.cpu;
      total.memory += k.total.memory;
      total.disk += k.total.disk;
      total.net += k.total.net;
      total.count += k.total.count;
    }
    return { proc, children: kids, depth, total };
  };
  const seen = new Set<number>();
  return roots.map((r) => make(r, 0, seen));
}

export function matches(p: Proc, filter: Filter, query: string): boolean {
  if (filter === "apps" && p.kind !== "app") return false;
  if (filter === "background" && (p.kind === "app" || p.level === "windows" || p.level === "critical")) return false;
  if (filter === "windows" && p.level !== "windows" && p.level !== "critical") return false;
  if (!query) return true;
  const q = query.toLowerCase();
  return [p.name, p.description, p.window, p.company, String(p.pid), ...p.services].some((v) => v?.toLowerCase().includes(q));
}
