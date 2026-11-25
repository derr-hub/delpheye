import { invoke } from "@tauri-apps/api/core";
import { loadReadings, type Reading, type TimelineEvent } from "./timeline";
import type { Maker } from "./investigate";

/** A program's stretch of work. */
export interface Run {
  start: number;
  end: number;
  name: string;
  exe: string;
  title: string | null;
  company: string | null;
  front: number;
  cpu: number;
  mem: number;
  disk: number;
  game: boolean;
}

/** One minute under the programs: the Windows kernel and what it moved. */
export interface Deep {
  t: number;
  kernel: number | null;
  user: number | null;
  switches: number | null;
  calls: number | null;
  hard: number | null;
  soft: number | null;
  read: number | null;
  write: number | null;
  processes: number | null;
  threads: number | null;
  handles: number | null;
  commit: number | null;
  mains: boolean | null;
  battery: number | null;
}

export interface Code {
  arch: "x64" | "x86" | "arm64" | "other";
  linker: string;
  size: number;
  made: string[];
  imports: { dll: string; count: number; names: string[] }[];
  sections: [string, number][];
  same: boolean | null;
  function: [string, string] | null;
  lines: { at: string; bytes: string; text: string; here: boolean }[];
  access: "read" | "write" | "jump" | "none" | null;
  hex: string[];
  symbol: string | null;
  exports: string[];
  exportCount: number;
  abilities: string[];
  aslr: boolean;
  dep: boolean;
  cfg: boolean;
  writableCode: string[];
  packed: string[];
  missing: string[];
  modified: number;
}

/** What Windows wrote down about a crash, beyond its name. */
export interface CrashDetail {
  code: string;
  offset: string;
  stamp: string;
  moduleVersion: string;
  app: string;
  appVersion: string;
}

export const loadRuns = (from: number, to: number) => invoke<Run[]>("timeline_runs", { from: Math.floor(from), to: Math.ceil(to) });
export const loadDeep = (from: number, to: number) => invoke<Deep[]>("timeline_deep", { from: Math.floor(from), to: Math.ceil(to) });
export const loadCode = (path: string, offset?: string, stamp?: string, symbol?: string) => invoke<Code | null>("timeline_code", { path, offset: offset || null, stamp: stamp || null, symbol: symbol || null });

/** A file that takes part: the event's own, or the piece of Windows that does this kind of thing. */
export interface Part {
  path: string;
  role: "module" | "program" | "service" | "driver" | "startup" | "listener" | "api" | "gate" | "kernel" | "system";
  level: LevelId;
  symbol?: string;
  /** The exact place, for a crash. */
  offset?: string;
  stamp?: string;
}

const S32 = "%SystemRoot%\\System32\\";
const DRV = `${S32}drivers\\`;
type Chain = [file: string, role: Part["role"], level: LevelId, symbol?: string][];
/** Which functions of Windows do this kind of thing, from the one programs call down to the kernel's. */
const CHAINS: Record<string, Chain> = {
  start: [[`${S32}kernelbase.dll`, "api", "library", "CreateProcessW"], [`${S32}ntdll.dll`, "gate", "library", "NtCreateUserProcess"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "PsCreateSystemThread"]],
  files: [[`${S32}kernelbase.dll`, "api", "library", "CreateFileW"], [`${S32}ntdll.dll`, "gate", "library", "NtCreateFile"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "NtCreateFile"], [`${DRV}ntfs.sys`, "system", "driver"]],
  driver: [[`${S32}ntdll.dll`, "gate", "library", "NtLoadDriver"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "IoCreateDevice"], [`${DRV}pci.sys`, "system", "driver"]],
  service: [[`${S32}sechost.dll`, "api", "library", "StartServiceW"], [`${S32}services.exe`, "system", "process"], [`${S32}ntdll.dll`, "gate", "library", "NtCreateUserProcess"]],
  net: [[`${S32}ws2_32.dll`, "api", "library", "connect"], [`${S32}ntdll.dll`, "gate", "library", "NtDeviceIoControlFile"], [`${DRV}afd.sys`, "system", "driver"], [`${DRV}tcpip.sys`, "system", "driver"], [`${DRV}ndis.sys`, "system", "driver", "NdisSendNetBufferLists"]],
  power: [[`${S32}powrprof.dll`, "api", "library", "SetSuspendState"], [`${S32}ntdll.dll`, "gate", "library", "NtInitiatePowerAction"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "PoRequestPowerIrp"], [`${DRV}acpi.sys`, "system", "driver"]],
  crash: [[`${S32}ntoskrnl.exe`, "kernel", "kernel", "KeBugCheckEx"], [`${DRV}crashdmp.sys`, "system", "driver"], [`${DRV}acpi.sys`, "system", "driver"]],
  fault: [[`${S32}kernelbase.dll`, "api", "library", "UnhandledExceptionFilter"], [`${S32}ntdll.dll`, "gate", "library", "KiUserExceptionDispatcher"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "ExRaiseStatus"]],
  hang: [[`${S32}user32.dll`, "api", "library", "IsHungAppWindow"], [`${S32}win32u.dll`, "gate", "library", "NtUserGetMessage"], [`${S32}ntdll.dll`, "gate", "library", "NtWaitForSingleObject"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "KeWaitForSingleObject"]],
  heat: [[`${DRV}intelppm.sys`, "system", "driver"], [`${DRV}amdppm.sys`, "system", "driver"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "PoRegisterPowerSettingCallback"], [`${DRV}acpi.sys`, "system", "driver"]],
  memory: [[`${S32}kernelbase.dll`, "api", "library", "VirtualAlloc"], [`${S32}ntdll.dll`, "gate", "library", "NtAllocateVirtualMemory"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "ExAllocatePool2"]],
  disk: [[`${DRV}ntfs.sys`, "system", "driver"], [`${DRV}disk.sys`, "system", "driver"], [`${DRV}stornvme.sys`, "system", "driver"], [`${DRV}storport.sys`, "system", "driver", "StorPortNotification"]],
  guard: [[`${S32}amsi.dll`, "api", "library", "AmsiScanBuffer"], [`${DRV}wd\\WdFilter.sys`, "system", "driver"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "PsSetCreateProcessNotifyRoutine"]],
  update: [[`${S32}wuaueng.dll`, "system", "program"], [`${S32}cabinet.dll`, "api", "library", "FDICopy"], [`${S32}wintrust.dll`, "api", "library", "WinVerifyTrust"]],
  work: [[`${S32}kernelbase.dll`, "api", "library", "ReadFile"], [`${S32}ntdll.dll`, "gate", "library", "NtReadFile"], [`${S32}ntoskrnl.exe`, "kernel", "kernel", "NtReadFile"], [`${DRV}ntfs.sys`, "system", "driver"]],
  graphics: [[`${S32}dxgi.dll`, "api", "library", "CreateDXGIFactory"], [`${S32}d3d12.dll`, "api", "library", "D3D12CreateDevice"], [`${S32}win32u.dll`, "gate", "library", "NtGdiDdDDIPresent"], [`${DRV}dxgkrnl.sys`, "system", "driver"]],
};
const CHAIN_OF: Partial<Record<TimelineEvent["kind"], string>> = { program: "files", startup: "start", service: "service", svccrash: "service", driver: "driver", net: "net", port: "net", power: "power", crash: "crash", appcrash: "fault", hang: "hang", io: "disk", security: "guard", update: "update", delpheye: "files", recorder: "files" };

export function chainOf(event: TimelineEvent | null, run: Run | null): string {
  if (event?.kind === "alert") return event.name.includes("ram") || event.name.includes("commit") ? "memory" : event.name.includes("disk") ? "disk" : "heat";
  if (event?.kind === "crash" && event.name === "gpu") return "graphics";
  if (event) return CHAIN_OF[event.kind] ?? "work";
  return run?.game ? "graphics" : "work";
}

/** Every file that stands behind an event or a moment, from the program down to the drivers. */
export async function partsOf(event: TimelineEvent | null, run: Run | null, fronts: Run[]): Promise<Part[]> {
  const out: Part[] = [];
  const d = crashDetail(event);
  const add = (p: Part) => p.path && !out.some((x) => x.path.toLowerCase() === p.path.toLowerCase() && x.symbol === p.symbol) && out.push(p);
  if (event?.kind === "appcrash") {
    if (event.was?.includes(":")) add({ path: event.was, role: "module", level: "library", offset: d?.offset, stamp: d?.stamp });
    if (d?.app) add({ path: d.app, role: "program", level: "program" });
  } else if (event?.kind === "hang" && event.was?.includes(":")) add({ path: event.was, role: "program", level: "program" });
  else if (event) {
    const found = await invoke<{ path: string; role: Part["role"] }[]>("timeline_parts", { kind: event.kind, name: event.name, now: event.now }).catch(() => []);
    for (const f of found) add({ ...f, level: f.role === "driver" ? "driver" : "program" });
  }
  if (run) add({ path: run.exe, role: "program", level: "program" });
  else if (!event && fronts[0]) add({ path: fronts[0].exe, role: "program", level: "program" });
  for (const [path, role, level, symbol] of CHAINS[chainOf(event, run)]) add({ path, role, level, symbol });
  return out;
}
export const loadMaker = (path: string) => invoke<Maker | null>("timeline_module", { path }).catch(() => null);

export function crashDetail(e: TimelineEvent | null): CrashDetail | null {
  if (!e?.detail) return null;
  try {
    return JSON.parse(e.detail) as CrashDetail;
  } catch {
    return null;
  }
}

/** The machine from the person down to the bits. */
export const LEVELS = ["action", "program", "process", "library", "kernel", "driver", "hardware", "machine"] as const;
export type LevelId = (typeof LEVELS)[number];
export type State = "ok" | "warn" | "bad" | "unknown";

/** A line of a level: an i18n key under timeline.lv.fact, and its values. */
export interface Fact {
  key: string;
  v?: Record<string, string | number>;
  state?: State;
}
export interface LevelView {
  id: LevelId;
  state: State;
  simple: Fact;
  facts: Fact[];
}

export interface Picture {
  levels: LevelView[];
  deep: Deep | null;
  reading: Reading | null;
  code: Code | null;
  maker: Maker | null;
  detail: CrashDetail | null;
  fronts: Run[];
  path: string | null;
  parts: Part[];
}

/** Exception codes whose meaning is certain, whatever their cause. */
export const EXCEPTIONS: Record<string, string> = {
  c0000005: "access",
  c0000006: "inpage",
  c000001d: "illegal",
  c0000094: "divide",
  c00000fd: "stack",
  c0000374: "heap",
  c0000409: "failfast",
  c000012d: "commit",
  c0000135: "nodll",
  c0000142: "init",
  "80000003": "breakpoint",
  e0434352: "dotnet",
  e06d7363: "cpp",
};
export const exceptionOf = (d: CrashDetail | null) => (d ? (EXCEPTIONS[d.code.toLowerCase().replace(/^0x/, "")] ?? "other") : null);

const worse = (a: State, b: State): State => (["unknown", "ok", "warn", "bad"].indexOf(a) > ["unknown", "ok", "warn", "bad"].indexOf(b) ? a : b);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const gb = (mb: number) => (mb / 1024).toFixed(1);
const mbs = (b: number) => (b / 1_048_576).toFixed(1);

/** Everything known about one moment, level by level. What was not recorded stays unknown. */
export async function picture(at: number, o: { event?: TimelineEvent | null; run?: Run | null; all: TimelineEvent[] }): Promise<Picture> {
  const { event = null, run = null, all } = o;
  const [runs, deeps, usual, readings] = await Promise.all([loadRuns(at - 3600, at + 60).catch(() => []), loadDeep(at - 300, at + 120).catch(() => []), loadDeep(at - 86_400, at).catch(() => []), loadReadings(at - 600, at + 120, 60).catch(() => [])]);
  const nearest = <T extends { t: number }>(xs: T[], within: number) => xs.reduce<T | null>((b, x) => (Math.abs(x.t + 30 - at) <= within && (!b || Math.abs(x.t - at) < Math.abs(b.t - at)) ? x : b), null);
  const deep = nearest(deeps, 240);
  const reading = nearest(readings, 420);
  const detail = crashDetail(event);
  const modulePath = event?.kind === "appcrash" ? event.was : null;
  const fronts = runs.filter((r) => r.front > 0 && r.start <= at + 60 && r.end >= at - 60).sort((a, b) => b.front - a.front);
  const parts = await partsOf(event, run, fronts);
  const path = parts[0]?.path ?? null;
  const own = parts[0] && !["api", "gate", "kernel", "system"].includes(parts[0].role);
  const [code, maker] = path ? await Promise.all([loadCode(path, parts[0].offset, parts[0].stamp, parts[0].symbol).catch(() => null), loadMaker(path)]) : [null, null];
  const near = (kinds: string[], back: number) => all.filter((e) => kinds.includes(e.kind) && e.t <= at + 60 && e.t >= at - back && e.id !== event?.id);

  /** Far from what this computer usually does, not from some ideal. */
  const unusual = (get: (d: Deep) => number | null, floor: number): State => {
    const now = deep ? get(deep) : null;
    if (now === null) return "unknown";
    const m = median(usual.map(get).filter((x): x is number => x !== null));
    return now >= floor && m !== null && usual.length >= 30 && now > m * 4 ? "warn" : "ok";
  };
  const lv: LevelView[] = [];
  const add = (id: LevelId, facts: Fact[], simple: Fact, least: State = "unknown") => lv.push({ id, facts, simple, state: facts.reduce<State>((s, f) => worse(s, f.state ?? "unknown"), least) });

  // The person.
  const power = near(["power"], 1800).slice(-1)[0];
  const action: Fact[] = fronts.slice(0, 3).map((r) => ({ key: r.game ? "frontGame" : "front", v: { name: r.title || r.name, min: Math.max(1, Math.round(r.front / 60)) }, state: "ok" }));
  if (power) action.push({ key: `power_${power.name}`, v: { min: Math.max(1, Math.round((at - power.t) / 60)) } });
  const did = near(["delpheye"], 3600).slice(-1)[0];
  if (did) action.push({ key: "did", state: "ok" });
  add("action", action, fronts[0] ? { key: fronts[0].game ? "sGame" : "sFront", v: { name: fronts[0].title || fronts[0].name } } : { key: "sNoFront" });

  // The program.
  const program: Fact[] = [];
  if (event?.kind === "appcrash") {
    program.push({ key: "crashed", v: { name: event.name, version: detail?.appVersion || "?" }, state: "bad" });
    if (detail?.app) program.push({ key: "path", v: { path: detail.app }, state: "ok" });
  } else if (event?.kind === "hang") program.push({ key: "hung", v: { name: event.name }, state: "bad" });
  else if (event?.kind === "svccrash") program.push({ key: "svc", v: { name: event.name, n: event.now ?? "1" }, state: "bad" });
  if (run) {
    program.push({ key: "ran", v: { min: Math.max(1, Math.round((run.end - run.start) / 60)), front: Math.round(run.front / 60) }, state: "ok" }, { key: "used", v: { cpu: run.cpu, mem: gb(run.mem), disk: run.disk }, state: "ok" }, { key: "path", v: { path: run.exe }, state: "ok" });
    if (run.company) program.push({ key: "company", v: { name: run.company }, state: "ok" });
  } else if (!program.length) for (const r of fronts.slice(0, 2)) program.push({ key: "used2", v: { name: r.name, cpu: r.cpu, mem: gb(r.mem) }, state: "ok" });
  const crashes = near(["appcrash", "hang", "svccrash"], 3600);
  if (crashes.length) program.push({ key: "nearCrashes", v: { n: crashes.length, name: crashes[crashes.length - 1].name }, state: "warn" });
  add("program", program, event && ["appcrash", "hang", "svccrash"].includes(event.kind) ? { key: "sProgramBad", v: { name: event.name } } : run ? { key: "sRun", v: { name: run.title || run.name } } : program.length ? { key: "sProgram" } : { key: "sUnknown" });

  // Processes and threads.
  const proc: Fact[] = [];
  if (deep) {
    if (deep.processes !== null) proc.push({ key: "processes", v: { n: deep.processes, threads: deep.threads ?? "?", handles: deep.handles ?? "?" }, state: "ok" });
    if (deep.switches !== null) proc.push({ key: "switches", v: { n: deep.switches }, state: unusual((d) => d.switches, 60_000) });
  }
  add("process", proc, proc.length ? { key: proc.some((f) => f.state === "warn") ? "sProcBusy" : "sProcOk" } : { key: "sUnknown" });

  // Libraries and what the program is made of.
  const lib: Fact[] = [];
  if (event?.kind === "appcrash" && event.now) lib.push({ key: "module", v: { name: event.now, version: detail?.moduleVersion || "?" }, state: "bad" });
  if (!own && path) lib.push({ key: "stands", v: { name: path.split("\\").pop() ?? "" }, state: "ok" });
  if (maker?.exists) lib.push({ key: maker.windows ? "makerWindows" : maker.company ? "maker" : "makerNone", v: { name: maker.company ?? "" }, state: maker.signed === false && own ? "warn" : "ok" });
  if (code) {
    if (code.made.length) lib.push({ key: "made", v: { list: code.made.join(", ") }, state: "ok" });
    lib.push({ key: "built", v: { arch: code.arch, linker: code.linker, mb: mbs(code.size) }, state: "ok" });
    for (const f of health(code, maker, at, event, all, path)) lib.push({ key: `h_${f.key}`, v: f.v, state: f.state });
    for (const i of code.imports.slice(0, 6)) lib.push({ key: "imports", v: { dll: i.dll, n: i.count, names: i.names.slice(0, 3).join(", ") }, state: "ok" });
  } else if (path) lib.push({ key: "noFile", state: "unknown" });
  // The file itself is gone: the next part of the chain that is still here.
  if (!code && path)
    for (const x of parts.slice(1)) {
      const [c, m] = await Promise.all([loadCode(x.path, x.offset, x.stamp, x.symbol).catch(() => null), loadMaker(x.path)]);
      if (!c) continue;
      lib.push({ key: ["api", "gate", "kernel", "system"].includes(x.role) ? "stands" : "beside", v: { name: x.path.split("\\").pop() ?? "" }, state: "ok" });
      for (const f of health(c, m, at, event, all, x.path)) lib.push({ key: `h_${f.key}`, v: f.v, state: f.state });
      for (const i of c.imports.slice(0, 4)) lib.push({ key: "imports", v: { dll: i.dll, n: i.count, names: i.names.slice(0, 3).join(", ") }, state: "ok" });
      break;
    }
  add("library", lib, event?.kind === "appcrash" && event.now ? { key: maker?.exists ? (maker.windows ? "sModuleWindows" : maker.company ? "sModule" : "sModuleNone") : "sModuleGone", v: { name: event.now, company: maker?.company ?? "?" } } : code ? { key: "sMade", v: { list: code.made.length ? code.made.join(", ") : code.arch } } : { key: "sUnknown" });

  // The Windows kernel.
  const ker: Fact[] = [];
  const ex = exceptionOf(detail);
  if (ex && detail) ker.push({ key: `ex_${ex}`, v: { code: `0x${detail.code}` }, state: "bad" });
  if (event?.kind === "crash") ker.push({ key: "stop", state: "bad" });
  if (deep) {
    if (deep.kernel !== null) ker.push({ key: "kernel", v: { k: deep.kernel, u: deep.user ?? 0 }, state: deep.kernel >= 40 ? "warn" : "ok" });
    if (deep.calls !== null) ker.push({ key: "calls", v: { n: deep.calls }, state: unusual((d) => d.calls, 400_000) });
    if (deep.hard !== null) ker.push({ key: "hard", v: { n: deep.hard }, state: deep.hard >= 1500 ? "warn" : "ok" });
    if (deep.commit !== null) ker.push({ key: "commit", v: { n: deep.commit }, state: deep.commit >= 95 ? "bad" : deep.commit >= 88 ? "warn" : "ok" });
  }
  if (near(["alert"], 1800).some((e) => e.name === "commit-full")) ker.push({ key: "exhausted", state: "bad" });
  add("kernel", ker, ex ? { key: `sEx_${ex}` } : event?.kind === "crash" ? { key: "sStop" } : deep ? { key: ker.some((f) => f.state === "warn" || f.state === "bad") ? "sKernelBusy" : "sKernelOk" } : { key: "sUnknown" });

  // Drivers.
  const drv: Fact[] = [];
  for (const e of near(["driver"], 3 * 86_400).slice(-3)) drv.push({ key: "driverNew", v: { name: e.name.split("|")[0], cls: e.name.split("|")[1] ?? "", version: e.now ?? "?", hours: Math.max(1, Math.round((at - e.t) / 3600)) }, state: "warn" });
  for (const e of near(["io"], 86_400)) drv.push({ key: `io_${e.name}`, state: "bad" });
  for (const e of near(["crash"], 86_400).filter((x) => x.name === "gpu")) drv.push({ key: "gpuReset", v: { hours: Math.max(1, Math.round((at - e.t) / 3600)) }, state: "bad" });
  if (!drv.length) drv.push({ key: "driverQuiet", state: "ok" });
  add("driver", drv, drv.some((f) => f.state === "bad") ? { key: "sDriverBad" } : drv.some((f) => f.state === "warn") ? { key: "sDriverNew" } : { key: "sDriverOk" });

  // Hardware. A desktop has no battery; that is not missing data.
  const hw: Fact[] = [];
  if (reading) {
    const temp = reading.cpuTempMax ?? reading.cpuTemp;
    if (reading.cpu !== null) hw.push({ key: "cpu", v: { n: Math.round(reading.cpu) }, state: "ok" });
    if (temp !== null) hw.push({ key: "temp", v: { n: Math.round(temp) }, state: reading.hot > 0 || temp >= 97 ? "bad" : temp >= 90 ? "warn" : "ok" });
    if (reading.gpu !== null) hw.push({ key: "gpu", v: { n: Math.round(reading.gpu), t: reading.gpuTemp === null ? "?" : Math.round(reading.gpuTemp) }, state: (reading.gpuTemp ?? 0) >= 87 ? "bad" : "ok" });
    if (reading.ram !== null) hw.push({ key: "ram", v: { n: Math.round(reading.ram) }, state: reading.ram >= 93 ? "bad" : reading.ram >= 85 ? "warn" : "ok" });
    if (reading.freeMb !== null) hw.push({ key: "free", v: { n: gb(reading.freeMb) }, state: reading.freeMb < 5120 ? "bad" : reading.freeMb < 15_360 ? "warn" : "ok" });
  }
  if (deep) {
    if (deep.read !== null) hw.push({ key: "disk", v: { r: mbs(deep.read), w: mbs(deep.write ?? 0) }, state: "ok" });
    if (deep.mains !== null && deep.battery !== null) hw.push({ key: deep.mains ? "mains" : "onBattery", v: { n: deep.battery }, state: !deep.mains && deep.battery <= 7 ? "bad" : "ok" });
    else if (deep.mains) hw.push({ key: "mainsOnly", state: "ok" });
  }
  const bad = hw.find((f) => f.state === "bad") ?? hw.find((f) => f.state === "warn");
  add("hardware", hw, !hw.length ? { key: "sUnknown" } : bad ? { key: `sHw_${bad.key}`, v: bad.v } : { key: "sHwOk" });

  // Machine code.
  const mac: Fact[] = [];
  if (detail && modulePath) {
    mac.push({ key: "address", v: { module: event?.now ?? "", offset: detail.offset.replace(/^0+(?=.)/, "") }, state: "bad" });
    if (code?.same === false) mac.push({ key: "changed", state: "unknown" });
    if (code?.function) mac.push({ key: "function", v: { a: code.function[0], b: code.function[1] }, state: "ok" });
    if (ex === "access" && code?.access && code.access !== "none") mac.push({ key: `access_${code.access}`, state: "bad" });
  } else if (code?.lines.length) mac.push({ key: code.symbol ? "symbol" : "entry", v: { name: code.symbol ?? "" }, state: "ok" });
  add("machine", mac, detail && modulePath ? { key: code?.same === false ? "sChanged" : code?.lines.length && ex && ["failfast", "dotnet", "cpp", "breakpoint"].includes(ex) ? "sSelf" : code?.lines.length ? (code.access && code.access !== "none" && ex === "access" ? `sAccess_${code.access}` : "sInstruction") : "sNoCode" } : code?.lines.length ? { key: own ? "sEntry" : "sSystem" } : { key: "sNoMachine" });

  return { levels: lv, deep, reading, code, maker, detail, fronts, path, parts };
}

/** What is and is not wrong with a file, as far as the file itself and the log can tell. */
export function health(c: Code, maker: Maker | null, at: number, event: TimelineEvent | null, all: TimelineEvent[], path: string | null): Fact[] {
  const out: Fact[] = [];
  const file = (path ?? "").split("\\").pop()?.toLowerCase() ?? "";
  const crashes = all.filter((e) => (e.kind === "appcrash" && (e.now?.toLowerCase() === file || e.name.toLowerCase() === file)) || (e.kind === "hang" && e.name.toLowerCase() === file));
  const others = crashes.filter((e) => e.id !== event?.id);
  // A library everything uses is where other programs' mistakes surface.
  out.push(others.length ? { key: maker?.windows ? "crashesWindows" : "crashes", v: { n: others.length }, state: maker?.windows ? "ok" : others.length >= 3 ? "bad" : "warn" } : { key: "noCrashes", state: "ok" });
  if (c.missing.length) out.push({ key: "missing", v: { list: c.missing.slice(0, 3).join(" · ") }, state: "unknown" });
  else out.push({ key: "allThere", state: "ok" });
  if (maker?.signed === false && !maker.windows) out.push({ key: "unsigned", state: "warn" });
  else if (maker?.signed) out.push({ key: "signed", state: "ok" });
  if (c.writableCode.length) out.push({ key: "rwx", v: { list: c.writableCode.join(" · ") }, state: "warn" });
  if (c.packed.length) out.push({ key: "packed", v: { list: c.packed.join(" · ") }, state: "warn" });
  // Drivers are protected by the kernel itself: these marks mean nothing in them.
  const driver = file.endsWith(".sys");
  const off = driver ? [] : [!c.aslr && "ASLR", !c.dep && "DEP", !c.cfg && "CFG"].filter(Boolean) as string[];
  if (!driver) out.push(off.length ? { key: "guardsOff", v: { list: off.join(" · ") }, state: off.includes("ASLR") || off.includes("DEP") ? "warn" : "ok" } : { key: "guardsOn", state: "ok" });
  if (c.modified && c.modified > at + 60) out.push({ key: "newer", v: { date: new Date(c.modified * 1000).toLocaleDateString() }, state: "unknown" });
  return out;
}

// ───────────────────────── where to look ─────────────────────────

/** "certain": Windows' own record says so. "direction": the evidence points at a level. "unknown": it does not. */
export interface Direction {
  sure: "certain" | "direction" | "unknown";
  level: LevelId;
  key: string;
  v?: Record<string, string>;
}

const CAUSES: Record<string, LevelId> = {
  "bluescreen-driver": "driver",
  "bluescreen-hardware": "hardware",
  "bluescreen-memory": "hardware",
  "bluescreen-disk": "hardware",
  "bluescreen-gpu": "driver",
  bluescreen: "kernel",
  hardware: "hardware",
  overheat: "hardware",
  battery: "hardware",
  "firmware-reset": "hardware",
  "power-cut": "hardware",
  "gpu-driver": "driver",
  freeze: "kernel",
  sleep: "driver",
};

export function direction(e: TimelineEvent, p: Picture): Direction {
  if (e.kind === "crash") {
    const [cause, confidence] = (e.now ?? "").split("|");
    const level = CAUSES[cause];
    if (level) return { sure: confidence === "certain" ? "certain" : "direction", level, key: "verdict", v: { cause } };
    const weak = [...p.levels].reverse().find((l) => l.state === "bad" && l.id !== "kernel");
    return weak ? { sure: "direction", level: weak.id, key: "weak" } : { sure: "unknown", level: "hardware", key: "shutdownUnknown" };
  }
  if (e.kind === "io") return { sure: "certain", level: "hardware", key: `io_${e.name}` };
  if (e.kind === "alert") return { sure: "certain", level: e.name === "commit-full" || e.name === "ram-full" ? "kernel" : "hardware", key: `alert_${e.name}` };
  if (e.kind === "svccrash") return { sure: "direction", level: "program", key: "service", v: { name: e.name } };
  if (e.kind === "hang") return { sure: "direction", level: "program", key: "hang" };
  const ex = exceptionOf(p.detail);
  if (ex === "inpage") return { sure: "direction", level: "hardware", key: "inpage" };
  if (ex === "illegal") return { sure: "direction", level: "hardware", key: "illegal" };
  if (ex === "commit") return { sure: "certain", level: "kernel", key: "commit" };
  if (ex === "dotnet") return { sure: "direction", level: "program", key: "dotnet" };
  if (ex === "nodll" || ex === "init") return { sure: "direction", level: "library", key: "nodll" };
  const folder = (s: string) => s.toLowerCase().replace(/[^\\/]+$/, "");
  const own = p.detail?.app && e.was && (folder(e.was).startsWith(folder(p.detail.app)) || e.was.toLowerCase() === p.detail.app.toLowerCase());
  if (own) return { sure: "direction", level: "program", key: "own", v: { name: e.name } };
  if (p.maker?.windows) return { sure: "direction", level: "program", key: "throughWindows", v: { module: e.now ?? "" } };
  if (p.maker?.exists && p.maker.company) return { sure: "direction", level: "library", key: "foreign", v: { module: e.now ?? "", company: p.maker.company ?? "?" } };
  return { sure: "unknown", level: "program", key: "appUnknown" };
}

// ───────────────────────── the story of a stretch of time ─────────────────────────

export interface Beat {
  t: number;
  id: string;
  kind: "run" | "end" | "event" | "change";
  event?: TimelineEvent;
  run?: Run;
  /** For readings: what changed and from what to what. */
  key?: string;
  v?: Record<string, string | number>;
  bad?: boolean;
}

/** A stretch of time as what happened in it, in order. */
export function story(from: number, to: number, events: TimelineEvent[], runs: Run[], readings: Reading[]): Beat[] {
  const out: Beat[] = [];
  for (const e of events) if (e.t >= from && e.t <= to && !e.dayOnly) out.push({ t: e.t, id: e.id, kind: "event", event: e, bad: ["crash", "appcrash", "hang", "svccrash", "io", "alert"].includes(e.kind) });
  for (const r of runs) {
    if (r.front < 15 && !r.game && r.cpu < 5) continue;
    if (r.start >= from && r.start <= to) out.push({ t: r.start, id: `r${r.exe}${r.start}`, kind: "run", run: r });
    if (r.end >= from && r.end < to - 60) out.push({ t: r.end, id: `x${r.exe}${r.start}`, kind: "end", run: r });
  }
  // Readings are steady most of the time: only a real move is told, and its return.
  const watch = [
    { id: "gpu", get: (r: Reading) => r.gpu, move: 35 },
    { id: "cpu", get: (r: Reading) => r.cpu, move: 35 },
    { id: "temp", get: (r: Reading) => r.cpuTempMax ?? r.cpuTemp, move: 14 },
    { id: "ram", get: (r: Reading) => r.ram, move: 15 },
  ];
  for (const w of watch) {
    let base: number | null = null;
    let last = 0;
    for (const r of readings) {
      const v = w.get(r);
      if (r.t < from || r.t > to || v === null) continue;
      if (base === null) base = v;
      if (Math.abs(v - base) >= w.move && r.t - last >= 180) {
        out.push({ t: r.t + 30, id: `${w.id}${r.t}`, kind: "change", key: `${w.id}${v > base ? "Up" : "Down"}`, v: { a: Math.round(base), b: Math.round(v) }, bad: w.id === "temp" && v >= 92 });
        base = v;
        last = r.t;
      } else if (Math.abs(v - base) < w.move) base = base * 0.9 + v * 0.1;
    }
  }
  let hot = false;
  for (const r of readings) {
    if (r.t < from || r.t > to) continue;
    if (r.hot > 0 && !hot) out.push({ t: r.t + 40, id: `hot${r.t}`, kind: "change", key: "throttle", bad: true });
    hot = r.hot > 0;
  }
  return out.sort((a, b) => a.t - b.t);
}
