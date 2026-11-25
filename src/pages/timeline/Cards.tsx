import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { AppWindow, ArrowUpRight, Gamepad2, GitBranch, History } from "lucide-react";
import { Button } from "../../components/ui";
import { go } from "../../lib/app";
import { useFmt } from "../../lib/format";
import { PAGE_OF, TRACKS, causes, iconOf, isProblem, laneOf, loadReadings, titleOf, valueOf, type Reading, type TimelineEvent } from "../../lib/timeline";
import type { Run } from "../../lib/levels";
import { useWidth } from "./Board";
import { Levels } from "./Levels";

export function Badge({ e, size = 32 }: { e: TimelineEvent; size?: number }) {
  const Icon = iconOf(e);
  const color = laneOf(e).color;
  return (
    <span className="flex shrink-0 items-center justify-center rounded-lg" style={{ width: size, height: size, background: `${color}26`, color }}>
      <Icon size={size * 0.5} />
    </span>
  );
}

export function useWhen() {
  const fmt = useFmt();
  const { t } = useTranslation();
  return (e: TimelineEvent) => (e.dayOnly ? t("timeline.thatDay", { date: fmt.date(e.t) }) : fmt.dateTime(e.t));
}

export function EventRow({ e, note, onPick }: { e: TimelineEvent; note?: string; onPick: (e: TimelineEvent) => void }) {
  const { t } = useTranslation();
  const when = useWhen();
  return (
    <button onClick={() => onPick(e)} className="flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-[0.75rem] hover:bg-raised">
      <Badge e={e} size={26} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">{titleOf(e, t)}</span>
        <span className="block truncate text-[0.6875rem] text-muted">{note ?? `${t(`timeline.action.${e.action}`)} · ${when(e)}`}</span>
      </span>
    </button>
  );
}

const AROUND = 45 * 60;

/** How the computer felt around an event: what was recorded, with the moment marked. */
function Around({ t: at }: { t: number }) {
  const { t } = useTranslation();
  const [ref, w] = useWidth<HTMLDivElement>(300);
  const [rs, setRs] = useState<Reading[] | null>(null);
  useEffect(() => {
    let alive = true;
    setRs(null);
    loadReadings(at - AROUND, at + AROUND, 60)
      .then((r) => alive && setRs(r))
      .catch(() => alive && setRs([]));
    return () => {
      alive = false;
    };
  }, [at]);
  const h = 62;
  const x = (s: number) => ((s - at + AROUND) / (2 * AROUND)) * w;
  const near = rs?.filter((r) => Math.abs(r.t - at) < 5 * 60) ?? [];
  const peak = (get: (r: Reading) => number | null) => near.reduce<number | null>((a, r) => (get(r) === null ? a : Math.max(a ?? -1, get(r)!)), null);
  return (
    <div ref={ref}>
      {rs && rs.length > 2 ? (
        <>
          <svg width={w} height={h} className="block rounded-lg bg-raised/40">
            {TRACKS.map((k) => {
              const pts: string[] = [];
              let d = "";
              let last = 0;
              for (const r of rs) {
                const v = k.get(r);
                if (v === null) continue;
                d += `${last && r.t - last < 240 ? "L" : "M"}${x(r.t + 30).toFixed(1)},${(h - 3 - Math.min(1, v / k.max) * (h - 8)).toFixed(1)}`;
                last = r.t;
                pts.push("");
              }
              return pts.length ? <path key={k.id} d={d} fill="none" stroke={k.color} strokeWidth={1.5} strokeOpacity={0.9} /> : null;
            })}
            <line x1={w / 2} x2={w / 2} y1={0} y2={h} stroke="var(--color-accent)" strokeWidth={1.5} strokeDasharray="3 3" />
          </svg>
          <div className="mt-1 flex justify-between text-[0.625rem] text-muted">
            <span>{t("timeline.card.before")}</span>
            <span>{t("timeline.card.moment")}</span>
            <span>{t("timeline.card.after")}</span>
          </div>
          {near.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem]">
              {TRACKS.map((k) => (
                <span key={k.id} className="flex items-center gap-1.5">
                  <span className="h-[3px] w-3 rounded-full" style={{ background: k.color }} />
                  <span className="text-muted">{t(`timeline.track.${k.id}`)}</span>
                  <span className="num">{peak(k.get) === null ? "—" : `${Math.round(peak(k.get)!)}${k.unit}`}</span>
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="text-[0.75rem] text-muted">{rs ? t("timeline.card.noReadings") : "…"}</p>
      )}
    </div>
  );
}

/** One event as a small analysis: what happened, what was going on, what it is tied to, what came next. */
export function EventCard({ e, all, onPick, onConnections, onRewind }: { e: TimelineEvent; all: TimelineEvent[]; onPick: (e: TimelineEvent) => void; onConnections?: (e: TimelineEvent) => void; onRewind?: (t: number) => void }) {
  const { t } = useTranslation();
  const when = useWhen();
  const page = PAGE_OF[e.kind];
  const value = valueOf(e, t);
  const problem = isProblem(e);
  const color = laneOf(e).color;
  const before = useMemo(() => (problem ? causes(e, all).slice(0, 4) : []), [e, all, problem]);
  const same = useMemo(() => all.filter((x) => x.kind === e.kind && x.name === e.name && x.id !== e.id).slice(-3).reverse(), [e, all]);
  const after = useMemo(() => all.filter((x) => isProblem(x) && x.id !== e.id && x.t > e.t && x.t - e.t < 3 * 86_400).slice(0, 3), [e, all]);
  const group = "mt-4 text-[0.6875rem] font-medium uppercase tracking-wide text-muted";
  return (
    <motion.section key={e.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden rounded-card border border-line bg-surface" data-testid="timeline-event">
      <div className="flex gap-3 border-b border-line p-5" style={{ background: `linear-gradient(120deg, ${color}1f, transparent 60%)` }}>
        <Badge e={e} size={40} />
        <div className="min-w-0 flex-1">
          <p className="text-[0.6875rem] font-medium" style={{ color }}>
            {t(`timeline.lane.${laneOf(e).id}.name`)} · {t(`timeline.action.${e.action}`)}
          </p>
          <h3 className="break-words font-display text-[1.125rem] font-semibold leading-snug">{titleOf(e, t)}</h3>
          <p className="num text-[0.75rem] text-muted">{when(e)}</p>
        </div>
        {e.kind === "alert" && <span className="num font-display text-[1.75rem] font-semibold leading-none">{value}</span>}
      </div>
      <div className="p-5 pt-4">
        {value && e.kind !== "service" && e.kind !== "alert" && <p className="num break-words text-[0.8125rem] font-medium">{value}</p>}
        {e.kind === "program" && e.now?.includes("\n") && <ul className="num mt-2 max-h-28 list-inside list-disc overflow-y-auto text-[0.6875rem] text-muted">{e.now.split("\n").map((l) => <li key={l}>{l}</li>)}</ul>}
        {e.kind === "service" && e.now && <p className="num break-all text-[0.6875rem] text-muted">{e.now}</p>}
        <p className="mt-2 text-[0.8125rem] leading-relaxed">{t(`timeline.about.${e.kind}`)}</p>
        <p className="mt-1 text-[0.6875rem] text-muted">{t(`timeline.source.${e.source}`)}</p>

        {!e.dayOnly && (
          <>
            <h4 className={`${group} mb-2`}>{t("timeline.card.around")}</h4>
            <Around t={e.t} />
          </>
        )}
        {problem && (
          <div data-testid="timeline-before">
            <h4 className={group}>{t("timeline.before.title")}</h4>
            {before.length ? (
              <>
                {before.map((c) => (
                  <EventRow key={c.e.id} e={c.e} onPick={onPick} note={`${t(`timeline.level.${c.level}`)} · ${c.e.dayOnly ? when(c.e) : t("timeline.before.ago", { hours: Math.max(1, Math.round((e.t - c.e.t) / 3600)) })}`} />
                ))}
                <p className="mt-1 text-[0.6875rem] leading-relaxed text-muted">{t("timeline.before.note")}</p>
              </>
            ) : (
              <p className="mt-1 text-[0.75rem] text-muted">{t("timeline.before.none")}</p>
            )}
          </div>
        )}
        {after.length > 0 && (
          <>
            <h4 className={group}>{t("timeline.card.next")}</h4>
            {after.map((x) => (
              <EventRow key={x.id} e={x} onPick={onPick} />
            ))}
          </>
        )}
        {same.length > 0 && (
          <>
            <h4 className={group}>{t("timeline.card.same")}</h4>
            {same.map((x) => (
              <EventRow key={x.id} e={x} onPick={onPick} />
            ))}
          </>
        )}
        {!e.dayOnly && (
          <div className="mt-5 border-t border-line pt-4">
            <Levels at={e.t} event={e} all={all} />
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {problem && onConnections && (
            <Button icon={<GitBranch size={14} />} onClick={() => onConnections(e)} data-testid="event-connections">
              {t("timeline.card.connections")}
            </Button>
          )}
          {onRewind && (
            <Button icon={<History size={14} />} onClick={() => onRewind(e.t)} data-testid="event-rewind">
              {t("timeline.card.rewind")}
            </Button>
          )}
          {page && (
            <Button icon={<ArrowUpRight size={14} />} onClick={() => go(page)}>
              {t("timeline.open", { page: t(`nav.${page}`) })}
            </Button>
          )}
        </div>
      </div>
    </motion.section>
  );
}

/** A program's stretch of work, and the machine under it. */
export function RunCard({ r, at, all, onPick, onRewind }: { r: Run; at: number; all: TimelineEvent[]; onPick: (e: TimelineEvent) => void; onRewind: (t: number) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const Icon = r.game ? Gamepad2 : AppWindow;
  const color = r.game ? "#7a4fd0" : "#2f6fb0";
  const inside = all.filter((e) => e.t >= r.start && e.t <= r.end + 120 && e.kind !== "power");
  const long = (s: number) => (s >= 5400 ? `${(s / 3600).toFixed(1)} ${t("units.h")}` : `${Math.max(1, Math.round(s / 60))} ${t("units.m")}`);
  return (
    <motion.section key={r.exe + r.start} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden rounded-card border border-line bg-surface" data-testid="timeline-run">
      <div className="flex gap-3 border-b border-line p-5" style={{ background: `linear-gradient(120deg, ${color}26, transparent 60%)` }}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ background: `${color}33`, color }}>
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.6875rem] font-medium" style={{ color }}>
            {t(r.game ? "timeline.run.game" : "timeline.run.program")}
          </p>
          <h3 className="break-words font-display text-[1.125rem] font-semibold leading-snug">{r.title || r.name}</h3>
          <p className="num text-[0.75rem] text-muted">
            {fmt.dateTime(r.start)} — {fmt.dateTime(r.end)}
          </p>
        </div>
      </div>
      <div className="p-5 pt-4">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[0.8125rem] sm:grid-cols-3">
          {(
            [
              ["worked", long(r.end - r.start)],
              ["front", long(r.front)],
              ["cpu", `${r.cpu}%`],
              ["mem", fmt.bytes(r.mem * 1_048_576)],
              ["disk", fmt.bytes(r.disk * 1_048_576)],
              ["company", r.company ?? "—"],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-[0.6875rem] text-muted">{t(`timeline.run.${k}`)}</dt>
              <dd className="num truncate font-medium" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
        <p className="num mt-2 break-all text-[0.6875rem] text-muted">{r.exe}</p>
        <div className="mt-5 border-t border-line pt-4">
          <Levels at={at} run={r} all={all} />
        </div>
        {inside.length > 0 && (
          <>
            <h4 className="mt-4 text-[0.6875rem] font-medium uppercase tracking-wide text-muted">{t("timeline.run.inside")}</h4>
            {inside.slice(0, 6).map((e) => (
              <EventRow key={e.id} e={e} onPick={onPick} />
            ))}
          </>
        )}
        <Button className="mt-4" icon={<History size={14} />} onClick={() => onRewind(at)}>
          {t("timeline.card.rewind")}
        </Button>
      </div>
    </motion.section>
  );
}

/** The chosen moment in words. */
export function MomentCard({ cursor, at, events, now, recordedFrom, onPick, onRewind }: { cursor: number; at: Reading | null; events: TimelineEvent[]; now: number; recordedFrom: number | null; onPick: (e: TimelineEvent) => void; onRewind: (t: number) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const words: string[] = [];
  if (at) {
    const temp = at.cpuTempMax ?? at.cpuTemp;
    if (at.hot > 0) words.push("throttled");
    else if (temp !== null && temp >= 90) words.push("hot");
    if ((at.ram ?? 0) >= 90) words.push("memory");
    if ((at.cpu ?? 0) >= 80) words.push("busy");
    if (at.freeMb !== null && at.freeMb < 10_240) words.push("disk");
    if (!words.length) words.push((at.cpu ?? 0) < 15 ? "calm" : "normal");
  }
  const near = events.filter((e) => e.t <= cursor + 60).slice(-4).reverse();
  return (
    <section className="rounded-card border border-line bg-surface p-5" data-testid="timeline-moment">
      <h3 className="num text-[0.75rem] text-muted">{now - cursor < 120 ? t("timeline.moment.now") : fmt.dateTime(Math.floor(cursor))}</h3>
      {at ? (
        <>
          <p className="mt-1 font-display text-[1.125rem] font-semibold leading-snug">{words.map((w) => t(`timeline.moment.${w}`)).join(". ")}</p>
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[0.8125rem] sm:grid-cols-3">
            {(
              [
                ["cpu", at.cpu === null ? "—" : `${Math.round(at.cpu)}%`],
                ["ram", at.ram === null ? "—" : `${Math.round(at.ram)}%`],
                ["temp", at.cpuTemp === null ? "—" : `${Math.round(at.cpuTemp)} °C`],
                ["gpu", at.gpu === null ? "—" : `${Math.round(at.gpu)}%`],
                ["net", at.rx === null ? "—" : `↓ ${fmt.bytes(at.rx)}${t("units.perSec")}`],
                ["free", at.freeMb === null ? "—" : fmt.bytes(at.freeMb * 1_048_576)],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-[0.6875rem] text-muted">{t(`timeline.moment.row.${k}`)}</dt>
                <dd className="num font-medium">{v}</dd>
              </div>
            ))}
          </dl>
          {at.top && <p className="mt-3 text-[0.75rem] text-muted">{t("timeline.moment.top", { name: at.top })}</p>}
        </>
      ) : (
        <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted">{recordedFrom && cursor >= recordedFrom ? t("timeline.moment.gap") : recordedFrom ? t("timeline.moment.before", { date: fmt.dateTime(recordedFrom) }) : t("timeline.moment.young")}</p>
      )}
      <Button className="mt-4" icon={<History size={14} />} onClick={() => onRewind(cursor)}>
        {t("timeline.card.rewind")}
      </Button>
      <div className="mt-5 border-t border-line pt-4">
        <Levels at={Math.floor(cursor / 60) * 60} all={events} />
      </div>
      <h4 className="mb-1 mt-4 text-[0.6875rem] text-muted">{t("timeline.moment.last")}</h4>
      {near.length ? near.map((e) => <EventRow key={e.id} e={e} onPick={onPick} />) : <p className="text-[0.75rem] text-muted">{t("timeline.moment.nothing")}</p>}
    </section>
  );
}

/** Everything on screen, newest first, by day. */
export function EventList({ events, picked, cursor, onPick }: { events: TimelineEvent[]; picked: TimelineEvent | null; cursor: number; onPick: (e: TimelineEvent) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [all, setAll] = useState(false);
  const list = all ? events : events.slice(0, 80);
  let day = "";
  return (
    <section className="rounded-card border border-line bg-surface p-5" data-testid="timeline-list">
      <h3 className="mb-2 flex items-baseline gap-2 text-[0.8125rem] font-medium">
        {t("timeline.list")}
        <span className="num text-[0.6875rem] font-normal text-muted">{events.length}</span>
      </h3>
      {!events.length && <p className="py-6 text-center text-[0.75rem] text-muted">{t("timeline.listEmpty")}</p>}
      <div className="max-h-[34rem] overflow-y-auto pr-1">
        {list.map((e) => {
          const d = fmt.date(e.t);
          const head = d !== day;
          day = d;
          return (
            <div key={e.id}>
              {head && <div className="num sticky top-0 z-10 bg-surface pb-1 pt-2 text-[0.6875rem] text-muted">{d}</div>}
              <button onClick={() => onPick(e)} className={`flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left text-[0.75rem] hover:bg-raised ${picked?.id === e.id ? "bg-raised" : e.t > cursor + 60 ? "opacity-55" : ""}`}>
                <Badge e={e} size={24} />
                <span className="min-w-0 flex-1 truncate">{titleOf(e, t)}</span>
                <span className="shrink-0 text-[0.6875rem] text-muted">{t(`timeline.action.${e.action}`)}</span>
                <span className="num w-10 shrink-0 text-right text-[0.6875rem] text-muted">{e.dayOnly ? "" : new Date(e.t * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" })}</span>
              </button>
            </div>
          );
        })}
        {!all && events.length > 80 && (
          <button onClick={() => setAll(true)} className="w-full py-2 text-[0.75rem] text-accent">
            {t("timeline.showAll", { count: events.length })}
          </button>
        )}
      </div>
    </section>
  );
}
