import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface Drive {
  mount: string;
  name: string;
  fileSystem: string;
  total: number;
  available: number;
  removable: boolean;
}

export interface Item {
  id: number;
  name: string;
  path: string;
  isDir: boolean;
  /** A file's own size, or everything inside for a folder. */
  size: number;
  files: number;
  /** Unix seconds; 0 when unknown. */
  modified: number;
  /** How old the data is: a file's own time, or a folder's size-weighted average. */
  mark: number;
}

/** A folder and its contents a few levels down, for the time-layers chart. */
export interface Ring {
  id: number;
  name: string;
  size: number;
  isDir: boolean;
  mark: number;
  children: Ring[];
  restSize: number;
  restCount: number;
}

export interface Folder {
  /** From the drive root down to this folder. */
  trail: { id: number; name: string }[];
  item: Item;
  children: Item[];
  /** Entries left out of `children` because there are too many, and their combined size. */
  moreCount: number;
  moreBytes: number;
}

export interface Summary {
  indexId: number;
  root: string;
  bytes: number;
  files: number;
  folders: number;
  unreadable: number;
  durationMs: number;
  /** "mft": read from the NTFS file table. "walk": folder by folder. */
  method: "mft" | "walk";
  elevated: boolean;
}

export interface Found {
  total: number;
  items: Item[];
}

export interface DupeGroup {
  size: number;
  items: Item[];
}

export interface Dupes {
  groups: DupeGroup[];
  totalGroups: number;
  wastedBytes: number;
  durationMs: number;
}

export interface DupesProgress {
  stage: "sampling" | "hashing";
  done: number;
  total: number;
}

export interface TrashReport {
  trashed: number[];
  freedBytes: number;
  failed: { path: string; reason: "protected" | "failed" }[];
  summary: Summary;
}

export type Tab = "map" | "largest" | "search" | "dupes";

interface DiskState {
  drives: Drive[];
  drive: string | null;
  phase: "idle" | "indexing" | "ready";
  progress: { files: number; bytes: number; path: string } | null;
  summary: Summary | null;
  error: string | null;
  tab: Tab;
  folder: Folder | null;
  rings: Ring | null;
  largest: Item[] | null;
  query: string;
  found: Found | null;
  /** Items ticked for the Recycle Bin, by id. */
  picked: Map<number, Item>;
  trashing: boolean;
  lastTrash: TrashReport | null;
  dupes: Dupes | null;
  dupesRunning: boolean;
  dupesProgress: DupesProgress | null;
  /** Smallest file the duplicate search looks at, in bytes. */
  dupesMinSize: number;
}

const MB = 1024 * 1024;
export const DUPES_SIZES = [MB, 10 * MB, 100 * MB];
export const SEARCH_LIMIT = 200;

export const useDisk = create<DiskState>(() => ({
  drives: [],
  drive: null,
  phase: "idle",
  progress: null,
  summary: null,
  error: null,
  tab: "map",
  folder: null,
  rings: null,
  largest: null,
  query: "",
  found: null,
  picked: new Map(),
  trashing: false,
  lastTrash: null,
  dupes: null,
  dupesRunning: false,
  dupesProgress: null,
  dupesMinSize: 10 * MB,
}));

export function loadDrives() {
  invoke<Drive[]>("disk_drives")
    .then((drives) => useDisk.setState((s) => ({ drives, drive: s.drive ?? drives[0]?.mount ?? null })))
    .catch((e) => console.error("disk_drives failed", e));
}

/** Reads the whole drive into the in-memory index. Changes nothing on disk. */
export async function startIndex() {
  const { drive, phase } = useDisk.getState();
  if (!drive || phase === "indexing") return;
  useDisk.setState({ phase: "indexing", progress: null, error: null });
  // Everything shown so far describes the old index, which the backend is about to drop.
  const fresh = { largest: null, found: null, query: "", dupes: null, picked: new Map<number, Item>(), lastTrash: null };
  try {
    const summary = await invoke<Summary>("disk_index", { drive });
    useDisk.setState({ phase: "ready", summary, progress: null, tab: "map", ...fresh });
    await openFolder(0);
  } catch (e) {
    const code = String(e);
    useDisk.setState({ phase: "idle", summary: null, folder: null, progress: null, error: code === "cancelled" ? null : code, ...fresh });
  }
}

/** Stops indexing or a duplicate search. */
export const cancelWork = () => invoke("disk_cancel").catch(console.error);

export async function openFolder(id: number) {
  try {
    const [folder, rings] = await Promise.all([invoke<Folder>("disk_folder", { id }), invoke<Ring>("disk_rings", { id })]);
    useDisk.setState({ folder, rings });
  } catch (e) {
    console.error("disk_folder failed", e);
  }
}

async function loadLargest() {
  try {
    useDisk.setState({ largest: await invoke<Item[]>("disk_largest", { limit: 100 }) });
  } catch (e) {
    console.error("disk_largest failed", e);
  }
}

export async function showTab(tab: Tab) {
  useDisk.setState({ tab });
  if (tab === "largest" && !useDisk.getState().largest) await loadLargest();
}

export async function search(query: string) {
  useDisk.setState({ query });
  if (!query.trim()) {
    useDisk.setState({ found: null });
    return;
  }
  try {
    const found = await invoke<Found>("disk_search", { query, limit: SEARCH_LIMIT });
    // A slower, older answer must not overwrite the one for what is typed now.
    if (useDisk.getState().query === query) useDisk.setState({ found });
  } catch (e) {
    console.error("disk_search failed", e);
  }
}

/** Looks for files with identical content by reading them. Changes nothing on disk. */
export async function findDuplicates() {
  const { dupesRunning, dupesMinSize } = useDisk.getState();
  if (dupesRunning) return;
  useDisk.setState({ dupesRunning: true, dupesProgress: null, error: null });
  try {
    const dupes = await invoke<Dupes>("disk_duplicates", { minSize: dupesMinSize });
    useDisk.setState({ dupes, dupesRunning: false, dupesProgress: null });
  } catch (e) {
    const code = String(e);
    useDisk.setState({ dupesRunning: false, dupesProgress: null, error: code === "cancelled" ? null : code });
  }
}

export function togglePick(item: Item) {
  const picked = new Map(useDisk.getState().picked);
  if (!picked.delete(item.id)) picked.set(item.id, item);
  useDisk.setState({ picked });
}

export const clearPicked = () => useDisk.setState({ picked: new Map() });

/** In every duplicate group, ticks all copies but the first, replacing the current selection. */
export function pickSpareCopies() {
  const { dupes } = useDisk.getState();
  if (!dupes) return;
  const picked = new Map<number, Item>();
  for (const group of dupes.groups) for (const item of group.items.slice(1)) picked.set(item.id, item);
  useDisk.setState({ picked });
}

/** True when ticking `item` would leave no copy of its duplicate group unticked. */
export function isLastCopy(group: DupeGroup, item: Item, picked: Map<number, Item>): boolean {
  return !picked.has(item.id) && group.items.every((other) => other.id === item.id || picked.has(other.id));
}

/** Moves the ticked items to the Recycle Bin and brings every view up to date. */
export async function trashPicked() {
  const state = useDisk.getState();
  if (state.trashing || state.picked.size === 0) return;
  useDisk.setState({ trashing: true, error: null });
  try {
    const report = await invoke<TrashReport>("disk_trash", { ids: [...state.picked.keys()] });
    const gone = new Set(report.trashed);
    const { dupes, folder, tab, query } = useDisk.getState();
    useDisk.setState({
      trashing: false,
      lastTrash: report,
      summary: report.summary,
      picked: new Map(),
      // A group with a single copy left is no longer a group of duplicates.
      dupes: dupes && withoutTrashed(dupes, gone),
      largest: null,
    });
    // The folder on screen may itself be gone; step up until one still exists.
    const trail = folder?.trail.map((crumb) => crumb.id) ?? [0];
    const firstGone = trail.findIndex((id) => gone.has(id));
    await openFolder(firstGone === -1 ? trail[trail.length - 1] : trail[Math.max(firstGone - 1, 0)]);
    if (tab === "largest") await loadLargest();
    if (query) await search(query);
  } catch (e) {
    useDisk.setState({ trashing: false, error: String(e) });
  }
}

/** The duplicate report after some items left the disk, with its totals brought in line. */
function withoutTrashed(dupes: Dupes, gone: Set<number>): Dupes {
  const spare = (g: DupeGroup) => g.size * (g.items.length - 1);
  let { totalGroups, wastedBytes } = dupes;
  const groups: DupeGroup[] = [];
  for (const group of dupes.groups) {
    const left = { ...group, items: group.items.filter((item) => !gone.has(item.id)) };
    // A group with a single copy left is no longer a group of duplicates.
    const kept = left.items.length > 1;
    wastedBytes -= spare(group) - (kept ? spare(left) : 0);
    if (kept) groups.push(left);
    else totalGroups -= 1;
  }
  return { ...dupes, groups, totalGroups, wastedBytes };
}

let listening = false;

export function startDiskEvents() {
  if (listening) return;
  listening = true;
  listen<{ files: number; bytes: number; path: string }>("disk:progress", ({ payload }) => {
    if (useDisk.getState().phase === "indexing") useDisk.setState({ progress: payload });
  }).catch((e) => console.error("disk listener failed", e));
  listen<DupesProgress>("disk:dupes", ({ payload }) => {
    if (useDisk.getState().dupesRunning) useDisk.setState({ dupesProgress: payload });
  }).catch((e) => console.error("disk listener failed", e));
}
