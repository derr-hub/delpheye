import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type Severity = "info" | "low" | "medium" | "high";
export type Area = "persistence" | "process" | "tamper";

export interface Finding {
  id: string;
  area: Area;
  kind: string;
  reason: string | null;
  severity: Severity;
  title: string;
  detail: string;
  location: string;
  file: string | null;
  pid: number | null;
  key: string | null;
}

export type Outcome = "pass" | "fail" | "unknown";

export interface HardeningTest {
  id: string;
  outcome: Outcome;
  weight: number;
  detail: string | null;
  fix: string | null;
}

export interface Extension {
  browser: "chrome" | "edge" | "brave" | "vivaldi" | "opera" | "firefox";
  profile: string;
  id: string;
  name: string;
  version: string;
  enabled: boolean | null;
  fromStore: boolean;
  unpacked: boolean;
  allSites: boolean;
  powers: string[];
  risk: "high" | "medium" | "low";
  known: boolean;
  path: string;
}

export interface OpenPort {
  port: number;
  ports: number[];
  name: string;
  exe: string | null;
  service: string | null;
  risk: "high" | "medium" | "low";
  windows: boolean;
}

export interface ScanReport {
  elevated: boolean;
  durationMs: number;
  limited: string[];
  findings: Finding[];
  hardening: { score: number; tests: HardeningTest[] };
  extensions: Extension[];
  backup: { score: number; tests: HardeningTest[] };
  exposure: { open: OpenPort[]; publicNetworks: string[]; privateNetworks: string[] };
}

export type Section = "threats" | "tamper" | "windows" | "browser" | "backup" | "network" | "passwords";
export const SECTIONS: Section[] = ["threats", "tamper", "windows", "browser", "backup", "network", "passwords"];

/** 0–100 per section; passwords are a tool, not scored. */
export function sectionScores(r: ScanReport): Record<Exclude<Section, "passwords">, number> {
  const penalty = (fs: Finding[]) => Math.max(0, 100 - fs.reduce((a, f) => a + (f.severity === "high" ? 45 : f.severity === "medium" ? 15 : f.severity === "low" ? 4 : 0), 0));
  const browser = Math.max(0, 100 - r.extensions.filter((e) => e.enabled !== false).reduce((a, e) => a + (e.risk === "high" ? 22 : e.risk === "medium" ? 6 : 0), 0));
  const network = Math.max(
    0,
    100 - r.exposure.open.reduce((a, o) => a + (o.risk === "high" ? 30 : o.risk === "medium" ? 8 : 0), 0) - (r.exposure.publicNetworks.length && r.exposure.open.some((o) => o.risk !== "low") ? 15 : 0),
  );
  return {
    threats: penalty(r.findings.filter((f) => f.area !== "tamper")),
    tamper: penalty(r.findings.filter((f) => f.area === "tamper")),
    windows: r.hardening.score,
    browser,
    backup: r.backup.score,
    network,
  };
}

/** The shield: threats weigh most, then Windows' defences. */
export function shieldScore(r: ScanReport): number {
  const s = sectionScores(r);
  const w = { threats: 30, tamper: 15, windows: 20, browser: 12, backup: 12, network: 11 } as const;
  let sum = 0;
  let total = 0;
  for (const k of Object.keys(w) as (keyof typeof w)[]) {
    sum += s[k] * w[k];
    total += w[k];
  }
  // A real threat caps the shield whatever else is fine.
  const high = r.findings.some((f) => f.severity === "high");
  return Math.round(Math.min(high ? 45 : 100, sum / total));
}

export type Verdict = "malicious" | "known" | "unknown" | "failed";

export interface Reputation {
  path: string;
  hashes: { sha256: string; sha1: string; size: number } | null;
  verdict: Verdict;
  detectionPct: number | null;
  lastSeen: number | null;
  trust: number | null;
  maliciousSource: string | null;
}

export type Action = "quarantine-file" | "quarantine-key" | "end-process";

interface SecurityState {
  phase: "idle" | "scanning" | "done";
  report: ScanReport | null;
  error: string | null;
  tab: Section | null;
  /** Online reputation lookups are off until the user switches them on. */
  reputationOn: boolean;
  /** File path → its reputation, or "pending" while being looked up. */
  reputation: Record<string, Reputation | "pending">;
  /** Finding id → what happened after an action on it. */
  acted: Record<string, { action: Action; done: boolean; reason: string | null; doneActions: Action[] }>;
}

const REPUTATION_KEY = "delpheye.reputation";

function storedReputation(): boolean {
  try {
    return localStorage.getItem(REPUTATION_KEY) === "on";
  } catch {
    return false;
  }
}

export const useSecurity = create<SecurityState>(() => ({
  phase: "idle",
  report: null,
  error: null,
  tab: null,
  reputationOn: storedReputation(),
  reputation: {},
  acted: {},
}));

export function setReputationOn(on: boolean) {
  useSecurity.setState({ reputationOn: on });
  try {
    localStorage.setItem(REPUTATION_KEY, on ? "on" : "off");
  } catch {
    /* storage unavailable */
  }
}

export async function scan() {
  if (useSecurity.getState().phase === "scanning") return;
  useSecurity.setState({ phase: "scanning", error: null, acted: {} });
  try {
    const report = await invoke<ScanReport>("security_scan");
    useSecurity.setState({ phase: "done", report });
  } catch (e) {
    useSecurity.setState({ phase: useSecurity.getState().report ? "done" : "idle", error: String(e) });
  }
}

/** Looks the files up online by hash. Only ever called with reputation lookups switched on. */
export async function checkReputation(paths: string[]) {
  const { reputationOn, reputation } = useSecurity.getState();
  if (!reputationOn) return;
  const todo = [...new Set(paths)].filter((p) => !reputation[p]);
  if (!todo.length) return;
  useSecurity.setState((s) => ({ reputation: { ...s.reputation, ...Object.fromEntries(todo.map((p) => [p, "pending" as const])) } }));
  try {
    const results = await invoke<Reputation[]>("security_reputation", { paths: todo });
    useSecurity.setState((s) => ({ reputation: { ...s.reputation, ...Object.fromEntries(results.map((r) => [r.path, r])) } }));
  } catch (e) {
    console.error("security_reputation failed", e);
    useSecurity.setState((s) => {
      const reputation = { ...s.reputation };
      for (const p of todo) delete reputation[p];
      return { reputation };
    });
  }
}

export async function act(finding: Finding, action: Action) {
  const result = await invoke<{ done: boolean; reason: string | null }>("security_act", { id: finding.id, action });
  useSecurity.setState((s) => {
    const before = s.acted[finding.id]?.doneActions ?? [];
    return { acted: { ...s.acted, [finding.id]: { action, ...result, doneActions: result.done ? [...before, action] : before } } };
  });
}

export const SEVERITY_ORDER: Severity[] = ["high", "medium", "low", "info"];
export const AREAS: Area[] = ["persistence", "process", "tamper"];

export interface PasswordCheck {
  leaked: number | null;
  strength: number;
  weak: string[];
}
export const checkPassword = (password: string) => invoke<PasswordCheck>("password_check", { password });
