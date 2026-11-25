import { invoke } from "@tauri-apps/api/core";
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
  kind: "program" | "driver" | "update" | "service" | "startup" | "port" | "appcrash" | "crash" | "recorder" | "delpheye";
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
}

/** Event lanes, top to bottom: the direction a change came from. */
export const LANES = [
  { id: "crash", kinds: ["crash", "appcrash"], color: "#e5484d" },
  { id: "driver", kinds: ["driver"], color: "#9b6be0" },
  { id: "update", kinds: ["update"], color: "#3b9ee5" },
  { id: "program", kinds: ["program"], color: "#2bb39a" },
  { id: "startup", kinds: ["startup", "service"], color: "#e0922f" },
  { id: "network", kinds: ["port"], color: "#c75fa8" },
  { id: "delpheye", kinds: ["delpheye", "recorder"], color: "#7d8ba0" },
] as const;
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
export const PAGE_OF: Partial<Record<TimelineEvent["kind"], Page>> = { program: "leftovers", driver: "updates", update: "updates", service: "startup", startup: "startup", port: "network", appcrash: "monitoring", crash: "monitoring", delpheye: "journal" };

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
  if (e.kind === "recorder") return t(`timeline.recorder.${e.action}`);
  return e.name;
}

/** The value line: versions, packages, modules. */
export function valueOf(e: TimelineEvent, t: TFunction): string {
  if (e.kind === "crash") {
    const [cause, confidence] = (e.now ?? "").split("|");
    return cause && cause !== "unknown" ? `${t(`monitor.verdict.cause.${cause}.title`, { defaultValue: cause })} (${t(`monitor.verdict.confidence.${confidence}`, { defaultValue: confidence })})` : t("timeline.crash.unknown");
  }
  if (e.kind === "appcrash") return e.now ? t("timeline.module", { name: e.now }) : "";
  if (e.was && e.now) return `${e.was} → ${e.now}`;
  if (e.kind === "program" && e.now?.includes("\n")) return t("timeline.packages", { count: e.now.split("\n").length });
  return e.now ?? e.was ?? "";
}

/** How likely a change is to matter for a crash that followed: drivers and Windows first. */
const WEIGHT: Partial<Record<TimelineEvent["kind"], number>> = { driver: 3, update: 3, service: 2, startup: 1.5, program: 1 };
export function before(e: TimelineEvent, all: TimelineEvent[], days = 3): TimelineEvent[] {
  return all
    .filter((x) => WEIGHT[x.kind] && x.t <= e.t && x.t >= e.t - days * 86_400)
    .sort((a, b) => (WEIGHT[b.kind] ?? 0) / (1 + (e.t - b.t) / 86_400) - (WEIGHT[a.kind] ?? 0) / (1 + (e.t - a.t) / 86_400))
    .slice(0, 6);
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
