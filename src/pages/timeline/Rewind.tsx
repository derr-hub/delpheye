import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Cpu, Gauge, HardDrive, MemoryStick, MonitorPlay, Network, Package, Rewind as RewindIcon, Rocket, ShieldAlert, SkipForward, Thermometer, Undo2, type LucideIcon } from "lucide-react";
import { AnimatedNumber, Button } from "../../components/ui";
import { go } from "../../lib/app";
import { useFmt } from "../../lib/format";
import { driversAt, isProblem, loadReadings, stateAt, titleOf, type Reading, type Row, type State, type Stats, type TimelineEvent, type Trust } from "../../lib/timeline";
import { useWidth, type View } from "./Board";
import { EventRow } from "./Cards";

const TONE: Record<Trust, string> = { recorded: "text-safe", rebuilt: "text-accent", partial: "text-warn", unknown: "text-muted" };

function Mark({ trust }: { trust: Trust }) {
  const { t } = useTranslation();
  return (
    <span className={`flex items-center gap-1 text-[0.625rem] ${TONE[trust]}`} title={t(`timeline.trust.${trust}.hint`)} data-trust={trust}>
      <span className={`h-1.5 w-1.5 rounded-full ${trust === "unknown" ? "border border-current" : "bg-current"}`} />
      {t(`timeline.trust.${trust}.name`)}
    </span>
  );
}

function Tile({ icon: Icon, title, trust, children, now }: { icon: LucideIcon; title: string; trust: Trust; children: React.ReactNode; now?: string | null }) {
  const { t } = useTranslation();
  return (
    <div className={`rounded-card border bg-surface p-4 transition-colors ${trust === "unknown" ? "border-dashed border-line" : "border-line"}`}>
      <div className="flex items-center gap-2 text-[0.75rem] text-muted">
        <Icon size={14} className="shrink-0" />
        <span className="flex-1 truncate">{title}</span>
      </div>
      <div className={`mt-1.5 font-display text-[1.375rem] font-semibold leading-tight ${trust === "unknown" ? "text-muted" : ""}`}>{children}</div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
        <Mark trust={trust} />
        {now && <span className="num whitespace-nowrap text-[0.6875rem] text-muted">{t("timeline.rewind.nowIs", { value: now })}</span>}
      </div>
    </div>
  );
}

/** Drag back: the board below shows what the computer was like then, and says how each thing is known. */
export function Rewind({ at, onAt, extent, events, stats, present, now }: { at: number; onAt: (t: number) => void; extent: View; events: TimelineEvent[]; stats: Stats; present: Row[]; now: number }) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const still = useReducedMotion();
  const [ref, w] = useWidth<HTMLDivElement>();
  const [reading, setReading] = useState<{ r: Reading | null; cur: Reading | null } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const drag = useRef(false);
  const back = useRef(0);

  // Recent time gets more room: the past is squeezed towards the left.
  const span = extent.to - extent.from;
  const toX = (s: number) => (1 - Math.sqrt(Math.max(0, extent.to - s) / span)) * w;
  const toT = (px: number) => extent.to - (1 - Math.min(1, Math.max(0, px / w))) ** 2 * span;

  useEffect(() => {
    let alive = true;
    const id = window.setTimeout(() => {
      Promise.all([loadReadings(at - 1200, at + 600, 60), loadReadings(now - 1200, now + 60, 60)])
        .then(([a, b]) => {
          if (!alive) return;
          const near = a.reduce<Reading | null>((best, r) => (!best || Math.abs(r.t - at) < Math.abs(best.t - at) ? r : best), null);
          setReading({ r: near && Math.abs(near.t - at) <= 900 ? near : null, cur: b[b.length - 1] ?? null });
        })
        .catch(() => alive && setReading({ r: null, cur: null }));
    }, 60);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [at, now]);

  const looked = (k: string) => stats.looked.find((l) => l[0] === k)?.[1];
  const states = useMemo(
    () => ({
      program: { then: stateAt("program", at, present, events, looked("program")), now: stateAt("program", now, present, events, looked("program")) },
      startup: { then: stateAt("startup", at, present, events, looked("startup")), now: stateAt("startup", now, present, events, looked("startup")) },
      driver: { then: driversAt(at, events), now: driversAt(now, events) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [at, present, events, now],
  );
  const recent = useMemo(() => events.filter((e) => e.t <= at && e.t > at - 2 * 86_400).slice(-6).reverse(), [events, at]);
  const problems = useMemo(() => events.filter((e) => isProblem(e) && e.t <= at && e.t > at - 7 * 86_400), [events, at]);
  const logFrom = events.find((e) => e.kind === "appcrash" || e.kind === "crash")?.t ?? now;
  const isNow = now - at < 180;

  /** The quick way back to the present: the scrubber runs forward, fast and easing out. */
  const toPresent = () => {
    cancelAnimationFrame(back.current);
    if (still) return onAt(now);
    const from = toX(at) / w;
    const began = performance.now();
    const tick = (n: number) => {
      const k = Math.min(1, (n - began) / 900);
      onAt(k === 1 ? now : toT((from + (1 - from) * (1 - (1 - k) ** 3)) * w));
      if (k < 1) back.current = requestAnimationFrame(tick);
    };
    back.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(back.current), []);

  const r = reading?.r ?? null;
  const c = reading?.cur ?? null;
  const num = (v: number | null | undefined, unit: string) => (v === null || v === undefined ? null : `${Math.round(v)}${unit}`);
  const metric = (id: string, icon: LucideIcon, v: number | null | undefined, cur: number | null | undefined, unit: string) => (
    <Tile key={id} icon={icon} title={t(`timeline.moment.row.${id}`)} trust={v === null || v === undefined ? "unknown" : "recorded"} now={isNow ? null : num(cur, unit)}>
      {v === null || v === undefined ? (
        t("timeline.rewind.unknown")
      ) : (
        <span className="num">
          <AnimatedNumber value={Math.round(v)} />
          {unit}
        </span>
      )}
    </Tile>
  );
  const list = (id: "program" | "startup" | "driver", icon: LucideIcon) => {
    const s: State = states[id].then;
    const cur: State = states[id].now;
    const gone = [...s.items].filter(([n]) => !cur.items.has(n));
    const later = [...cur.items].filter(([n]) => !s.items.has(n));
    const other = [...s.items].filter(([n, v]) => cur.items.has(n) && cur.items.get(n) !== v);
    const name = (n: string) => (id === "driver" ? titleOf({ id: "", t: 0, kind: "driver", action: "added", name: n, was: null, now: null, source: "seen", dayOnly: false }, t) : n);
    const on = open === id;
    return (
      <div key={id} className="rounded-card border border-line bg-surface">
        <button className="w-full p-4 text-left" onClick={() => setOpen(on ? null : id)} aria-expanded={on} data-testid={`rewind-${id}`}>
          <div className="flex items-center gap-2 text-[0.75rem] text-muted">
            {(() => {
              const I = icon;
              return <I size={14} />;
            })()}
            <span className="flex-1">{t(`timeline.rewind.${id}`)}</span>
            <ChevronDown size={14} className={`transition-transform ${on ? "rotate-180" : ""}`} />
          </div>
          <div className="num mt-1.5 font-display text-[1.375rem] font-semibold leading-tight">{s.trust === "unknown" ? <span className="text-muted">{t("timeline.rewind.unknown")}</span> : (
            <>
              {s.trust === "partial" && "≈ "}
              <AnimatedNumber value={s.items.size} />
            </>
          )}</div>
          <div className="mt-1.5 flex items-center justify-between gap-2">
            <Mark trust={s.trust} />
            {!isNow && s.trust !== "unknown" && (
              <span className="num text-[0.6875rem] text-muted">
                {later.length || gone.length || other.length ? t("timeline.rewind.diff", { later: later.length, gone: gone.length, other: other.length }) : t("timeline.compare.none")}
              </span>
            )}
          </div>
        </button>
        <AnimatePresence initial={false}>
          {on && s.trust !== "unknown" && (
            <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ type: "spring", stiffness: 400, damping: 38 }} className="overflow-hidden">
              <ul className="max-h-[18rem] space-y-1 overflow-y-auto border-t border-line px-4 py-3 text-[0.75rem]">
                {gone.map(([n]) => (
                  <li key={n} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate">{name(n)}</span>
                    <span className="shrink-0 text-warn">{t("timeline.rewind.wasOnly")}</span>
                  </li>
                ))}
                {later.map(([n]) => (
                  <li key={n} className="flex gap-2 opacity-60">
                    <span className="min-w-0 flex-1 truncate line-through">{name(n)}</span>
                    <span className="shrink-0 text-accent">{t("timeline.rewind.notYet")}</span>
                  </li>
                ))}
                {other.map(([n, v]) => (
                  <li key={n} className="flex gap-2">
                    <span className="min-w-0 flex-1 truncate">{name(n)}</span>
                    <span className="num shrink-0 text-muted">
                      {v ?? "?"} → {cur.items.get(n) ?? "?"}
                    </span>
                  </li>
                ))}
                {!gone.length && !later.length && !other.length && <li className="text-muted">{t("timeline.compare.none")}</li>}
              </ul>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  const locale = i18n.language.startsWith("uk") ? "uk-UA" : "en-US";
  const marks = useMemo(() => {
    const out: { t: number; text: string }[] = [];
    for (const [k, s] of [
      ["1d", 86_400],
      ["7d", 7 * 86_400],
      ["30d", 30 * 86_400],
      ["90d", 90 * 86_400],
      ["1y", 365 * 86_400],
    ] as const)
      if (extent.to - s > extent.from) out.push({ t: extent.to - s, text: t(`timeline.rewind.mark.${k}`) });
    return out;
  }, [extent, t]);

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="timeline-rewind">
      <section className={`rounded-card border bg-surface p-5 transition-colors ${isNow ? "border-line" : "border-accent/50"}`}>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <p className={`text-[0.6875rem] font-medium ${isNow ? "text-safe" : "text-accent"}`}>{t(isNow ? "timeline.rewind.present" : "timeline.rewind.past")}</p>
            <p className="num font-display text-[1.75rem] font-semibold leading-tight" data-testid="rewind-date">
              {new Date(at * 1000).toLocaleString(locale, { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}
            </p>
          </div>
          <Button icon={<SkipForward size={14} />} onClick={toPresent} disabled={isNow} data-testid="rewind-now">
            {t("timeline.rewind.toNow")}
          </Button>
        </div>
        <div
          ref={ref}
          className="relative mt-4 h-16 cursor-ew-resize touch-none select-none outline-none focus-visible:ring-2 focus-visible:ring-accent"
          role="slider"
          tabIndex={0}
          aria-label={t("timeline.rewind.slider")}
          aria-valuemin={extent.from}
          aria-valuemax={extent.to}
          aria-valuenow={Math.round(at)}
          aria-valuetext={fmt.dateTime(Math.round(at))}
          data-testid="rewind-slider"
          onKeyDown={(e) => {
            const by = e.shiftKey ? 86_400 : 3600;
            if (e.key === "ArrowLeft") onAt(Math.max(extent.from, at - by));
            else if (e.key === "ArrowRight") onAt(Math.min(now, at + by));
            else return;
            e.preventDefault();
          }}
          onPointerDown={(e) => {
            cancelAnimationFrame(back.current);
            e.currentTarget.setPointerCapture(e.pointerId);
            drag.current = true;
            onAt(toT(e.clientX - e.currentTarget.getBoundingClientRect().left));
          }}
          onPointerMove={(e) => drag.current && onAt(toT(e.clientX - e.currentTarget.getBoundingClientRect().left))}
          onPointerUp={() => (drag.current = false)}
          onPointerCancel={() => (drag.current = false)}
        >
          <svg width={w} height={64} className="pointer-events-none absolute inset-0 overflow-visible">
            <rect x={0} y={26} width={w} height={8} rx={4} fill="var(--color-raised)" />
            <rect x={0} y={26} width={toX(at)} height={8} rx={4} fill="var(--color-accent)" fillOpacity={0.35} />
            {events.map((e) => (isProblem(e) ? <circle key={e.id} cx={toX(e.t)} cy={18} r={e.kind === "crash" ? 4 : 2.5} fill={e.kind === "crash" ? "#e5484d" : "#e08a4a"} fillOpacity={0.85} /> : <rect key={e.id} x={toX(e.t) - 0.5} y={27} width={1.5} height={6} fill="var(--color-fg)" fillOpacity={0.28} />))}
            {marks.map((m) => (
              <g key={m.t}>
                <line x1={toX(m.t)} x2={toX(m.t)} y1={38} y2={44} stroke="var(--color-muted)" />
                <text x={toX(m.t)} y={56} textAnchor="middle" className="fill-muted text-[0.625rem]">
                  {m.text}
                </text>
              </g>
            ))}
            <line x1={toX(at)} x2={toX(at)} y1={8} y2={44} stroke="var(--color-accent)" strokeWidth={2} />
            <circle cx={toX(at)} cy={30} r={10} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={3} />
            <RewindIcon x={toX(at) - 5.5} y={24.5} width={11} height={11} color="var(--color-bg)" strokeWidth={2.5} />
          </svg>
        </div>
        <p className="mt-1 text-[0.6875rem] text-muted">{t("timeline.rewind.lead")}</p>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        {metric("cpu", Cpu, r?.cpu, c?.cpu, "%")}
        {metric("ram", MemoryStick, r?.ram, c?.ram, "%")}
        {metric("gpu", MonitorPlay, r?.gpu, c?.gpu, "%")}
        {metric("temp", Thermometer, r?.cpuTemp, c?.cpuTemp, " °C")}
        <Tile icon={HardDrive} title={t("timeline.moment.row.free")} trust={r?.freeMb ? "recorded" : "unknown"} now={!isNow && c?.freeMb ? fmt.bytes(c.freeMb * 1_048_576) : null}>
          <span className="num">{r?.freeMb ? fmt.bytes(r.freeMb * 1_048_576) : t("timeline.rewind.unknown")}</span>
        </Tile>
        <Tile icon={Network} title={t("timeline.moment.row.net")} trust={r && r.rx !== null ? "recorded" : "unknown"}>
          <span className="num text-[1rem]">{r && r.rx !== null ? `↓ ${fmt.bytes(r.rx)}${t("units.perSec")}` : t("timeline.rewind.unknown")}</span>
        </Tile>
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-3">
        {list("program", Package)}
        {list("startup", Rocket)}
        {list("driver", Cpu)}
      </div>

      <div className="grid items-start gap-3 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-1 flex items-center gap-2 text-[0.8125rem] font-medium">
            <Gauge size={15} className="text-accent" />
            {t("timeline.rewind.recent")}
          </h3>
          {recent.length ? recent.map((e) => <EventRow key={e.id} e={e} onPick={(x) => onAt(x.t)} />) : <p className="text-[0.75rem] text-muted">{t("timeline.rewind.quiet")}</p>}
        </section>
        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-1 flex items-center gap-2 text-[0.8125rem] font-medium">
            <ShieldAlert size={15} className="text-accent" />
            {t("timeline.rewind.safety")}
            <span className="ml-auto">
              <Mark trust={at - 7 * 86_400 >= logFrom ? "recorded" : at >= logFrom ? "partial" : "unknown"} />
            </span>
          </h3>
          {at < logFrom ? <p className="text-[0.75rem] text-muted">{t("timeline.rewind.unknownLong")}</p> : problems.length ? problems.slice(-5).reverse().map((e) => <EventRow key={e.id} e={e} onPick={(x) => onAt(x.t)} />) : <p className="text-[0.75rem] text-muted">{t("timeline.rewind.noProblems")}</p>}
        </section>
      </div>

      {/* Three different things, kept apart on purpose. */}
      <section className="grid gap-3 rounded-card border border-line bg-surface p-5 sm:grid-cols-3">
        {(
          [
            ["history", RewindIcon],
            ["current", Gauge],
            ["restore", Undo2],
          ] as const
        ).map(([k, Icon]) => (
          <div key={k}>
            <h4 className="flex items-center gap-2 text-[0.8125rem] font-medium">
              <Icon size={15} className="text-accent" />
              {t(`timeline.rewind.three.${k}.title`)}
            </h4>
            <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">{t(`timeline.rewind.three.${k}.text`)}</p>
            {k === "restore" && (
              <Button className="mt-2" onClick={() => go("journal")}>
                {t("timeline.rewind.three.restore.button")}
              </Button>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}
