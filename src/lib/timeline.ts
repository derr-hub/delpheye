import { invoke } from "@tauri-apps/api/core";
import { AppWindow, Cpu, Download, Flame, Network, Package, Rocket, ScanEye, ServerCog, Skull, TriangleAlert, type LucideIcon } from "lucide-react";
import type { TFunction } from "i18next";
import type { Page } from "./app";

/** One recorded minute (or a longer stretch, averaged). Times are unix seconds. */
export interface Reading {
  t: number;
  n: number;
  cpu: number | null;
  ram: number | null;
  cpuTemp: number | null;
  cpuTempMax: number | null;
  gpu: number | null;
  gpuTemp: number | null;
  rx: number | null;
  tx: number | null;
  freeMb: number | null;
  hot: number;
  top: string | null;
}

export interface TimelineEvent {
  id: string;
  t: number;
  kind: "program" | "driver" | "update" | "service" | "startup" | "port" | "appcrash" | "crash" | "alert" | "recorder" | "delpheye";
  action: "added" | "removed" | "changed" | "happened" | "dated";
  name: string;
  was: string | null;
  now: string | null;
  source: "seen" | "windows";
  dayOnly: boolean;
}

export interface Stats {
  paused: boolean;
  bytes: number;
  readings: number;
  events: number;
  firstReading: number | null;
  firstEvent: number | null;
  byKind: [string, string, number][];
  /** Since when each kind (program, startup, port) is watched directly. */
  looked: [string, number][];
  snapshots: number;
}

/** kind, id, name, value */
export type Row = [string, string, string, string | null];
export interface Snapshot {
  id: number;
  t: number;
  name: string;
  auto: boolean;
  counts: [string, number][];
}

/** Event lanes, top to bottom: the direction a change came from. */
export const LANES = [
  { id: "crash", kinds: ["crash", "appcrash"], color: "#d8434a", icon: TriangleAlert },
  { id: "alert", kinds: ["alert"], color: "#d9702b", icon: Flame },
  { id: "driver", kinds: ["driver"], color: "#8457d6", icon: Cpu },
  { id: "update", kinds: ["update"], color: "#2d7fd3", icon: Download },
  { id: "program", kinds: ["program"], color: "#1f9a86", icon: Package },
  { id: "startup", kinds: ["startup", "service"], color: "#b9791f", icon: Rocket },
  { id: "network", kinds: ["port"], color: "#b04c93", icon: Network },
  { id: "delpheye", kinds: ["delpheye", "recorder"], color: "#637389", icon: ScanEye },
] as const;

export const iconOf = (e: { kind: string }): LucideIcon =>
  ({ crash: Skull, appcrash: AppWindow, alert: Flame, driver: Cpu, update: Download, program: Package, startup: Rocket, service: ServerCog, port: Network })[e.kind as "crash"] ?? ScanEye;
export type LaneId = (typeof LANES)[number]["id"];
export const laneOf = (e: TimelineEvent) => LANES.find((l) => (l.kinds as readonly string[]).includes(e.kind)) ?? LANES[LANES.length - 1];

/** Measured tracks. */
export const TRACKS = [
  { id: "cpu", color: "#3b9ee5", max: 100, unit: "%", get: (r: Reading) => r.cpu },
  { id: "ram", color: "#2bb39a", max: 100, unit: "%", get: (r: Reading) => r.ram },
  { id: "gpu", color: "#9b6be0", max: 100, unit: "%", get: (r: Reading) => r.gpu },
  { id: "temp", color: "#f0772e", max: 105, unit: " °C", get: (r: Reading) => r.cpuTempMax ?? r.cpuTemp },
] as const;
export type TrackId = (typeof TRACKS)[number]["id"];

/** Where each kind of event can be acted on. */
export const PAGE_OF: Partial<Record<TimelineEvent["kind"], Page>> = { program: "leftovers", driver: "updates", update: "updates", service: "startup", startup: "startup", port: "network", appcrash: "monitoring", crash: "monitoring", alert: "monitoring", delpheye: "journal" };

export async function loadEvents(): Promise<TimelineEvent[]> {
  const far = Math.floor(Date.now() / 1000) + 86_400;
  const [own, done] = await Promise.all([
    invoke<Omit<TimelineEvent, "id">[]>("timeline_events", { from: 0, to: far }),
    invoke<{ id: number; at: number; kind: string }[]>("journal_list", { limit: 500 }).catch(() => []),
  ]);
  const all: TimelineEvent[] = own.map((e, i) => ({ ...e, id: `e${i}` }));
  for (const d of done) all.push({ id: `j${d.id}`, t: d.at, kind: "delpheye", action: "happened", name: d.kind, was: null, now: null, source: "seen", dayOnly: false });
  // A day-only date of today stands at noon, which may not have come yet.
  const now = Math.floor(Date.now() / 1000);
  for (const e of all) if (e.t > now) e.t = now;
  all.sort((a, b) => a.t - b.t);
  // Windows notes only the new driver; what it replaced is the last one of the same package.
  const last = new Map<string, string | null>();
  for (const e of all) {
    if (e.kind !== "driver") continue;
    const was = last.get(e.name);
    if (was && was !== e.now) {
      e.was = was;
      e.action = "changed";
    }
    last.set(e.name, e.now);
  }
  return all;
}

export const loadReadings = (from: number, to: number, step: number) => invoke<Reading[]>("timeline_readings", { from: Math.floor(from), to: Math.ceil(to), step: Math.max(60, Math.round(step / 60) * 60) });

/** "NVIDIA|display|nvami" → maker, class, package. */
const driverParts = (name: string) => {
  const [maker, cls = "other", family = ""] = name.split("|");
  return { maker, cls, family };
};

/** What happened, in a few words. */
export function titleOf(e: TimelineEvent, t: TFunction): string {
  if (e.kind === "driver") {
    const { maker, cls, family } = driverParts(e.name);
    return `${t(`timeline.class.${cls}`)} · ${maker}${cls === "other" || cls === "component" ? ` (${family})` : ""}`;
  }
  if (e.kind === "crash") return t(`timeline.crash.${e.name}`, { defaultValue: t("timeline.crash.shutdown") });
  if (e.kind === "delpheye") return t(`journal.${e.name}`, { defaultValue: e.name });
  if (e.kind === "alert") return t(`timeline.alert.${e.name}`);
  if (e.kind === "recorder") return t(`timeline.recorder.${e.action}`);
  return e.name;
}

/** The value line: versions, packages, modules. */
export function valueOf(e: TimelineEvent, t: TFunction): string {
  if (e.kind === "crash") {
    const [cause, confidence] = (e.now ?? "").split("|");
    return cause && cause !== "unknown" ? `${t(`monitor.verdict.cause.${cause}.title`, { defaultValue: cause })} (${t(`monitor.verdict.confidence.${confidence}`, { defaultValue: confidence })})` : t("timeline.crash.unknown");
  }
  if (e.kind === "alert") return e.now ? (e.name === "ram-full" ? `${e.now}%` : e.name === "disk-full" ? `${(Number(e.now) / 1024).toFixed(1)} GB` : `${e.now} °C`) : "";
  if (e.kind === "appcrash") return e.now ? t("timeline.module", { name: e.now }) : "";
  if (e.was && e.now) return `${e.was} → ${e.now}`;
  if (e.kind === "program" && e.now?.includes("\n")) return t("timeline.packages", { count: e.now.split("\n").length });
  return e.now ?? e.was ?? "";
}

// ───────────────────────── causes ─────────────────────────

/** "likely": something ties them together. "possible": close in time and of a kind that breaks things. "timing": only close in time. */
export type Level = "likely" | "possible" | "timing";
export type Reason = "sameName" | "module" | "heat" | "soon" | "firstAfter" | "kind";
export interface Cause {
  e: TimelineEvent;
  score: number;
  level: Level;
  reasons: Reason[];
}

const WEIGHT: Partial<Record<TimelineEvent["kind"], number>> = { alert: 0.4, driver: 0.3, update: 0.28, service: 0.18, program: 0.16, startup: 0.14, port: 0.05 };
const COMMON = new Set(["corporation", "update", "driver", "microsoft", "windows", "service", "services", "host", "runtime", "desktop", "loader", "system", "kernel", "kernelbase", "ntdll", "client", "server", "helper", "launcher", "agent", "manager", "software", "technology", "technologies", "graphics", "audio", "network", "application", "shipping", "win64", "program", "programs", "files", "file", "common", "steam", "tools", "tool", "process", "module", "library", "version", "offline", "online", "games", "input", "output", "display", "sound", "bluetooth", "storage", "camera", "component", "firmware", "other", "device", "devices", "controller", "engine", "framework", "platform", "support", "setup", "installer", "security", "control", "monitor", "native"]);
/** Makers of half of what is on any computer: sharing one says little. */
export const GIANTS = ["intel", "nvidia", "realtek", "samsung", "asus", "asustek", "google", "adobe", "qualcomm", "mediatek", "lenovo", "advanced"];
export const words = (s: string) => s.toLowerCase().split(/[^a-zа-яіїєґ0-9]+/).filter((w) => w.length > 4 && !/^\d+$/.test(w) && !COMMON.has(w) && !GIANTS.includes(w));
/** The same word, or a long one beginning with the other: never a piece from the middle. */
export const akin = (a: string, b: string) => a === b || (a.length >= 6 && b.length >= 6 && (a.startsWith(b) || b.startsWith(a)));

export const isProblem = (e: TimelineEvent) => e.kind === "crash" || e.kind === "appcrash" || e.kind === "alert";

/** What changed before a problem, weighed. Nothing here is proof; the level says how much it is worth. */
export function causes(problem: TimelineEvent, all: TimelineEvent[], days = 3): Cause[] {
  const same = all.filter((x) => x.kind === problem.kind && x.name === problem.name);
  const own = new Set([...words(problem.name.replace(/\.exe$/i, "")), ...words((problem.now ?? "").replace(/\.(dll|exe|sys)$/i, ""))]);
  const out: Cause[] = [];
  for (const e of all) {
    const weight = WEIGHT[e.kind];
    if (!weight || e.id === problem.id || e.t > problem.t || e.t < problem.t - days * 86_400) continue;
    const hours = (problem.t - e.t) / 3600;
    // Heat explains a shutdown minutes later, not days later; and it does not explain itself.
    if (e.kind === "alert" && (problem.kind === "alert" || hours > 2)) continue;
    const reasons: Reason[] = [];
    let score = weight * Math.exp(-hours / 48);
    // A service's value is a path: its folders are not its name.
    const theirs = words(e.kind === "service" ? e.name : `${e.name} ${e.now ?? ""}`);
    if (problem.kind === "appcrash" && theirs.some((w) => [...own].some((o) => akin(w, o)))) {
      score += 0.4;
      reasons.push(e.kind === "program" ? "sameName" : "module");
    }
    if (e.kind === "alert") {
      score += e.name === "ram-full" ? 0.1 : 0.25;
      reasons.push("heat");
    }
    if (hours <= 24) {
      score += 0.06;
      reasons.push("soon");
    }
    const beforeIt = same.some((x) => x.t < e.t && x.t > e.t - 30 * 86_400);
    if (!beforeIt && all[0] && all[0].t < e.t - 30 * 86_400) {
      score += 0.12;
      reasons.push("firstAfter");
    }
    if (e.kind === "driver" || e.kind === "update") reasons.push("kind");
    const tied = reasons.some((r) => r === "sameName" || r === "module" || r === "heat");
    out.push({ e, score: Math.min(1, score), reasons, level: tied && score >= 0.45 ? "likely" : score >= 0.3 ? "possible" : "timing" });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Changes made within half an hour of each other: one setup usually does several things. */
export interface Bundle {
  id: string;
  items: Cause[];
  score: number;
  level: Level;
  t: number;
}
export function bundles(list: Cause[]): Bundle[] {
  const sorted = [...list].sort((a, b) => a.e.t - b.e.t);
  const out: Cause[][] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.e.kind !== "alert" && last[0].e.kind !== "alert" && c.e.t - last[last.length - 1].e.t <= 1800) last.push(c);
    else out.push([c]);
  }
  return out
    .map((items) => {
      items.sort((a, b) => b.score - a.score);
      return { id: items[0].e.id, items, score: items[0].score, level: items[0].level, t: items[0].e.t };
    })
    .sort((a, b) => b.score - a.score);
}

// ───────────────────────── the state on a date ─────────────────────────

/** "recorded": seen directly. "rebuilt": today's state with the known changes undone. "partial": only what Windows kept. "unknown": nothing is known. */
export type Trust = "recorded" | "rebuilt" | "partial" | "unknown";
export interface State {
  trust: Trust;
  items: Map<string, string | null>;
}

/** What of one kind was there at `at`: what is there now, with every later change undone. */
export function stateAt(kind: "program" | "startup", at: number, present: Row[], all: TimelineEvent[], looked: number | undefined): State {
  const items = new Map<string, string | null>(present.filter((r) => r[0] === kind).map((r) => [r[2], r[3]]));
  if (!items.size) return { trust: "unknown", items };
  const exact = looked !== undefined && at >= looked;
  // Windows keeps no history of startup entries: before DelphEye watched, nothing is known.
  if (kind === "startup" && !exact) return { trust: "unknown", items: new Map() };
  // Nor of removed programs; and before its first install date there is nothing to go by.
  const firstDate = all.find((e) => e.kind === kind)?.t;
  if (!exact && (firstDate === undefined || at < firstDate)) return { trust: "unknown", items: new Map() };
  for (let i = all.length - 1; i >= 0 && all[i].t > at; i--) {
    const e = all[i];
    if (e.kind !== kind) continue;
    if (e.source === "windows" && exact) continue;
    if (e.action === "added") {
      // Windows' "installed" may repeat for an update; only drop it when it was not known earlier.
      if (e.source === "seen" || !all.some((x) => x.kind === kind && x.name === e.name && x.t <= at)) items.delete(e.name);
    } else if (e.action === "removed" && e.source === "seen") items.set(e.name, e.was);
    else if (e.action === "changed" && items.has(e.name)) items.set(e.name, e.was);
  }
  return { trust: exact ? "rebuilt" : "partial", items };
}

/** The newest driver of each package known by `at`. */
export function driversAt(at: number, all: TimelineEvent[]): State {
  const items = new Map<string, string | null>();
  for (const e of all) if (e.kind === "driver" && e.t <= at) items.set(e.name, e.now);
  return { trust: items.size ? "partial" : "unknown", items };
}

export interface Change {
  name: string;
  kind: TimelineEvent["kind"];
  how: "added" | "removed" | "changed" | "dated";
  was: string | null;
  now: string | null;
  t: number;
}

/** What differs between a moment and now: several events about one thing become one. */
export function difference(all: TimelineEvent[], from: number): Change[] {
  const out = new Map<string, Change>();
  for (const e of all) {
    if (e.t < from || !["program", "driver", "service", "startup", "port", "update"].includes(e.kind)) continue;
    const key = `${e.kind}|${e.name}`;
    const seen = out.get(key);
    const how: Change["how"] = e.kind === "update" ? "added" : e.action === "happened" ? "added" : e.action;
    if (!seen) {
      out.set(key, { name: e.name, kind: e.kind, how, was: e.was, now: e.now, t: e.t });
      continue;
    }
    // Came and went in between: nothing differs. Anything else that came back or moved on is a change.
    if (how === "removed" && seen.how === "added") out.delete(key);
    else if (how === "removed") out.set(key, { ...seen, how: "removed", now: null, t: e.t });
    else if (seen.how === "removed") out.set(key, { ...seen, how: "changed", now: e.now, t: e.t });
    else out.set(key, { ...seen, now: e.now, t: e.t, how: seen.how });
  }
  return [...out.values()].filter((c) => !(c.how === "changed" && c.was !== null && c.was === c.now)).sort((a, b) => b.t - a.t);
}
