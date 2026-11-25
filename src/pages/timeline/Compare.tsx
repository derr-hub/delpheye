import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ArrowRight, ChevronDown, Info } from "lucide-react";
import { useFmt } from "../../lib/format";
import { LANES, difference, loadReadings, titleOf, type Change, type Reading, type Stats, type TimelineEvent } from "../../lib/timeline";

const DAY = 86_400;
const PRESETS = [1, 7, 30, 90] as const;
const iso = (s: number) => {
  const d = new Date(s * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

interface Averages {
  cpu: number | null;
  ram: number | null;
  gpu: number | null;
  temp: number | null;
  free: number | null;
  minutes: number;
}
interface HealthDay {
  day: string;
  minutes: number;
  cpuAvg: number | null;
  ramAvg: number | null;
  cpuTempAvg: number | null;
  diskFree: number | null;
}

function average(rs: Reading[]): Averages {
  const mean = (get: (r: Reading) => number | null) => {
    let sum = 0;
    let n = 0;
    for (const r of rs) {
      const v = get(r);
      if (v !== null) {
        sum += v * r.n;
        n += r.n;
      }
    }
    return n ? sum / n : null;
  };
  return { cpu: mean((r) => r.cpu), ram: mean((r) => r.ram), gpu: mean((r) => r.gpu), temp: mean((r) => r.cpuTemp), free: mean((r) => r.freeMb), minutes: rs.reduce((a, r) => a + r.n, 0) };
}

/** Older than the detailed record: the daily health history fills in what it has. */
function fromDays(days: HealthDay[]): Averages {
  const mean = (get: (d: HealthDay) => number | null) => {
    const v = days.filter((d) => d.minutes > 0 && get(d) !== null);
    const n = v.reduce((a, d) => a + d.minutes, 0);
    return n ? v.reduce((a, d) => a + get(d)! * d.minutes, 0) / n : null;
  };
  const free = mean((d) => d.diskFree);
  return { cpu: mean((d) => d.cpuAvg), ram: mean((d) => d.ramAvg), gpu: null, temp: mean((d) => d.cpuTempAvg), free: free === null ? null : free / 1_048_576, minutes: days.reduce((a, d) => a + d.minutes, 0) };
}

export function Compare({ events, stats, now }: { events: TimelineEvent[]; stats: Stats; now: number }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [back, setBack] = useState<number>(7);
  const [pair, setPair] = useState<{ then: Averages; now: Averages } | null>(null);
  const [open, setOpen] = useState<string | null>("driver");
  const then = now - back * DAY;

  useEffect(() => {
    let alive = true;
    setPair(null);
    (async () => {
      const read = async (day: number, width: number) => {
        const rs = await loadReadings(day - width, day, 900);
        const a = average(rs);
        if (a.minutes >= 30) return a;
        const all = await invoke<HealthDay[]>("health_history", { since: iso(day - width) }).catch(() => []);
        return fromDays(all.filter((d) => d.day >= iso(day - width) && d.day <= iso(day)));
      };
      const width = back <= 1 ? 12 * 3600 : DAY;
      const r = { then: await read(then + (back <= 1 ? 0 : DAY / 2), width), now: await read(now, width) };
      if (alive) setPair(r);
    })().catch(() => alive && setPair(null));
    return () => {
      alive = false;
    };
    // `now` moves every minute; the comparison need not follow it that closely.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [back]);

  const groups = useMemo(() => {
    const all = difference(events, then);
    return LANES.filter((l) => l.id !== "crash" && l.id !== "alert" && l.id !== "delpheye").map((l) => ({ lane: l, items: all.filter((c) => (l.kinds as readonly string[]).includes(c.kind)) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, back]);
  const crashes = (from: number, to: number) => events.filter((e) => e.kind === "crash" && e.t >= from && e.t < to).length;
  // Windows keeps its log only so long: before its first line "no crashes" would be made up.
  const logFrom = events.find((e) => e.kind === "appcrash" || e.kind === "service" || e.kind === "crash")?.t ?? now;
  const covered = then - back * DAY >= logFrom;
  const c = { now: crashes(then, now + 1), then: crashes(then - back * DAY, then) };

  const rows = [
    { id: "cpu", unit: "%", a: pair?.then.cpu, b: pair?.now.cpu, worse: 1, matter: 5 },
    { id: "ram", unit: "%", a: pair?.then.ram, b: pair?.now.ram, worse: 1, matter: 5 },
    { id: "gpu", unit: "%", a: pair?.then.gpu, b: pair?.now.gpu, worse: 1, matter: 5 },
    { id: "temp", unit: " °C", a: pair?.then.temp, b: pair?.now.temp, worse: 1, matter: 4 },
    { id: "free", unit: "", a: pair?.then.free, b: pair?.now.free, worse: -1, matter: 2048 },
  ];
  const show = (id: string, v: number | null | undefined, unit: string) => (v === null || v === undefined ? "—" : id === "free" ? fmt.bytes(v * 1_048_576) : `${Math.round(v)}${unit}`);
  const name = (ch: Change) => titleOf({ ...ch, id: "", action: "added", source: "seen", dayOnly: false }, t);
  const partial = !stats.firstReading || then < stats.firstReading;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="timeline-compare">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[0.8125rem]">{t("timeline.compare.lead")}</span>
        <div className="flex rounded-lg border border-line p-0.5 text-[0.75rem]">
          {PRESETS.map((d) => (
            <button key={d} onClick={() => setBack(d)} aria-pressed={back === d} className={`rounded-md px-3 py-1 ${back === d ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`compare-${d}`}>
              {t(`timeline.compare.ago.${d}`)}
            </button>
          ))}
        </div>
        <input
          type="date"
          aria-label={t("timeline.compare.date")}
          value={iso(then)}
          max={iso(now - DAY)}
          min={iso(stats.firstEvent ?? now - 365 * DAY)}
          onChange={(e) => {
            const s = new Date(`${e.target.value}T12:00:00`).getTime() / 1000;
            if (s && s < now) setBack(Math.max(1, Math.round((now - s) / DAY)));
          }}
          className="rounded-lg border border-line bg-surface px-2.5 py-1 text-[0.75rem]"
        />
      </div>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-3 text-[0.8125rem] font-medium">{t("timeline.compare.feel")}</h3>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-baseline gap-x-4 gap-y-2.5 text-[0.8125rem]">
            <span />
            <span className="text-right text-[0.6875rem] text-muted">{fmt.date(then)}</span>
            <span className="text-right text-[0.6875rem] text-muted">{t("timeline.compare.now")}</span>
            <span />
            {rows.map(({ id, unit, a, b, worse, matter }) => {
              const d = typeof a === "number" && typeof b === "number" ? b - a : null;
              const big = d !== null && Math.abs(d) >= matter;
              return (
                <div key={id} className="contents">
                  <span className="text-muted">
                    {t(`timeline.compare.row.${id}`)}
                    {id !== "free" && typeof a === "number" && typeof b === "number" && (
                      <span className="relative mt-1 block h-1.5 overflow-hidden rounded-full bg-raised">
                        <motion.span key={`${id}${back}`} className="absolute inset-y-0 left-0 rounded-full bg-accent" initial={{ width: `${Math.min(100, a)}%` }} animate={{ width: `${Math.min(100, b)}%` }} transition={{ duration: 1.1, delay: 0.35, ease: [0.3, 0.8, 0.3, 1] }} />
                        <span className="absolute inset-y-0 w-[2px] bg-fg" style={{ left: `${Math.min(99, a)}%` }} />
                      </span>
                    )}
                  </span>
                  <span className="num text-right">{show(id, a, unit)}</span>
                  <span className="num text-right font-medium">{show(id, b, unit)}</span>
                  <span className={`num text-right text-[0.75rem] ${!big ? "text-muted" : Math.sign(d!) === worse ? "text-warn" : "text-safe"}`}>{d === null ? "" : !big ? t("timeline.compare.same") : `${d > 0 ? "+" : "−"}${show(id, Math.abs(d), unit)}`}</span>
                </div>
              );
            })}
            <span className="text-muted">{t("timeline.compare.row.crashes")}</span>
            <span className="num text-right">{covered ? c.then : "—"}</span>
            <span className="num text-right font-medium">{c.now}</span>
            <span className={`num text-right text-[0.75rem] ${!covered || c.now === c.then ? "text-muted" : c.now > c.then ? "text-warn" : "text-safe"}`}>{!covered ? "" : c.now === c.then ? t("timeline.compare.same") : `${c.now > c.then ? "+" : "−"}${Math.abs(c.now - c.then)}`}</span>
          </div>
          <p className="mt-3 text-[0.6875rem] leading-relaxed text-muted">{t("timeline.compare.feelNote", { count: back })}</p>
        </section>

        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-1 text-[0.8125rem] font-medium">{t("timeline.compare.what")}</h3>
          <p className="mb-2 text-[0.6875rem] text-muted">{t("timeline.compare.whatNote")}</p>
          {groups.map(({ lane, items }) => (
            <div key={lane.id} className="border-t border-line/70">
              <button onClick={() => setOpen(open === lane.id ? null : lane.id)} disabled={!items.length} aria-expanded={open === lane.id} className="flex w-full items-center gap-2.5 py-2.5 text-left text-[0.8125rem] disabled:opacity-50" data-testid={`compare-group-${lane.id}`}>
                <span className="h-2 w-2 rounded-full" style={{ background: lane.color }} />
                <span className="flex-1">{t(`timeline.lane.${lane.id}.name`)}</span>
                <span className="num text-[0.75rem] text-muted">{items.length ? t("timeline.compare.count", { count: items.length }) : t("timeline.compare.none")}</span>
                {items.length > 0 && <ChevronDown size={14} className={`text-muted transition-transform ${open === lane.id ? "rotate-180" : ""}`} />}
              </button>
              <AnimatePresence initial={false}>
                {open === lane.id && items.length > 0 && (
                  <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ type: "spring", stiffness: 400, damping: 38 }} className="overflow-hidden">
                    <ul className="max-h-[20rem] space-y-1.5 overflow-y-auto pb-3 pl-5 pr-1">
                      {items.map((ch) => (
                        <li key={`${ch.kind}${ch.name}`} className="text-[0.75rem]">
                          <div className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate" title={name(ch)}>
                              {name(ch)}
                            </span>
                            <span className={`shrink-0 text-[0.6875rem] ${ch.how === "removed" ? "text-warn" : ch.how === "added" ? "text-safe" : "text-accent"}`}>{t(`timeline.action.${ch.how}`)}</span>
                          </div>
                          <div className="flex items-center gap-1.5 truncate text-[0.6875rem] text-muted">
                            {fmt.date(ch.t)}
                            {ch.was && ch.now && ch.was !== ch.now ? (
                              <span className="num flex min-w-0 items-center gap-1 truncate">
                                · {ch.was} <ArrowRight size={10} className="shrink-0" /> {ch.now}
                              </span>
                            ) : ch.kind !== "service" && ch.now && !ch.now.includes("\n") ? (
                              <span className="num truncate">· {ch.now}</span>
                            ) : null}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}
        </section>
      </div>
      {partial && (
        <p className="flex gap-2.5 rounded-card border border-accent/30 bg-accent/5 px-4 py-3 text-[0.75rem] leading-relaxed">
          <Info size={15} className="mt-0.5 shrink-0 text-accent" />
          {stats.firstReading ? t("timeline.compare.partial", { date: fmt.dateTime(stats.firstReading) }) : t("timeline.compare.partialNone")}
        </p>
      )}
    </div>
  );
}
