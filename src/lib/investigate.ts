import { GIANTS, akin, causes, words, type Cause, type Level, type Reading, type TimelineEvent } from "./timeline";

/** A fact found by the search. `values` fill the sentence. */
export interface Proof {
  id:
    | "onset"
    | "repeats"
    | "tied"
    | "maker"
    | "sameGiant"
    | "moreAfter"
    | "noneSince"
    | "existedBefore"
    | "withoutIt"
    | "harmlessBefore"
    | "fewCrashes"
    | "hot"
    | "ram"
    | "gpu"
    | "normal"
    | "hour"
    | "program"
    | "windowsModule"
    | "foreignModule"
    | "unknownModule";
  values?: Record<string, string | number>;
}

export interface Suspect {
  cause: Cause;
  /** Every time the same change was made. */
  times: number;
  for: Proof[];
  against: Proof[];
  score: number;
  level: Level | "out";
}

export interface Maker {
  exists: boolean;
  company: string | null;
  description: string | null;
  signed: boolean | null;
  windows: boolean;
}

export interface Finding {
  siblings: number;
  first: number;
  suspects: Suspect[];
  out: Suspect[];
  /** What the crashes have in common apart from changes. */
  conditions: Proof[];
  maker: Maker | null;
  module: string | null;
  /** How many of the crashes had readings. */
  measured: number;
}

export const STEPS = ["wide", "repeat", "beforeAfter", "conditions", "pattern", "module"] as const;
export type StepId = (typeof STEPS)[number];
export interface Progress {
  step: StepId;
  found: Proof[];
  count: number;
}

export interface Sources {
  readings: (from: number, to: number, step: number) => Promise<Reading[]>;
  maker: (path: string) => Promise<Maker | null>;
  now: number;
  /** Called as each check finishes. */
  onStep?: (p: Progress) => void | Promise<void>;
}

const DAY = 86_400;
const WINDOW = 3 * DAY;
const identity = (e: TimelineEvent) => `${e.kind}|${e.name}`;

/** When the log reaches back to: before it "no crashes" would be made up. */
export function coverage(problem: TimelineEvent, all: TimelineEvent[], now: number): number {
  if (problem.kind === "alert") return all.find((e) => e.kind === "alert")?.t ?? now;
  // Application and System logs start about the same time; the older of their first lines counts for neither alone.
  const first = all.find((e) => (problem.kind === "appcrash" ? e.kind === "appcrash" : e.kind === "service" || e.kind === "crash"));
  return first?.t ?? now;
}

/** Looks for what is behind a problem: over a month, over every time it happened, with facts for and against each suspect. */
export async function investigate(problem: TimelineEvent, all: TimelineEvent[], src: Sources): Promise<Finding> {
  const say = async (step: StepId, found: Proof[], count: number) => src.onStep?.({ step, found, count });
  // Shutdowns with different known causes are different problems.
  const cause = (e: TimelineEvent) => (e.kind === "crash" ? (e.now ?? "").split("|")[0] : "");
  const siblings = all.filter((e) => e.kind === problem.kind && e.name === problem.name && cause(e) === cause(problem)).sort((a, b) => a.t - b.t);
  const same = problem.kind !== "crash" || !["", "unknown"].includes(cause(problem));
  const first = siblings[0] ?? problem;
  const from = coverage(problem, all, src.now);

  // 1. Wider: a month before this one, and before the first one.
  const byId = new Map<string, Cause>();
  for (const c of [...causes(problem, all, 30), ...(first.id !== problem.id ? causes(first, all, 14) : [])]) {
    const key = identity(c.e);
    const has = byId.get(key);
    if (!has || c.score > has.score) byId.set(key, c);
  }
  const suspects: Suspect[] = [...byId.values()].map((cause) => ({ cause, times: all.filter((e) => identity(e) === identity(cause.e)).length, for: [], against: [], score: cause.score, level: "timing" }));
  for (const s of suspects) if (s.cause.reasons.includes("sameName") || s.cause.reasons.includes("module")) s.for.push({ id: "tied" });
  await say("wide", [], suspects.length);

  // 2. Did the same change come before every such crash?
  const repeats: Proof[] = [];
  for (const s of suspects) {
    const when = all.filter((e) => identity(e) === identity(s.cause.e)).map((e) => e.t);
    const preceded = siblings.filter((x) => when.some((w) => w <= x.t && x.t - w <= WINDOW)).length;
    const followed = when.filter((w) => siblings.some((x) => x.t >= w && x.t - w <= WINDOW)).length;
    // The same change standing before several separate crashes; made often, it would do so by chance.
    if (when.length >= 2 && preceded >= 3 && preceded / siblings.length >= 0.6 && followed / when.length >= 0.6) {
      const p: Proof = { id: "repeats", values: { n: preceded, of: siblings.length } };
      s.for.push(p);
      repeats.push(p);
    } else if (when.length >= 3 && followed / when.length <= 0.34) s.against.push({ id: "harmlessBefore", values: { n: when.length - followed, of: when.length } });
  }
  await say("repeat", repeats, siblings.length);

  // 3. Was there any before the change, and were there more after it?
  const turns: Proof[] = [];
  for (const s of suspects) {
    const t = s.cause.e.dayOnly ? s.cause.e.t - DAY / 2 : s.cause.e.t;
    if (s.cause.e.kind === "alert") continue;
    const before = siblings.filter((x) => x.t < t);
    const after = siblings.filter((x) => x.t >= t);
    const daysBefore = (t - from) / DAY;
    const daysAfter = (src.now - t) / DAY;
    if (!before.length && daysBefore >= 14 && after.length >= 3 && first.t - t <= 4 * DAY) {
      const p: Proof = { id: "onset", values: { days: Math.floor(daysBefore), n: after.length } };
      s.for.push(p);
      turns.push(p);
    } else if (before.length >= 1 && daysBefore >= 3) {
      const a = before.length / daysBefore;
      const b = after.length / Math.max(1, daysAfter);
      if (before.length + after.length >= 7 && after.length >= 5 && daysAfter >= 5 && daysBefore >= 14 && b >= a * 3.5) {
        const p: Proof = { id: "moreAfter", values: { a: (a * 7).toFixed(1), b: (b * 7).toFixed(1) } };
        s.for.push(p);
        turns.push(p);
      } else s.against.push({ id: "existedBefore", values: { n: before.length } });
      // Once before, or unexplained ones that may not be the same thing, is a doubt, not a verdict.
    }
    if (after.length === 1 && daysAfter >= 14) s.against.push({ id: "noneSince", values: { days: Math.floor((src.now - after[0].t) / DAY) } });
  }
  // When many things changed just before the first one, none of them stands out.
  const began = suspects.filter((s) => s.for.some((x) => x.id === "onset"));
  // Nor does it when something changes every few days anyway: it would have stood there by chance.
  const ordinary = (all.filter((e) => ["driver", "update", "program", "service", "startup"].includes(e.kind) && e.t < first.t - 4 * DAY && e.t >= first.t - 34 * DAY).length / 30) * 4;
  const common = began.length > 3 || ordinary > 0.6;
  if (common) for (const s of began) s.for = s.for.filter((x) => x.id !== "onset" || s.for.some((y) => y.id === "tied" || y.id === "repeats"));
  await say("beforeAfter", turns.slice(0, common ? 0 : 2), siblings.length);

  // 4. What the computer was like just before each of them, against what it is usually like.
  const conditions: Proof[] = [];
  const sample = siblings.slice(-12);
  const peaks: { hot: number; ram: number; gpu: number; top: string | null }[] = [];
  for (const x of sample) {
    const rs = await src.readings(x.t - 1800, x.t + 60, 60);
    if (!rs.length) continue;
    const max = (get: (r: Reading) => number | null) => Math.max(0, ...rs.map((r) => get(r) ?? 0));
    peaks.push({ hot: max((r) => r.cpuTempMax ?? r.cpuTemp), ram: max((r) => r.ram), gpu: max((r) => r.gpu), top: rs[rs.length - 1].top });
  }
  let usual: Reading[] = [];
  if (peaks.length >= 2) {
    usual = await src.readings(src.now - 14 * DAY, src.now, 1800);
    const often = (get: (r: Reading) => number | null, line: number) => (usual.length ? usual.filter((r) => (get(r) ?? 0) >= line).length / usual.length : 1);
    const check = (id: "hot" | "ram" | "gpu", line: number, get: (r: Reading) => number | null) => {
      const n = peaks.filter((p) => p[id] >= line).length;
      // Common to these crashes and rare otherwise.
      if (n >= 2 && n / peaks.length >= 0.7 && often(get, line) <= 0.25) conditions.push({ id, values: { n, of: peaks.length, line } });
    };
    check("hot", 90, (r) => r.cpuTempMax ?? r.cpuTemp);
    check("ram", 90, (r) => r.ram);
    check("gpu", 80, (r) => r.gpu);
    if (!conditions.length) conditions.push({ id: "normal", values: { n: peaks.length } });
  }
  await say("conditions", conditions, peaks.length);

  // 5. The hour and the program.
  const patterns: Proof[] = [];
  if (siblings.length >= 5) {
    const hours = siblings.map((x) => new Date(x.t * 1000).getHours());
    let best = { at: 0, n: 0 };
    for (let h = 0; h < 24; h++) {
      const n = hours.filter((x) => (x - h + 24) % 24 < 4).length;
      if (n > best.n) best = { at: h, n };
    }
    // The best of 24 windows always looks good: it has to hold nearly all of them.
    if (best.n / hours.length >= 0.85) patterns.push({ id: "hour", values: { from: best.at, to: (best.at + 4) % 24, n: best.n, of: hours.length } });
  }
  if (peaks.length >= 3) {
    const tops = new Map<string, number>();
    for (const p of peaks) if (p.top) tops.set(p.top, (tops.get(p.top) ?? 0) + 1);
    const [name, n] = [...tops].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    // A program that is always in front says nothing by being in front.
    const always = usual.length ? usual.filter((x) => x.top === name).length / usual.length : 1;
    if (n >= 3 && n / peaks.length >= 0.7 && always <= 0.35 && name.toLowerCase() !== problem.name.toLowerCase()) patterns.push({ id: "program", values: { name, n, of: peaks.length } });
  }
  conditions.push(...patterns);
  await say("pattern", patterns, siblings.length);

  // 6. Whose file crashed.
  let maker: Maker | null = null;
  const path = problem.kind === "appcrash" || problem.kind === "hang" ? problem.was : null;
  const found: Proof[] = [];
  if (path) maker = await src.maker(path);
  if (maker?.exists) {
    if (maker.windows) found.push({ id: "windowsModule", values: { name: problem.now ?? "" } });
    else {
      found.push(maker.company ? { id: "foreignModule", values: { name: problem.now ?? "", company: maker.company } } : { id: "unknownModule", values: { name: problem.now ?? "" } });
      const theirs = words(`${maker.company ?? ""} ${maker.description ?? ""}`);
      for (const s of suspects) {
        const own = words(s.cause.e.name);
        const giant = GIANTS.find((g) => (maker?.company ?? "").toLowerCase().includes(g) && s.cause.e.name.toLowerCase().includes(g));
        if (theirs.some((a) => own.some((b) => akin(a, b)))) s.for.push({ id: "maker", values: { company: maker.company ?? "" } });
        else if (giant) s.for.push({ id: "sameGiant", values: { company: maker.company ?? "" } });
      }
    }
  }
  await say("module", found, path ? 1 : 0);

  // The verdicts. Timing alone never makes a cause; a problem that was there before clears the change.
  const worth: Partial<Record<Proof["id"], number>> = { onset: 0.22, repeats: 0.4, tied: 0.15, maker: 0.28, sameGiant: 0.06, moreAfter: 0.2, noneSince: -0.2, existedBefore: -0.45, harmlessBefore: -0.3 };
  // With one or two crashes the only hint is a lone driver or update the day before; among several nothing stands out.
  const lone = suspects.filter((s) => problem.t - s.cause.e.t <= DAY && s.cause.e.kind !== "alert");
  for (const s of suspects) {
    if (siblings.length === 1) s.against.push({ id: "fewCrashes" });
    const earlier = Number(s.against.find((p) => p.id === "existedBefore")?.values?.n ?? 0);
    const doubt = earlier > 0 && (earlier < 2 || !same);
    s.score = Math.max(0, Math.min(1, s.cause.score + [...s.for, ...s.against].reduce((a, p) => a + (p.id === "existedBefore" && doubt ? -0.15 : (worth[p.id] ?? 0)), 0)));
    const solid = s.for.some((p) => p.id === "repeats" || p.id === "tied" || p.id === "maker") || s.cause.reasons.includes("heat");
    const cleared = s.against.some((p) => (p.id === "existedBefore" && !doubt) || p.id === "harmlessBefore");
    s.level = cleared && !solid ? "out" : solid && s.score >= 0.45 && !cleared ? "likely" : s.score >= 0.3 && (s.for.some((p) => p.id !== "sameGiant") || (siblings.length <= 2 && lone.length === 1 && lone[0] === s && (s.cause.e.kind === "driver" || s.cause.e.kind === "update"))) ? "possible" : "timing";
  }
  suspects.sort((a, b) => b.score - a.score);
  return { siblings: siblings.length, first: first.t, suspects: suspects.filter((s) => s.level !== "out" && (s.level !== "timing" || problem.t - s.cause.e.t <= WINDOW)), out: suspects.filter((s) => s.level === "out"), conditions, maker, module: problem.kind === "appcrash" ? problem.now : null, measured: peaks.length };
}

/** What to try next, from what was found. */
export function advice(problem: TimelineEvent, f: Finding): string[] {
  const out: string[] = [];
  const top = f.suspects[0];
  if (f.conditions.some((c) => c.id === "hot")) out.push("cool");
  if (f.conditions.some((c) => c.id === "ram")) out.push("memory");
  if (top && top.level !== "timing") out.push(top.cause.e.kind === "driver" ? "rollDriver" : top.cause.e.kind === "update" ? "removeUpdate" : "removeProgram");
  if (problem.kind === "appcrash" && f.maker?.exists && !f.maker.windows) out.push("updateMaker");
  if (problem.kind === "appcrash" && !out.length) out.push("reinstall");
  if (problem.kind === "crash" && !out.length) out.push("stability");
  if (f.siblings < 3 || !f.measured) out.push("wait");
  return out.slice(0, 4);
}
