import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { CalendarDays, Flame, HardDrive, Loader2, ShieldAlert, Thermometer, Activity } from "lucide-react";
import { useFmt } from "../../lib/format";

interface Day {
  day: string;
  minutes: number;
  cpuAvg: number | null;
  cpuMax: number | null;
  ramAvg: number | null;
  ramMax: number | null;
  cpuTempAvg: number | null;
  cpuTempMax: number | null;
  gpuTempAvg: number | null;
  gpuTempMax: number | null;
  hotMinutes: number;
  diskFree: number | null;
  diskTotal: number | null;
  bluescreens: number;
  shutdowns: number;
  hardware: number;
  gpuResets: number;
}

const RANGES = [30, 90, 365] as const;
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Every day from `since` to today, with what was recorded (or nothing). */
function fill(days: Day[], range: number): { day: string; d: Day | null }[] {
  const by = new Map(days.map((d) => [d.day, d]));
  const out = [];
  const t = new Date();
  for (let i = range - 1; i >= 0; i--) {
    const key = iso(new Date(t.getFullYear(), t.getMonth(), t.getDate() - i));
    out.push({ day: key, d: by.get(key) ?? null });
  }
  return out;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

interface Series {
  key: string;
  label: string;
  color: string;
  values: (number | null)[];
}

const H = 150;
const PAD = { l: 34, r: 8, t: 8, b: 20 };

/** Daily lines on one axis, gaps where nothing was recorded, a crosshair with all values on hover. */
function Lines({ days, series, unit, max, min = 0, testid }: { days: string[]; series: Series[]; unit: string; max?: number; min?: number; testid?: string }) {
  const { i18n } = useTranslation();
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const top = max ?? Math.max(10, Math.ceil((Math.max(...all, 1) * 1.1) / 10) * 10);
  const iw = w - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (days.length === 1 ? iw / 2 : (i / (days.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - ((v - min) / Math.max(1e-6, top - min)) * ih;
  const ticks = [min, min + (top - min) / 2, top];
  const fmtDay = (d: string) => new Intl.DateTimeFormat(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { day: "numeric", month: "short" }).format(new Date(d));
  const labelAt = [0, Math.floor((days.length - 1) / 2), days.length - 1];

  const path = (vals: (number | null)[]) => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  return (
    <div ref={ref} className="relative" data-testid={testid}>
      {series.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="h-[3px] w-3 rounded-full" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <svg
        width={w}
        height={H}
        className="block overflow-visible"
        onPointerMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const i = Math.round(((e.clientX - r.left - PAD.l) / iw) * (days.length - 1));
          setHover(i >= 0 && i < days.length ? i : null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeDasharray={v === min ? undefined : "3 4"} />
            <text x={PAD.l - 6} y={y(v) + 3.5} textAnchor="end" className="fill-muted text-[0.625rem]">
              {Math.round(v)}
            </text>
          </g>
        ))}
        {labelAt.map((i) => (
          <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? "start" : i === days.length - 1 ? "end" : "middle"} className="fill-muted text-[0.625rem]">
            {fmtDay(days[i])}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <motion.path d={path(s.values)} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.7, ease: "easeOut" }} />
            {/* Lone days (with gaps on both sides) still show as a dot. */}
            {s.values.map((v, i) => (v !== null && (s.values[i - 1] ?? null) === null && (s.values[i + 1] ?? null) === null ? <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color} /> : null))}
          </g>
        ))}
        {hover !== null && (
          <g pointerEvents="none">
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={PAD.t + ih} stroke="var(--color-muted)" strokeOpacity={0.5} />
            {series.map((s) => (s.values[hover] !== null ? <circle key={s.key} cx={x(hover)} cy={y(s.values[hover]!)} r={4} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} /> : null))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div
          className="pointer-events-none absolute z-10 min-w-[8.125rem] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[0.6875rem] shadow-lg"
          style={{ left: Math.min(Math.max(0, x(hover) + 10), w - 150), top: series.length > 1 ? 24 : 4 }}
        >
          <div className="mb-0.5 text-muted">{fmtDay(days[hover])}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full" style={{ background: s.color }} />
              <span className="text-muted">{s.label}</span>
              <span className="num ml-auto pl-3 text-fg">{s.values[hover] !== null ? `${s.values[hover]}${unit}` : "—"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Crashes per day as small stacked bars. */
function Crashes({ days, rows }: { days: string[]; rows: { day: string; d: Day | null }[] }) {
  const { t, i18n } = useTranslation();
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const kinds = [
    ["bluescreens", "#e5484d"],
    ["shutdowns", "#f5a524"],
    ["hardware", "#8e6bd8"],
    ["gpuResets", "#3b9ee5"],
  ] as const;
  const h = 70;
  const top = Math.max(1, ...rows.map(({ d }) => (d ? d.bluescreens + d.shutdowns + d.hardware + d.gpuResets : 0)));
  const bw = Math.max(2, w / days.length - 2);
  const fmtDay = (d: string) => new Intl.DateTimeFormat(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { day: "numeric", month: "short" }).format(new Date(d));
  return (
    <div ref={ref} className="relative" data-testid="history-crashes">
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted">
        {kinds.map(([k, c]) => (
          <span key={k} className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: c }} />
            {t(`history.crash.${k}`)}
          </span>
        ))}
      </div>
      <svg width={w} height={h} className="block" onPointerLeave={() => setHover(null)}>
        <line x1={0} x2={w} y1={h - 0.5} y2={h - 0.5} stroke="var(--color-line)" />
        {rows.map(({ d }, i) => {
          let acc = 0;
          const x0 = (i / days.length) * w + 1;
          return (
            <g key={i} onPointerEnter={() => setHover(i)}>
              <rect x={x0 - 1} y={0} width={bw + 2} height={h} fill="transparent" />
              {d &&
                kinds.map(([k, c]) => {
                  const n = d[k];
                  if (!n) return null;
                  const bh = (n / top) * (h - 6);
                  acc += bh;
                  return <rect key={k} x={x0} y={h - acc} width={bw} height={Math.max(2, bh - 2)} rx={2} fill={c} />;
                })}
            </g>
          );
        })}
      </svg>
      {hover !== null && rows[hover].d && (
        <div className="pointer-events-none absolute z-10 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[0.6875rem] shadow-lg" style={{ left: Math.min((hover / days.length) * w + 10, w - 150), top: 20 }}>
          <div className="mb-0.5 text-muted">{fmtDay(days[hover])}</div>
          {kinds.map(([k]) => (rows[hover].d![k] ? <div key={k}>{t(`history.crash.${k}`)}: {rows[hover].d![k]}</div> : null))}
          {!kinds.some(([k]) => rows[hover].d![k]) && <div className="text-muted">{t("history.noCrashes")}</div>}
        </div>
      )}
    </div>
  );
}

function Panel({ icon, title, note, children }: { icon: React.ReactNode; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-5">
      <h3 className="mb-3 flex items-center gap-2 text-[0.8125rem] font-medium">
        <span className="text-accent">{icon}</span>
        {title}
        {note && <span className="ml-auto text-[0.6875rem] font-normal text-muted">{note}</span>}
      </h3>
      {children}
    </section>
  );
}

export function HistoryTab() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [range, setRange] = useState<(typeof RANGES)[number]>(30);
  const [data, setData] = useState<Day[] | null>(null);

  useEffect(() => {
    setData(null);
    const t0 = new Date();
    const since = iso(new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() - range + 1));
    invoke<Day[]>("health_history", { since }).then(setData).catch(() => setData([]));
  }, [range]);

  const rows = useMemo(() => (data ? fill(data, range) : []), [data, range]);
  if (!data)
    return (
      <div className="flex items-center justify-center gap-2 py-20 text-[0.8125rem] text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t("history.loading")}
      </div>
    );

  const days = rows.map((r) => r.day);
  const v = (f: (d: Day) => number | null) => rows.map(({ d }) => (d && d.minutes > 0 ? f(d) : null));
  const watched = data.filter((d) => d.minutes > 0);
  const crashes = data.reduce((a, d) => a + d.bluescreens + d.shutdowns + d.hardware + d.gpuResets, 0);
  const hottest = watched.reduce<Day | null>((a, d) => ((d.cpuTempMax ?? 0) > (a?.cpuTempMax ?? 0) ? d : a), null);
  const disks = watched.filter((d) => d.diskFree !== null);
  const diskChange = disks.length > 1 ? disks[disks.length - 1].diskFree! - disks[0].diskFree! : null;
  const gb = (b: number | null) => (b === null ? null : Math.round((b / 1e9) * 10) / 10);

  return (
    <div className="grid gap-4 pb-6" data-testid="history-tab">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-[0.75rem] leading-relaxed text-muted">{t("history.lead")}</p>
        <div className="flex rounded-lg border border-line p-0.5 text-[0.75rem]">
          {RANGES.map((r) => (
            <button key={r} onClick={() => setRange(r)} className={`rounded-md px-3 py-1 ${range === r ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`history-range-${r}`}>
              {t("history.days", { count: r })}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(
          [
            [CalendarDays, t("history.watched"), t("history.daysValue", { count: watched.length }), watched.length ? t("history.hours", { count: Math.round(watched.reduce((a, d) => a + d.minutes, 0) / 60) }) : t("history.startsToday")],
            [Flame, t("history.hottest"), hottest?.cpuTempMax ? `${Math.round(hottest.cpuTempMax)} °C` : "—", hottest ? new Date(hottest.day).toLocaleDateString() : ""],
            [ShieldAlert, t("history.crashes"), String(crashes), crashes ? t("history.crashesNote") : t("history.noCrashes")],
            [HardDrive, t("history.diskTrend"), diskChange === null ? "—" : `${diskChange >= 0 ? "+" : "−"}${fmt.bytes(Math.abs(diskChange))}`, disks.length ? t("history.diskNow", { free: fmt.bytes(disks[disks.length - 1].diskFree!) }) : ""],
          ] as const
        ).map(([Icon, label, value, sub]) => (
          <div key={label} className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-[0.75rem] text-muted">
              <Icon size={14} />
              {label}
            </div>
            <div className="num mt-1 text-[1.375rem] font-semibold">{value}</div>
            <div className="text-[0.6875rem] text-muted">{sub}</div>
          </div>
        ))}
      </div>

      {watched.length < 2 && <div className="rounded-card border border-accent/30 bg-accent/5 px-4 py-3 text-[0.75rem] leading-relaxed text-fg">{t("history.young")}</div>}

      <Panel icon={<Thermometer size={15} />} title={t("history.temps")} note={t("history.perDay")}>
        <Lines
          days={days}
          unit=" °C"
          testid="history-temps"
          series={[
            { key: "cpuMax", label: t("history.cpuTempMax"), color: "#f0772e", values: v((d) => d.cpuTempMax) },
            { key: "cpuAvg", label: t("history.cpuTempAvg"), color: "#3b9ee5", values: v((d) => d.cpuTempAvg) },
            { key: "gpuMax", label: t("history.gpuTempMax"), color: "#9b6be0", values: v((d) => d.gpuTempMax) },
          ].filter((s) => s.values.some((x) => x !== null))}
        />
      </Panel>
      <Panel icon={<Activity size={15} />} title={t("history.load")} note={t("history.perDay")}>
        <Lines
          days={days}
          unit="%"
          max={100}
          testid="history-load"
          series={[
            { key: "cpu", label: t("history.cpuAvg"), color: "#3b9ee5", values: v((d) => d.cpuAvg) },
            { key: "ram", label: t("history.ramAvg"), color: "#2bb39a", values: v((d) => d.ramAvg) },
          ]}
        />
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel icon={<HardDrive size={15} />} title={t("history.disk")}>
          <Lines days={days} unit=" GB" testid="history-disk" series={[{ key: "disk", label: t("history.disk"), color: "#3b9ee5", values: v((d) => gb(d.diskFree)) }]} />
        </Panel>
        <Panel icon={<ShieldAlert size={15} />} title={t("history.crashTitle")} note={t("history.fromWindows")}>
          <Crashes days={days} rows={rows} />
        </Panel>
      </div>
    </div>
  );
}
