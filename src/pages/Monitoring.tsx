import { HistoryTab } from "./monitor/History";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  AlertTriangle,
  Battery,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Fan,
  Flame,
  Gauge,
  History,
  HardDrive,
  HelpCircle,
  MemoryStick,
  MonitorCog,
  Moon,
  Play,
  PlugZap,
  ShieldAlert,
  Square,
  XCircle,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button, Card } from "../components/ui";
import { LineChart, SERIES_COLORS, type Series } from "../components/LineChart";
import { relaunchElevated } from "../lib/app";
import { useFmt } from "../lib/format";
import {
  ACPI_TEMP,
  cancelStress,
  find,
  isGpu,
  loadCooling,
  loadGpus,
  loadStatus,
  runQuick,
  runStress,
  useMonitor,
  type Check,
  type Frame,
  type Hardware,
  type Level,
  type Point,
  type StressOptions,
  type StressPlan,
  type ThrottleState,
} from "../lib/monitor";

const UNITS: Record<string, string> = {
  Temperature: "°C",
  Fan: "rpm",
  Control: "%",
  Load: "%",
  Clock: "MHz",
  Power: "W",
  Voltage: "V",
  Current: "A",
  Data: "GB",
  SmallData: "MB",
  Energy: "mWh",
  Level: "%",
  Throughput: "B/s",
  Frequency: "Hz",
};

const LEVEL_ICON: Record<Level, LucideIcon> = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle, unknown: HelpCircle };
const LEVEL_TONE: Record<Level, string> = { ok: "text-safe", warn: "text-warn", bad: "text-risk", unknown: "text-muted" };

function useNumber() {
  const { i18n } = useTranslation();
  const locale = i18n.language.startsWith("uk") ? "uk-UA" : "en-US";
  return (value: number, type: string) => {
    const digits = type === "Voltage" || type === "Current" ? 2 : type === "Power" || type === "Data" ? 1 : 0;
    const text = new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
    return `${text} ${UNITS[type] ?? ""}`.trim();
  };
}

function Reading({ label, value, hint }: { label: string; value: string | null; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[13px]" title={hint}>
      <span className="text-muted">{label}</span>
      <span className="num">{value ?? "—"}</span>
    </div>
  );
}

function AdminBanner({ text }: { text: string }) {
  const { t } = useTranslation();
  const [declined, setDeclined] = useState(false);
  return (
    <div className="flex items-center gap-4 rounded-card border border-warn/25 bg-warn/[0.06] px-5 py-3">
      <ShieldAlert size={18} className="shrink-0 text-warn" />
      <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">{declined ? t("cleanup.adminDeclined") : text}</p>
      <Button onClick={async () => setDeclined(!(await relaunchElevated()))}>{t("cleanup.adminAction")}</Button>
    </div>
  );
}

const THROTTLE_ICON: Record<ThrottleState, LucideIcon> = { full: Zap, power: PlugZap, thermal: Flame, idle: Moon, unknown: HelpCircle };
const THROTTLE_TONE: Record<ThrottleState, string> = { full: "text-safe", power: "text-accent", thermal: "text-warn", idle: "text-muted", unknown: "text-muted" };
const THROTTLE_FILL: Record<ThrottleState, string> = { full: "bg-safe", power: "bg-accent", thermal: "bg-warn", idle: "bg-muted/40", unknown: "bg-muted/40" };

/** "40 с", "12 хв", "1 год 5 хв". */
function useDuration() {
  const { t } = useTranslation();
  return (seconds: number) => {
    if (seconds < 60) return t("monitor.dur.s", { n: seconds });
    const m = Math.round(seconds / 60);
    return m < 60 ? t("monitor.dur.m", { n: m }) : t("monitor.dur.hm", { h: Math.floor(m / 60), m: m % 60 });
  };
}

/** The processor card is about throttling: whether it runs as fast as it can, and if not, why. */
function CpuCard({ hw, frame }: { hw: Hardware; frame: Frame }) {
  const { t } = useTranslation();
  const num = useNumber();
  const dur = useDuration();
  const th = frame.throttle;
  const state: ThrottleState = th?.state ?? "unknown";
  const Icon = THROTTLE_ICON[state];
  const load = th?.load ?? find(hw, "Load", "CPU Total")?.value ?? null;
  const busy = state === "full" || state === "power" || state === "thermal";
  const hint =
    state === "thermal" && th?.firmwareCap
      ? t("monitor.throttleHint.thermalCap", { cap: Math.round(th.firmwareCap) })
      : state === "power" && th?.onBattery
        ? t("monitor.throttleHint.powerBattery")
        : t(`monitor.throttleHint.${state}`, { temp: th?.temp ? Math.round(th.temp) : "—" });
  const fill = busy ? (th?.speed ?? 0) : th?.mhz && th.peakMhz ? Math.min(100, (th.mhz / th.peakMhz) * 100) : 0;
  return (
    <Card title={hw.name} icon={<Cpu size={15} />}>
      <div className="mb-3 flex items-start gap-3" data-testid="throttle-state">
        <motion.div
          key={state}
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ type: "spring", stiffness: 380, damping: 22 }}
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-raised ${THROTTLE_TONE[state]}`}
        >
          <Icon size={19} />
        </motion.div>
        <div className="min-w-0">
          <div className="font-display text-[18px] font-semibold leading-tight">{t(`monitor.throttle.${state}`)}</div>
          <p className="mt-0.5 text-[11px] leading-snug text-muted">{hint}</p>
        </div>
      </div>
      <div className="mb-3">
        <div className="mb-1 flex justify-between gap-2 text-[11px] text-muted">
          <span>{busy && th?.speed !== null && th?.speed !== undefined ? t("monitor.speed", { speed: th.speed }) : t("monitor.speedIdle")}</span>
          {th?.peakMhz ? <span className="num shrink-0">{t("monitor.best", { value: (th.peakMhz / 1000).toFixed(2) })}</span> : null}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-raised">
          <motion.div className={`h-full rounded-full ${THROTTLE_FILL[state]}`} animate={{ width: `${fill}%` }} transition={{ type: "spring", stiffness: 120, damping: 20 }} />
        </div>
      </div>
      <div className="space-y-1.5">
        <Reading label={t("monitor.actualClock")} value={th?.mhz ? `${(th.mhz / 1000).toFixed(2)} ${t("monitor.ghz")}` : null} hint={t("monitor.actualClockHint")} />
        <Reading
          label={t("monitor.cpuTempShort")}
          value={th?.temp ? `${Math.round(th.temp)} °C${th.tempSource === "acpi" ? " · ACPI" : ""}` : null}
          hint={th?.tempSource === "acpi" ? t("monitor.acpiHint") : undefined}
        />
        <Reading label={t("monitor.load")} value={load !== null ? num(load, "Load") : null} />
      </div>
      {th && th.session.busy >= 30 && (
        <p className="mt-3 text-[11px] leading-relaxed text-muted" data-testid="throttle-session">
          {t("monitor.sessionLine", { busy: dur(th.session.busy), full: dur(th.session.full), power: dur(th.session.power), thermal: dur(th.session.thermal) })}
        </p>
      )}
    </Card>
  );
}

function GpuCard({ hw }: { hw: Hardware }) {
  const { t } = useTranslation();
  const num = useNumber();
  const temp = find(hw, "Temperature", "GPU Core");
  const hotspot = find(hw, "Temperature", "GPU Hot Spot");
  const load = find(hw, "Load", "GPU Core", "D3D 3D");
  const clock = find(hw, "Clock", "GPU Core");
  const power = find(hw, "Power", "GPU Package", "GPU Power");
  const used = find(hw, "SmallData", "GPU Memory Used", "D3D Dedicated Memory Used");
  const total = find(hw, "SmallData", "GPU Memory Total");
  return (
    <Card title={hw.name} icon={<MonitorCog size={15} />}>
      <div className="mb-3 flex items-baseline gap-1">
        <span className="font-display text-[30px] font-semibold leading-none">{temp ? Math.round(temp.value) : "—"}</span>
        <span className="text-muted">°C</span>
        {hotspot && <span className="num ml-auto text-[12px] text-muted">{t("monitor.hotspot", { value: Math.round(hotspot.value) })}</span>}
      </div>
      <div className="space-y-1.5">
        <Reading label={t("monitor.load")} value={load ? num(load.value, "Load") : null} />
        <Reading label={t("monitor.clock")} value={clock ? num(clock.value, "Clock") : null} />
        <Reading label={t("monitor.power")} value={power ? num(power.value, "Power") : null} />
        <Reading label={t("monitor.vram")} value={used ? `${Math.round(used.value)}${total ? ` / ${Math.round(total.value)}` : ""} MB` : null} />
      </div>
    </Card>
  );
}

function MemoryCard({ hw }: { hw: Hardware }) {
  const { t } = useTranslation();
  const num = useNumber();
  const used = find(hw, "Data", "Memory Used");
  const free = find(hw, "Data", "Memory Available");
  const load = find(hw, "Load", "Memory");
  return (
    <Card title={t("monitor.memory")} icon={<MemoryStick size={15} />}>
      <div className="mb-3 flex items-baseline gap-1">
        <span className="font-display text-[30px] font-semibold leading-none">{load ? Math.round(load.value) : "—"}</span>
        <span className="text-muted">%</span>
      </div>
      <div className="space-y-1.5">
        <Reading label={t("monitor.used")} value={used ? num(used.value, "Data") : null} />
        <Reading label={t("monitor.free")} value={free ? num(free.value, "Data") : null} />
      </div>
    </Card>
  );
}

function BatteryCard({ hw }: { hw: Hardware }) {
  const { t } = useTranslation();
  const num = useNumber();
  const charge = find(hw, "Level", "Charge Level");
  const design = find(hw, "Energy", "Designed Capacity");
  const full = find(hw, "Energy", "Fully-Charged Capacity", "Full Charged Capacity", "Full");
  const rate = find(hw, "Power", "Charge/Discharge Rate", "Charge Rate", "Discharge Rate");
  const wear = design && full && design.value > 0 ? Math.max(0, (1 - full.value / design.value) * 100) : null;
  return (
    <Card title={t("monitor.battery")} icon={<Battery size={15} />}>
      <div className="mb-3 flex items-baseline gap-1">
        <span className="font-display text-[30px] font-semibold leading-none">{charge ? Math.round(charge.value) : "—"}</span>
        <span className="text-muted">%</span>
      </div>
      <div className="space-y-1.5">
        <Reading label={t("monitor.wear")} value={wear !== null ? num(wear, "Power").replace(" W", " %") : null} hint={t("monitor.wearHint")} />
        <Reading label={t("monitor.capacity")} value={full ? `${num(full.value, "Energy").replace(" mWh", "")}${design ? ` / ${num(design.value, "Energy")}` : ""}` : null} />
        <Reading
          label={!rate || rate.value === 0 ? t("monitor.rate") : rate.value > 0 ? t("monitor.charging") : t("monitor.discharge")}
          value={rate ? num(Math.abs(rate.value), "Power") : null}
        />
      </div>
    </Card>
  );
}

function FansCard({ frame }: { frame: Frame }) {
  const { t } = useTranslation();
  const fans = frame.hardware.flatMap((hw) => hw.sensors.filter((s) => s.type === "Fan").map((s) => ({ hw, s })));
  return (
    <Card title={t("monitor.fans")} icon={<Fan size={15} />}>
      {fans.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-muted">{t(frame.elevated ? "monitor.noFansElevated" : "monitor.noFans")}</p>
      ) : (
        <ul className="space-y-1.5">
          {fans.map(({ hw, s }) => (
            <li key={s.id}>
              <Reading label={`${s.name} · ${hw.name}`} value={`${Math.round(s.value)} ${t("monitor.rpm")}`} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DisksCard({ frame }: { frame: Frame }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  return (
    <Card title={t("monitor.disks")} icon={<HardDrive size={15} />}>
      <ul className="space-y-2">
        {frame.disks.map((disk) => {
          const level: Level = disk.health === "healthy" ? "ok" : disk.health === "warning" ? "warn" : disk.health === "unhealthy" ? "bad" : "unknown";
          const Icon = LEVEL_ICON[level];
          const storage = frame.hardware.find((h) => h.type === "Storage" && (h.name.includes(disk.name) || disk.name.includes(h.name)));
          const temp = find(storage, "Temperature", "Temperature");
          return (
            <li key={disk.name} className="text-[13px]">
              <div className="flex items-center gap-2">
                <Icon size={14} className={LEVEL_TONE[level]} />
                <span className="min-w-0 flex-1 truncate">{disk.name}</span>
                <span className="num text-[12px] text-muted">{fmt.bytes(disk.size)}</span>
              </div>
              <div className="pl-[22px] text-[12px] text-muted">
                {t(`monitor.diskHealth.${disk.health}`)}
                {temp && ` · ${Math.round(temp.value)} °C`}
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Up to four temperature series, most important first. */
function useTemperatureSeries(frame: Frame | null, history: Record<string, number[]>): Series[] {
  return useMemo(() => {
    if (!frame) return [];
    const picks: { id: string; name: string }[] = [];
    for (const hw of frame.hardware) {
      const want =
        hw.type === "Cpu" ? ["CPU Package", "Core Max"] : isGpu(hw) ? ["GPU Core"] : hw.type === "Storage" ? ["Temperature"] : [];
      for (const name of want) {
        const s = hw.sensors.find((x) => x.type === "Temperature" && x.name === name);
        if (s) {
          picks.push({ id: s.id, name: `${hw.name.replace(/\(R\)|\(TM\)|Laptop GPU/g, "").trim()}` });
          break;
        }
      }
    }
    const cpu = frame.hardware.find((h) => h.type === "Cpu");
    if (frame.throttle?.tempSource === "acpi") picks.unshift({ id: ACPI_TEMP, name: `${cpu ? cpu.name.replace(/\(R\)|\(TM\)/g, "").trim() : "CPU"} · ACPI` });
    return picks.slice(0, 4).map((p, i) => ({ ...p, color: SERIES_COLORS[i], values: history[p.id] ?? [] }));
  }, [frame, history]);
}

function AllSensors({ frame }: { frame: Frame }) {
  const { t } = useTranslation();
  const num = useNumber();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      {frame.hardware
        .filter((hw) => hw.sensors.length > 0)
        .map((hw) => (
          <div key={hw.id} className="border-b border-line last:border-b-0">
            <button className="flex w-full items-center gap-3 px-5 py-3 text-left text-[13px] hover:bg-raised/40" onClick={() => setOpen(open === hw.id ? null : hw.id)} aria-expanded={open === hw.id}>
              <span className="min-w-0 flex-1 truncate font-medium">
                {hw.name}
                {hw.parent && <span className="ml-2 text-[11px] font-normal text-muted">{hw.parent}</span>}
              </span>
              <span className="text-[11px] text-muted">{t("monitor.sensorCount", { count: hw.sensors.length })}</span>
              <motion.span animate={{ rotate: open === hw.id ? 180 : 0 }} className="text-muted">
                <ChevronDown size={15} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {open === hw.id && (
                <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
                  <table className="w-full border-t border-line/60 bg-bg/40 text-[12px]">
                    <tbody>
                      {hw.sensors.map((s) => (
                        <tr key={s.id} className="border-b border-line/40 last:border-b-0">
                          <td className="px-5 py-1.5 text-muted">{t(`monitor.type.${s.type}`, { defaultValue: s.type })}</td>
                          <td className="py-1.5">{s.name}</td>
                          <td className="num px-5 py-1.5 text-right">{num(s.value, s.type)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}
    </div>
  );
}

function SensorsTab() {
  const { t } = useTranslation();
  const { frame, history, status } = useMonitor();
  const temps = useTemperatureSeries(frame, history);
  const fanSeries: Series[] = useMemo(() => {
    if (!frame) return [];
    return frame.hardware
      .flatMap((hw) => hw.sensors.filter((s) => s.type === "Fan").map((s) => ({ hw, s })))
      .slice(0, 4)
      .map(({ hw, s }, i) => ({ id: s.id, name: `${s.name} · ${hw.name}`, color: SERIES_COLORS[i], values: history[s.id] ?? [] }));
  }, [frame, history]);

  if (status?.sensors.problem === "missing" || status?.sensors.problem === "failed") {
    return <p className="rounded-card border border-line bg-surface px-5 py-4 text-[13px] text-muted">{t(`monitor.problem.${status.sensors.problem}`)}</p>;
  }
  if (!frame) {
    return (
      <div className="flex flex-col items-center py-16 text-[13px] text-muted">
        <motion.div className="mb-4 h-10 w-10 rounded-full border-4 border-raised border-t-accent" animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} />
        {t("monitor.starting")}
      </div>
    );
  }
  const cpu = frame.hardware.find((h) => h.type === "Cpu");
  const gpus = frame.hardware.filter(isGpu);
  const memory = frame.hardware.find((h) => h.type === "Memory" && h.name.includes("Total")) ?? frame.hardware.find((h) => h.type === "Memory");
  const battery = frame.hardware.find((h) => h.type === "Battery");

  return (
    <div className="space-y-4">
      {!frame.elevated && <AdminBanner text={t("monitor.adminText")} />}
      <motion.div initial="hidden" animate="show" variants={{ show: { transition: { staggerChildren: 0.04 } } }} className="grid grid-cols-3 gap-4">
        {cpu && <CpuCard hw={cpu} frame={frame} />}
        {gpus.map((gpu) => (
          <GpuCard key={gpu.id} hw={gpu} />
        ))}
        {memory && <MemoryCard hw={memory} />}
        {battery && <BatteryCard hw={battery} />}
        <FansCard frame={frame} />
        {frame.disks.length > 0 && <DisksCard frame={frame} />}
      </motion.div>

      {temps.length > 0 && (
        <Card title={t("monitor.tempChart")} icon={<Gauge size={15} />}>
          <LineChart series={temps} format={(v) => `${Math.round(v)}°`} label={t("monitor.tempChart")} minRange={10} />
          <p className="mt-1 text-right text-[11px] text-muted">{t("monitor.lastMinutes")}</p>
        </Card>
      )}
      {fanSeries.length > 0 && (
        <Card title={t("monitor.fanChart")} icon={<Fan size={15} />}>
          <LineChart series={fanSeries} format={(v) => `${Math.round(v)}`} label={t("monitor.fanChart")} minRange={400} floor={0} />
        </Card>
      )}

      <h2 className="px-1 pt-2 text-[11px] uppercase tracking-wider text-muted">{t("monitor.allSensors")}</h2>
      <AllSensors frame={frame} />
    </div>
  );
}

/** Rounds the numbers in a check's values so they read well inside sentences. */
function readable(values: Check["values"]) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values ?? {})) out[k] = typeof v === "number" ? (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10) : v;
  return out;
}

interface Incident {
  at: string;
  kind: "shutdown" | "bluescreen" | "whea" | "gpu";
  cause: string | null;
  code: string | null;
  detail: string | null;
}

const GPU_DRIVERS: Record<string, string> = { nvlddmkm: "NVIDIA", igdkmd64: "Intel", igdkmdn64: "Intel", igdkmdnd64: "Intel", amdkmdag: "AMD", atikmdag: "AMD" };

/** One line per incident: when, and what probably happened. */
function IncidentLine({ e }: { e: Incident }) {
  const { t, i18n } = useTranslation();
  const stop = (code: string) => (i18n.exists(`monitor.stop.${code}.name`) ? t(`monitor.stop.${code}.name`) : code);
  const when = new Date(e.at).toLocaleString(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  let text: ReactNode;
  if (e.kind === "shutdown") text = <>{t(`monitor.cause.${e.cause ?? "unknown"}`, { time: e.detail?.slice(11, 16) ?? "?" })}{e.code ? ` · ${stop(e.code)}` : ""}</>;
  else if (e.kind === "bluescreen")
    text = (
      <>
        <span className="text-fg">{e.code ? stop(e.code) : t("monitor.stop.unknownName")}</span>
        {e.code && <span className="num ml-1.5 text-[11px]">{e.code}</span>}
        <span className="block">{e.code && i18n.exists(`monitor.stop.${e.code}.text`) ? t(`monitor.stop.${e.code}.text`) : t("monitor.stop.unknownText")}</span>
      </>
    );
  else if (e.kind === "whea")
    text = (
      <>
        {t(`monitor.whea.${e.cause ?? "other"}`)}
        {e.cause !== "boot-record" && <> · {t(e.code === "fatal" ? "monitor.wheaFatal" : "monitor.wheaCorrected")}</>}
        {e.detail && <span className="num ml-1.5 text-[11px]">{e.cause === "boot-record" ? `· ${t("monitor.failedAt", { time: e.detail.slice(11, 16) })}` : e.detail}</span>}
      </>
    );
  else {
    const driver = e.detail ? (GPU_DRIVERS[e.detail.toLowerCase()] ?? e.detail) : null;
    text = driver ? t("monitor.gpuReset", { driver }) : t("monitor.gpuResetUnknown");
  }
  return (
    <li className="grid grid-cols-[150px_1fr] gap-3 py-1.5">
      <span className="num text-[11px] text-muted">{when}</span>
      <span className="leading-relaxed">{text}</span>
    </li>
  );
}

/** For shutdowns: how many had which cause, the most telling summary there is. */
function causeSummary(events: Incident[], t: TFunction) {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.cause ?? "unknown", (counts.get(e.cause ?? "unknown") ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${t(`monitor.causeShort.${cause}`)} — ${n}`).join(" · ");
}

function CheckRow({ check }: { check: Check }) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const Icon = LEVEL_ICON[check.level];
  const values = readable(check.values);
  const events = ((check.values as { events?: Incident[] } | null)?.events ?? []) as Incident[];
  const [all, setAll] = useState(false);
  const hasExplain = i18n.exists(`monitor.explain.${check.id}.what`);
  return (
    <li className="border-b border-line last:border-b-0" data-testid={`check-${check.id}`}>
      <button className="flex w-full gap-3.5 px-5 py-3 text-left transition-colors hover:bg-raised/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon size={18} className={`mt-0.5 shrink-0 ${LEVEL_TONE[check.level]}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium">
            {t(`monitor.check.${check.id}`)}
            {check.subject && <span className="truncate text-[12px] font-normal text-muted">{check.subject}</span>}
            <span className={`ml-auto shrink-0 text-[11px] font-normal ${LEVEL_TONE[check.level]}`}>{t(`monitor.level.${check.level}`)}</span>
          </div>
          <ul className="mt-0.5 space-y-0.5 text-[12px] leading-relaxed text-muted">
            {check.reasons.map((reason) => (
              <li key={reason}>{t(`monitor.reason.${reason}`, values)}</li>
            ))}
          </ul>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="mt-0.5 shrink-0 text-muted">
          <ChevronDown size={15} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ type: "spring", stiffness: 380, damping: 36 }} className="overflow-hidden">
            <div className="space-y-3.5 border-t border-line/60 bg-bg/40 py-3.5 pl-[52px] pr-5 text-[12px]" data-testid={`check-detail-${check.id}`}>
              {hasExplain && (
                <section>
                  <h4 className="mb-1 text-[11px] uppercase tracking-wider text-muted">{t("monitor.whatItMeans")}</h4>
                  <p className="max-w-[95ch] leading-relaxed">{t(`monitor.explain.${check.id}.what`)}</p>
                </section>
              )}
              {events.length > 0 && (
                <section>
                  <h4 className="mb-1 text-[11px] uppercase tracking-wider text-muted">{t("monitor.whatHappened", { count: events.length })}</h4>
                  {check.id === "shutdowns" && <p className="mb-1 text-muted">{causeSummary(events, t)}</p>}
                  <ul className="divide-y divide-line/40">
                    {(all ? events : events.slice(0, 6)).map((e, i) => (
                      <IncidentLine key={`${e.at}-${i}`} e={e} />
                    ))}
                  </ul>
                  {events.length > 6 && (
                    <button className="mt-1 text-accent hover:underline" onClick={() => setAll(!all)}>
                      {all ? t("monitor.showLess") : t("monitor.showAll", { count: events.length })}
                    </button>
                  )}
                </section>
              )}
              {hasExplain && (
                <section>
                  <h4 className="mb-1 text-[11px] uppercase tracking-wider text-muted">{t("monitor.whatToDo")}</h4>
                  <p className="max-w-[95ch] leading-relaxed">{t(`monitor.explain.${check.id}.todo`)}</p>
                </section>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

const GROUPS: { key: string; ids: string[] }[] = [
  { key: "crashes", ids: ["bluescreens", "shutdowns", "hardware-errors", "gpu-resets", "crashes"] },
  { key: "storage", ids: ["disk"] },
  { key: "power", ids: ["battery"] },
  { key: "cooling", ids: ["fan", "fans"] },
];

export function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface">
      {checks.map((check, i) => (
        <CheckRow key={`${check.id}-${check.subject ?? i}`} check={check} />
      ))}
    </ul>
  );
}

function PhaseBar({ points, plan }: { points: Point[]; plan: StressPlan }) {
  const { t } = useTranslation();
  const parts = [
    { phase: "idle", seconds: plan.idle },
    { phase: "load", seconds: plan.load },
    { phase: "cool", seconds: plan.cool },
  ];
  const total = plan.idle + plan.load + plan.cool;
  const done = points.length;
  return (
    <div>
      <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full">
        {parts.map((p, i) => {
          const before = parts.slice(0, i).reduce((a, x) => a + x.seconds, 0);
          const fill = Math.min(1, Math.max(0, (done - before) / p.seconds));
          return (
            <div key={p.phase} className="relative h-full overflow-hidden bg-raised" style={{ width: `${(p.seconds / total) * 100}%` }}>
              <motion.div className={`h-full ${p.phase === "load" ? "bg-warn" : "bg-accent"}`} animate={{ width: `${fill * 100}%` }} transition={{ duration: 0.4 }} />
            </div>
          );
        })}
      </div>
      <div className="mt-1.5 flex text-[11px] text-muted">
        {parts.map((p) => (
          <span key={p.phase} className="min-w-[48px]" style={{ width: `${(p.seconds / total) * 100}%` }}>
            {t(`monitor.phase.${p.phase}`)}
          </span>
        ))}
      </div>
    </div>
  );
}

function Toggle({ on, onClick, icon, title, hint, testid }: { on: boolean; onClick: () => void; icon: ReactNode; title: string; hint: string; testid: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      data-testid={testid}
      className={`reveal flex flex-1 items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors ${on ? "border-accent/60 bg-accent/[0.07]" : "border-line hover:bg-raised/50"}`}
    >
      <span className={`mt-0.5 ${on ? "text-accent" : "text-muted"}`}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium">{title}</span>
        <span className="block text-[11px] leading-snug text-muted">{hint}</span>
      </span>
    </button>
  );
}

/** Choosing what to test: processor, memory, graphics card; and for how long. */
function StressSetup() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { stressOptions: o, gpus } = useMonitor();
  const set = (patch: Partial<StressOptions>) => useMonitor.setState((s) => ({ stressOptions: { ...s.stressOptions, ...patch } }));
  const nothing = !o.cpu && !o.ram && o.gpu === null;
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Toggle on={o.cpu} onClick={() => set({ cpu: !o.cpu })} icon={<Cpu size={17} />} title={t("monitor.stress.cpu")} hint={t("monitor.stress.cpuHint")} testid="stress-part-cpu" />
        <Toggle on={o.ram} onClick={() => set({ ram: !o.ram })} icon={<MemoryStick size={17} />} title={t("monitor.stress.ram")} hint={t("monitor.stress.ramHint")} testid="stress-part-ram" />
        <Toggle
          on={o.gpu !== null}
          onClick={() => set({ gpu: o.gpu === null ? (gpus[0]?.index ?? null) : null })}
          icon={<MonitorCog size={17} />}
          title={t("monitor.stress.gpu")}
          hint={gpus.length ? t("monitor.stress.gpuHint") : t("monitor.stress.noGpu")}
          testid="stress-part-gpu"
        />
      </div>
      {o.gpu !== null && gpus.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <span className="text-muted">{t("monitor.stress.whichGpu")}</span>
          {gpus.map((g) => (
            <button
              key={g.index}
              onClick={() => set({ gpu: g.index })}
              className={`rounded-full px-3 py-1 ${o.gpu === g.index ? "bg-accent/15 text-accent" : "bg-raised text-muted hover:text-fg"}`}
              data-testid={`stress-gpu-${g.index}`}
            >
              {g.name}
              <span className="num ml-1.5 opacity-70">{g.integrated ? t("monitor.stress.integrated") : fmt.bytes(g.vram)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="text-muted">{t("monitor.stress.duration")}</span>
        {[3, 10, 30].map((m) => (
          <button
            key={m}
            onClick={() => set({ minutes: m })}
            className={`rounded-full px-3 py-1 ${o.minutes === m ? "bg-accent/15 text-accent" : "bg-raised text-muted hover:text-fg"}`}
            data-testid={`stress-minutes-${m}`}
          >
            {t("monitor.stress.minutes", { count: m })}
          </button>
        ))}
        <span className="text-[11px] text-muted/80">{t(o.minutes === 3 ? "monitor.stress.quick" : o.minutes === 10 ? "monitor.stress.normal" : "monitor.stress.long")}</span>
      </div>
      {!(o.cpu && !o.ram && o.gpu === null && o.minutes === 3) && <p className="text-[11px] leading-relaxed text-muted">{t("monitor.stress.notProfile")}</p>}
      {nothing && <p className="text-[12px] text-warn">{t("monitor.stress.pickSomething")}</p>}
      <Button variant="primary" icon={<Play size={15} />} onClick={runStress} disabled={nothing} data-testid="stress-start">
        {t("monitor.stressStart")}
      </Button>
    </div>
  );
}

function Tile({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="rounded-lg bg-raised/60 px-2 py-2 text-center">
      <div className="text-[11px] text-muted">{label}</div>
      <div className={`num text-[16px] ${bad ? "text-risk" : ""}`}>{value}</div>
    </div>
  );
}

function StressCard() {
  const { t } = useTranslation();
  const { stress } = useMonitor();
  useEffect(() => {
    loadGpus();
  }, []);
  const last = stress.points[stress.points.length - 1];
  const o = stress.report?.options ?? stress.options;
  const plan = stress.report?.plan ?? stress.plan;
  const withGpu = o?.gpu !== null && o?.gpu !== undefined;
  const loadSeries: Series[] = [
    { id: "load", name: t("monitor.cpuLoad"), color: SERIES_COLORS[0], values: stress.points.map((p) => p.load) },
    ...(withGpu ? [{ id: "gpu", name: t("monitor.gpuLoad"), color: SERIES_COLORS[2], values: stress.points.map((p) => p.gpuLoad ?? 0) }] : []),
  ];
  const temps: Series[] = [
    { id: "cpu", name: t("monitor.cpuTemp"), color: SERIES_COLORS[1], values: stress.points.filter((p) => p.cpuTemp !== null).map((p) => p.cpuTemp!) },
    { id: "gpu", name: t("monitor.gpuTemp"), color: SERIES_COLORS[2], values: stress.points.filter((p) => p.gpuTemp !== null).map((p) => p.gpuTemp!) },
  ].filter((s) => s.values.length > 0);
  const total = plan.idle + plan.load + plan.cool;

  return (
    <Card title={t("monitor.stressTitleAny")} icon={<Gauge size={15} />}>
      {!stress.running && !stress.report && (
        <div className="space-y-3">
          <p className="max-w-[90ch] text-[13px] leading-relaxed text-muted">{t("monitor.stressIntroAny")}</p>
          <p className="flex gap-2 text-[12px] leading-relaxed text-warn">
            <AlertTriangle size={14} className="mt-[3px] shrink-0" />
            {t("monitor.stressWarning")}
          </p>
          <StressSetup />
          {stress.error && <p className="text-[12px] text-risk">{t("monitor.stressError", { message: stress.error })}</p>}
        </div>
      )}
      {(stress.running || stress.report) && (
        <div className="space-y-4">
          <PhaseBar points={stress.points} plan={plan} />
          {last && (
            <div className={`grid gap-3 ${withGpu ? "grid-cols-4" : "grid-cols-5"}`} data-testid="stress-live">
              {o?.cpu !== false && <Tile label={t("monitor.cpuLoad")} value={`${Math.round(last.load)} %`} />}
              {o?.cpu !== false && <Tile label={t("monitor.clock")} value={last.mhz ? `${Math.round(last.mhz)} MHz` : "—"} />}
              <Tile label={t("monitor.cpuTemp")} value={last.cpuTemp !== null ? `${Math.round(last.cpuTemp)} °C` : "—"} />
              {o?.cpu !== false && <Tile label={t("monitor.errors")} value={String(last.errors)} bad={last.errors > 0} />}
              {o?.ram && <Tile label={t("monitor.stress.ramErrors")} value={String(last.ramErrors)} bad={last.ramErrors > 0} />}
              {withGpu && <Tile label={t("monitor.gpuLoad")} value={last.gpuLoad !== null ? `${Math.round(last.gpuLoad)} %` : "—"} />}
              <Tile label={t("monitor.gpuTemp")} value={last.gpuTemp !== null ? `${Math.round(last.gpuTemp)} °C` : "—"} />
              {withGpu && <Tile label={t("monitor.vram")} value={last.gpuMem !== null ? `${(last.gpuMem / 1024).toFixed(1)} GB` : "—"} />}
              {withGpu && <Tile label={t("monitor.power")} value={last.gpuPower !== null ? `${Math.round(last.gpuPower)} W` : "—"} />}
              {withGpu && <Tile label={t("monitor.stress.gpuErrors")} value={String(last.gpuErrors)} bad={last.gpuErrors > 0} />}
            </div>
          )}
          <div className="grid grid-cols-2 gap-4">
            <LineChart series={loadSeries} format={(v) => `${Math.round(v)}%`} points={total} minRange={100} floor={0} label={t("monitor.load")} height={120} />
            {temps.length > 0 && <LineChart series={temps} format={(v) => `${Math.round(v)}°`} points={total} minRange={20} label={t("monitor.tempChart")} height={120} />}
          </div>
          {stress.running ? (
            <Button icon={<Square size={14} />} onClick={cancelStress} data-testid="stress-cancel">
              {t("monitor.stressStop")}
            </Button>
          ) : (
            stress.report && (
              <div className="space-y-3" data-testid="stress-report">
                {!stress.report.completed && <p className="text-[12px] text-warn">{t("monitor.stressStopped")}</p>}
                <CheckList checks={stress.report.checks} />
                <Button icon={<Play size={15} />} onClick={() => useMonitor.setState((s) => ({ stress: { ...s.stress, report: null, points: [] } }))} data-testid="stress-again">
                  {t("monitor.stressAgain")}
                </Button>
              </div>
            )
          )}
        </div>
      )}
    </Card>
  );
}

function Delta({ now, before, unit, worseWhenHigher = true }: { now: number; before: number | null | undefined; unit: string; worseWhenHigher?: boolean }) {
  if (before === undefined || before === null) return null;
  const diff = Math.round((now - before) * 10) / 10;
  if (Math.abs(diff) < 1) return <span className="text-[11px] text-muted">=</span>;
  const worse = worseWhenHigher ? diff > 0 : diff < 0;
  return (
    <span className={`num text-[11px] ${worse ? "text-warn" : "text-safe"}`}>
      {diff > 0 ? "+" : ""}
      {diff}
      {unit}
    </span>
  );
}

/** What the stress tests found out about cooling, and how that changed from run to run. */
function CoolingCard() {
  const { t, i18n } = useTranslation();
  const dur = useDuration();
  const runs = useMonitor((s) => s.cooling);
  useEffect(() => {
    loadCooling();
  }, []);
  const current = runs[runs.length - 1];
  const same = runs.filter((r) => current && r.source === current.source);
  const previous = same.length >= 2 ? same[same.length - 2] : undefined;
  const date = (at: number) => new Date(at * 1000).toLocaleDateString(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { day: "numeric", month: "short" });

  const tiles: [string, string, ReactNode][] = current
    ? [
        ["idle", `${Math.round(current.idle)} °C`, <Delta now={current.idle} before={previous?.idle} unit="°" />],
        ["plateau", `${Math.round(current.plateau)} °C`, <Delta now={current.plateau} before={previous?.plateau} unit="°" />],
        ["heatRate", `${Math.round(current.heatRate)} ${t("monitor.cooling.perMin")}`, <Delta now={current.heatRate} before={previous?.heatRate} unit="" />],
        ["sustained", current.sustained !== null ? `${Math.round(current.sustained)} %` : "—", current.sustained !== null ? <Delta now={current.sustained} before={previous?.sustained} unit="%" worseWhenHigher={false} /> : null],
        ["thermal", dur(current.thermalSeconds), <Delta now={current.thermalSeconds} before={previous?.thermalSeconds} unit=" s" />],
        ["cooled", `${Math.round(current.cooled)} °C`, <Delta now={current.cooled} before={previous?.cooled} unit="°" worseWhenHigher={false} />],
      ]
    : [];

  return (
    <Card title={t("monitor.cooling.title")} icon={<Flame size={15} />} aside={current ? <span className="text-[11px] text-muted">{t(`monitor.cooling.source.${current.source}`)}</span> : undefined}>
      {!current ? (
        <p className="max-w-[80ch] text-[13px] leading-relaxed text-muted">{t("monitor.cooling.empty")}</p>
      ) : (
        <div className="space-y-4" data-testid="cooling-profile">
          <p className="max-w-[90ch] text-[12px] leading-relaxed text-muted">{t("monitor.cooling.intro")}</p>
          <div className="grid grid-cols-3 gap-3">
            {tiles.map(([key, value, delta]) => (
              <div key={key} className="rounded-xl bg-raised/50 px-3.5 py-3">
                <div className="text-[11px] text-muted">{t(`monitor.cooling.${key}`)}</div>
                <div className="mt-0.5 flex items-baseline gap-2">
                  <span className="num text-[18px]">{value}</span>
                  {delta}
                </div>
                <div className="mt-1 text-[11px] leading-snug text-muted/80">{t(`monitor.cooling.hint.${key}`)}</div>
              </div>
            ))}
          </div>
          {same.length >= 2 ? (
            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
                <History size={13} />
                {t("monitor.cooling.history", { count: same.length, since: date(same[0].at) })}
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="mb-1 text-[11px] text-muted">{t("monitor.cooling.plateau")}</div>
                  <LineChart series={[{ id: "plateau", name: t("monitor.cooling.plateau"), color: SERIES_COLORS[1], values: same.map((r) => r.plateau) }]} format={(v) => `${Math.round(v)}°`} points={Math.max(2, same.length)} minRange={10} label={t("monitor.cooling.plateau")} height={110} markers />
                </div>
                <div>
                  <div className="mb-1 text-[11px] text-muted">{t("monitor.cooling.sustained")}</div>
                  <LineChart series={[{ id: "sustained", name: t("monitor.cooling.sustained"), color: SERIES_COLORS[0], values: same.filter((r) => r.sustained !== null).map((r) => r.sustained!) }]} format={(v) => `${Math.round(v)}%`} points={Math.max(2, same.length)} minRange={20} label={t("monitor.cooling.sustained")} height={110} markers />
                </div>
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-muted">{t("monitor.cooling.oneRun")}</p>
          )}
        </div>
      )}
    </Card>
  );
}

function StabilityTab() {
  const { t } = useTranslation();
  const { quick, quickLoading } = useMonitor();
  useEffect(() => {
    if (!useMonitor.getState().quick) runQuick();
  }, []);

  const overall: Level | null = quick ? (quick.checks.some((c) => c.level === "bad") ? "bad" : quick.checks.some((c) => c.level === "warn") ? "warn" : "ok") : null;
  const Icon = overall ? LEVEL_ICON[overall] : HelpCircle;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-4">
        <Icon size={28} className={overall ? LEVEL_TONE[overall] : "text-muted"} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-[20px] font-semibold">{quick ? t(`monitor.overall.${overall}`) : t("monitor.checking")}</div>
          <div className="text-[12px] text-muted">{t("monitor.quickHint", { days: quick?.logDays ?? 90 })}</div>
        </div>
        <Button onClick={runQuick} disabled={quickLoading}>
          {t("monitor.recheck")}
        </Button>
      </div>
      {quick && !quick.elevated && <AdminBanner text={t("monitor.adminStability")} />}
      {quick &&
        GROUPS.map((group) => {
          const checks = quick.checks.filter((c) => group.ids.includes(c.id));
          if (!checks.length) return null;
          return (
            <section key={group.key}>
              <h2 className="mb-2 px-1 text-[11px] uppercase tracking-wider text-muted">{t(`monitor.group.${group.key}`)}</h2>
              <CheckList checks={checks} />
            </section>
          );
        })}
      <StressCard />
      <CoolingCard />
    </div>
  );
}

export function Monitoring() {
  const { t } = useTranslation();
  const tab = useMonitor((s) => s.tab);
  useEffect(() => {
    loadStatus();
  }, []);
  return (
    <div className="flex flex-col gap-4 pb-2">
      <div className="flex gap-1 rounded-lg border border-line p-0.5 text-[13px]" role="tablist">
        {(["sensors", "stability", "history"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => useMonitor.setState({ tab: id })}
            data-testid={`monitor-tab-${id}`}
            className={`relative h-8 flex-1 rounded-md transition-colors duration-150 ${tab === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            {tab === id && <motion.span layoutId="monitor-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
            <span className="relative">{t(`monitor.tab.${id}`)}</span>
          </button>
        ))}
      </div>
      {tab === "sensors" ? <SensorsTab /> : tab === "stability" ? <StabilityTab /> : <HistoryTab />}
    </div>
  );
}

