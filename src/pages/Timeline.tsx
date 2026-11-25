import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, CircleHelp, Crosshair, Eraser, Loader2, MousePointerClick, Move, Pause, Play, Radio, ZoomIn } from "lucide-react";
import { Button, Modal } from "../components/ui";
import { go } from "../lib/app";
import { useFmt } from "../lib/format";
import { LANES, PAGE_OF, TRACKS, before, laneOf, loadEvents, loadReadings, titleOf, valueOf, type LaneId, type Reading, type Stats, type TimelineEvent, type TrackId } from "../lib/timeline";
import { Board, Overview, type View } from "./timeline/Board";
import { Compare } from "./timeline/Compare";

const DAY = 86_400;
const PRESETS = [
  ["day", DAY],
  ["week", 7 * DAY],
  ["month", 30 * DAY],
  ["quarter", 91 * DAY],
] as const;
const seconds = () => Math.floor(Date.now() / 1000);

function remembered<T extends string>(key: string, all: readonly T[]): Set<T> {
  try {
    const off = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
    return new Set(all.filter((x) => !off.includes(x)));
  } catch {
    return new Set(all);
  }
}
function remember(key: string, all: readonly string[], on: Set<string>) {
  try {
    localStorage.setItem(key, JSON.stringify(all.filter((x) => !on.has(x))));
  } catch {
    /* this session only */
  }
}
const TRACK_IDS = TRACKS.map((k) => k.id);
const LANE_IDS = LANES.map((l) => l.id);

export function Timeline() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [now, setNow] = useState(seconds);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [tab, setTab] = useState<"line" | "compare">("line");
  const [view, setView] = useState<View>(() => ({ from: seconds() - 7 * DAY, to: seconds() }));
  const [cursor, setCursor] = useState(seconds);
  const [picked, setPicked] = useState<TimelineEvent | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [step, setStep] = useState(60);
  const [tracks, setTracks] = useState(() => remembered("timeline.tracksOff", TRACK_IDS));
  const [lanes, setLanes] = useState(() => remembered("timeline.lanesOff", LANE_IDS));
  const [playing, setPlaying] = useState(false);
  const [help, setHelp] = useState(() => {
    try {
      return localStorage.getItem("timeline.helpSeen") !== "1";
    } catch {
      return true;
    }
  });
  const [erasing, setErasing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, e] = await Promise.all([invoke<Stats>("timeline_stats"), loadEvents()]);
      setStats(s);
      setEvents(e);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);
  useEffect(() => {
    load();
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setNow(seconds());
      load();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const extent = useMemo<View>(() => {
    const first = Math.min(stats?.firstEvent ?? now, stats?.firstReading ?? now, now - 30 * DAY);
    return { from: first - DAY, to: now };
  }, [stats?.firstEvent, stats?.firstReading, now]);

  // Readings for what is on screen (and a little beyond), as fine as the pixels can show.
  useEffect(() => {
    const span = view.to - view.from;
    const s = Math.max(60, Math.ceil(span / 700 / 60) * 60);
    let alive = true;
    const id = window.setTimeout(() => {
      loadReadings(view.from - span / 2, view.to + span / 2, s)
        .then((r) => {
          if (!alive) return;
          setReadings(r);
          setStep(s);
        })
        .catch(() => {});
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
  }, [view.from, view.to, now]);

  // Playing: the moment walks through what is on screen in about twenty seconds.
  const play = useRef({ cursor, view, extent });
  play.current = { cursor, view, extent };
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (at: number) => {
      const p = play.current;
      const next = p.cursor + ((at - last) / 20_000) * (p.view.to - p.view.from);
      last = at;
      if (next >= p.view.to) {
        setCursor(p.view.to);
        setPlaying(false);
        return;
      }
      setCursor(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const at = useMemo(() => {
    let best: Reading | null = null;
    for (const r of readings) if (Math.abs(r.t + step / 2 - cursor) < Math.abs((best?.t ?? -1e12) + step / 2 - cursor)) best = r;
    return best && Math.abs(best.t + step / 2 - cursor) <= Math.max(step, 60) * 2 ? best : null;
  }, [readings, cursor, step]);

  const shown = useMemo(() => (events ?? []).filter((e) => lanes.has(laneOf(e).id)), [events, lanes]);
  const inView = useMemo(() => shown.filter((e) => e.t >= view.from && e.t <= view.to).reverse(), [shown, view.from, view.to]);

  const focus = (e: TimelineEvent) => {
    setPlaying(false);
    setPicked(e);
    setCursor(e.t);
    setView((v) => {
      if (e.t >= v.from && e.t <= v.to) return v;
      const w = v.to - v.from;
      const from = Math.min(Math.max(e.t - w / 2, extent.from), extent.to - w);
      return { from, to: from + w };
    });
  };
  const toggle = <T extends string>(set: Set<T>, id: T) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const preset = (w: number) => {
    const width = Math.min(w, extent.to - extent.from);
    // Around the chosen moment, unless that is now.
    const to = Math.min(extent.to, Math.max(extent.from + width, cursor + (now - cursor < width / 2 ? width : width / 2)));
    setView({ from: to - width, to });
  };
  const closeHelp = () => {
    setHelp(false);
    try {
      localStorage.setItem("timeline.helpSeen", "1");
    } catch {
      /* this session only */
    }
  };

  if (error && !events) return <div className="rounded-card border border-line bg-surface p-6 text-center text-[0.8125rem] text-muted">{t("timeline.error")}</div>;
  if (!events || !stats)
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-[0.8125rem] text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t("timeline.loading")}
      </div>
    );

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 pb-6" data-testid="timeline-page">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-line bg-surface p-0.5" role="tablist">
          {(["line", "compare"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`relative h-8 rounded-md px-3.5 text-[0.75rem] ${tab === k ? "text-fg" : "text-muted hover:text-fg"}`} data-testid={`timeline-tab-${k}`}>
              {tab === k && <motion.span layoutId="timeline-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
              <span className="relative">{t(`timeline.tab.${k}`)}</span>
            </button>
          ))}
        </div>
        <span className={`flex items-center gap-1.5 text-[0.6875rem] ${stats.paused ? "text-warn" : "text-muted"}`} title={t("timeline.recordHint")}>
          <Radio size={13} className={stats.paused ? "" : "text-safe"} />
          {stats.paused ? t("timeline.paused") : t("timeline.recording", { size: fmt.bytes(stats.bytes) })}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button icon={stats.paused ? <Play size={14} /> : <Pause size={14} />} onClick={() => invoke("timeline_pause", { on: !stats.paused }).then(load)} data-testid="timeline-pause">
            {t(stats.paused ? "timeline.resume" : "timeline.pause")}
          </Button>
          <Button icon={<Eraser size={14} />} onClick={() => setErasing(true)} data-testid="timeline-erase">
            {t("timeline.erase")}
          </Button>
          <button onClick={() => (help ? closeHelp() : setHelp(true))} aria-expanded={help} title={t("timeline.help.title")} aria-label={t("timeline.help.title")} className="flex h-9 w-9 items-center justify-center rounded-lg border border-line text-muted hover:bg-raised hover:text-fg" data-testid="timeline-help">
            <CircleHelp size={16} />
          </button>
        </div>
      </div>

      {tab === "compare" ? (
        <Compare events={events} stats={stats} now={now} />
      ) : (
        <>
          {help && (
            <div className="rounded-card border border-accent/30 bg-accent/5 px-5 py-4" data-testid="timeline-help-card">
              <div className="flex items-start gap-4">
                <p className="flex-1 text-[0.8125rem] leading-relaxed">{t("timeline.help.lead")}</p>
                <button onClick={closeHelp} className="shrink-0 text-[0.75rem] font-medium text-accent">
                  {t("timeline.help.ok")}
                </button>
              </div>
              <ul className="mt-3 grid gap-2 text-[0.75rem] text-muted sm:grid-cols-2 lg:grid-cols-4">
                {(
                  [
                    [Move, "drag"],
                    [ZoomIn, "zoom"],
                    [MousePointerClick, "click"],
                    [Play, "play"],
                  ] as const
                ).map(([Icon, k]) => (
                  <li key={k} className="flex gap-2">
                    <Icon size={15} className="mt-0.5 shrink-0 text-accent" />
                    {t(`timeline.help.${k}`)}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <section className="rounded-card border border-line bg-surface p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                onClick={() => {
                  if (!playing && (cursor >= view.to - (view.to - view.from) / 100 || cursor < view.from)) setCursor(view.from);
                  setPicked(null);
                  setPlaying(!playing);
                }}
                className="flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-[0.75rem] font-semibold text-bg"
                data-testid="timeline-play"
              >
                {playing ? <Pause size={13} /> : <Play size={13} />}
                {t(playing ? "timeline.stop" : "timeline.play")}
              </button>
              <div className="flex rounded-lg border border-line p-0.5 text-[0.75rem]">
                {PRESETS.map(([k, w]) => (
                  <button key={k} onClick={() => preset(w)} className={`rounded-md px-2.5 py-1 ${Math.abs(view.to - view.from - w) < 60 ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`timeline-${k}`}>
                    {t(`timeline.preset.${k}`)}
                  </button>
                ))}
                <button onClick={() => setView(extent)} className={`rounded-md px-2.5 py-1 ${view.from === extent.from ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid="timeline-all">
                  {t("timeline.preset.all")}
                </button>
              </div>
              <button
                onClick={() => {
                  const w = view.to - view.from;
                  setPicked(null);
                  setCursor(now);
                  setView({ from: now - w, to: now });
                }}
                className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[0.75rem] text-muted hover:bg-raised hover:text-fg"
                data-testid="timeline-now"
              >
                <Crosshair size={13} />
                {t("timeline.toNow")}
              </button>
              <span className="ml-auto text-[0.6875rem] text-muted">{t("timeline.hint")}</span>
            </div>
            <Board
              view={view}
              extent={extent}
              onView={(v) => {
                setPlaying(false);
                setView(v);
              }}
              cursor={cursor}
              onCursor={(c) => {
                setPlaying(false);
                setCursor(c);
              }}
              readings={readings}
              step={step}
              events={shown}
              picked={picked}
              onPick={setPicked}
              tracks={tracks}
              lanes={lanes}
              onTrack={(id: TrackId) => {
                const next = toggle(tracks, id);
                setTracks(next);
                remember("timeline.tracksOff", TRACK_IDS, next);
              }}
              onLane={(id: LaneId) => {
                const next = toggle(lanes, id);
                setLanes(next);
                remember("timeline.lanesOff", LANE_IDS, next);
              }}
              at={at}
            />
            <div className="mt-3">
              <Overview extent={extent} view={view} onView={setView} events={shown} />
            </div>
          </section>

          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            {picked ? <EventCard e={picked} all={events} onPick={focus} /> : <MomentCard cursor={cursor} at={at} events={shown} now={now} recordedFrom={stats.firstReading} onPick={focus} />}
            <EventList events={inView} picked={picked} cursor={cursor} onPick={focus} />
          </div>
        </>
      )}

      <Modal open={erasing} onClose={() => setErasing(false)}>
        <h2 className="font-display text-[1.0625rem] font-semibold">{t("timeline.eraseTitle")}</h2>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{t("timeline.eraseText")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setErasing(false)}>{t("timeline.cancel")}</Button>
          <Button
            variant="danger"
            onClick={async () => {
              await invoke("timeline_erase").catch(() => {});
              setErasing(false);
              setPicked(null);
              setReadings([]);
              load();
            }}
            data-testid="timeline-erase-yes"
          >
            {t("timeline.eraseYes")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function Dot({ e }: { e: TimelineEvent }) {
  return <span className="mt-[0.4rem] h-2 w-2 shrink-0 rounded-full" style={{ background: laneOf(e).color }} />;
}

function useWhen() {
  const fmt = useFmt();
  const { t } = useTranslation();
  return (e: TimelineEvent) => (e.dayOnly ? t("timeline.thatDay", { date: fmt.date(e.t) }) : fmt.dateTime(e.t));
}

/** The chosen moment in words. */
function MomentCard({ cursor, at, events, now, recordedFrom, onPick }: { cursor: number; at: Reading | null; events: TimelineEvent[]; now: number; recordedFrom: number | null; onPick: (e: TimelineEvent) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const when = useWhen();
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
      <h3 className="text-[0.75rem] text-muted">{now - cursor < 120 ? t("timeline.moment.now") : fmt.dateTime(Math.floor(cursor))}</h3>
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
      <h4 className="mb-1 mt-4 text-[0.6875rem] text-muted">{t("timeline.moment.last")}</h4>
      {near.length ? (
        near.map((e) => (
          <button key={e.id} onClick={() => onPick(e)} className="flex w-full gap-2.5 rounded-md px-1.5 py-1 text-left text-[0.75rem] hover:bg-raised">
            <Dot e={e} />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{titleOf(e, t)}</span>
              <span className="text-[0.6875rem] text-muted">
                {t(`timeline.action.${e.action}`)} · {when(e)}
              </span>
            </span>
          </button>
        ))
      ) : (
        <p className="text-[0.75rem] text-muted">{t("timeline.moment.nothing")}</p>
      )}
    </section>
  );
}

/** One event: what it is, why it matters, what to do, and for a crash — what changed before it. */
function EventCard({ e, all, onPick }: { e: TimelineEvent; all: TimelineEvent[]; onPick: (e: TimelineEvent) => void }) {
  const { t } = useTranslation();
  const when = useWhen();
  const page = PAGE_OF[e.kind];
  const value = valueOf(e, t);
  const crash = e.kind === "crash" || e.kind === "appcrash";
  const earlier = crash ? before(e, all) : [];
  const again = crash ? all.filter((x) => x.kind === e.kind && x.name === e.name && x.id !== e.id).length : 0;
  return (
    <motion.section key={e.id} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.18 }} className="rounded-card border border-line bg-surface p-5" data-testid="timeline-event">
      <div className="flex gap-2.5">
        <Dot e={e} />
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-display text-[1.0625rem] font-semibold leading-snug">{titleOf(e, t)}</h3>
          <p className="text-[0.75rem] text-muted">
            {t(`timeline.lane.${laneOf(e).id}.name`)} · {t(`timeline.action.${e.action}`)} · {when(e)}
          </p>
        </div>
      </div>
      {value && e.kind !== "service" && <p className="num mt-3 break-words text-[0.8125rem]">{value}</p>}
      {e.kind === "program" && e.now?.includes("\n") && <ul className="num mt-2 max-h-28 list-inside list-disc overflow-y-auto text-[0.6875rem] text-muted">{e.now.split("\n").map((l) => <li key={l}>{l}</li>)}</ul>}
      {e.kind === "service" && e.now && <p className="num mt-3 break-all text-[0.6875rem] text-muted">{e.now}</p>}
      <p className="mt-3 text-[0.8125rem] leading-relaxed">{t(`timeline.about.${e.kind}`)}</p>
      {again > 0 && <p className="mt-1 text-[0.75rem] text-warn">{t("timeline.again", { count: again })}</p>}
      <p className="mt-2 text-[0.6875rem] text-muted">{t(`timeline.source.${e.source}`)}</p>
      {crash && (
        <div className="mt-4 rounded-xl bg-raised/60 px-4 py-3" data-testid="timeline-before">
          <h4 className="text-[0.75rem] font-medium">{t("timeline.before.title")}</h4>
          {earlier.length ? (
            <>
              {earlier.map((x) => (
                <button key={x.id} onClick={() => onPick(x)} className="mt-1 flex w-full gap-2.5 rounded-md px-1.5 py-1 text-left text-[0.75rem] hover:bg-surface">
                  <Dot e={x} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{titleOf(x, t)}</span>
                    <span className="text-[0.6875rem] text-muted">{x.dayOnly ? when(x) : t("timeline.before.ago", { hours: Math.max(1, Math.round((e.t - x.t) / 3600)) })}</span>
                  </span>
                </button>
              ))}
              <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted">{t("timeline.before.note")}</p>
            </>
          ) : (
            <p className="mt-1 text-[0.75rem] text-muted">{t("timeline.before.none")}</p>
          )}
        </div>
      )}
      {page && (
        <Button className="mt-4" icon={<ArrowUpRight size={14} />} onClick={() => go(page)}>
          {t("timeline.open", { page: t(`nav.${page}`) })}
        </Button>
      )}
    </motion.section>
  );
}

/** Everything on screen, newest first, by day. */
function EventList({ events, picked, cursor, onPick }: { events: TimelineEvent[]; picked: TimelineEvent | null; cursor: number; onPick: (e: TimelineEvent) => void }) {
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
      <div className="max-h-[28rem] overflow-y-auto pr-1">
        {list.map((e) => {
          const d = fmt.date(e.t);
          const head = d !== day;
          day = d;
          return (
            <div key={e.id}>
              {head && <div className="sticky top-0 z-10 bg-surface pb-1 pt-2 text-[0.6875rem] text-muted">{d}</div>}
              <button onClick={() => onPick(e)} className={`flex w-full gap-2.5 rounded-md px-2 py-1.5 text-left text-[0.75rem] hover:bg-raised ${picked?.id === e.id ? "bg-raised" : e.t > cursor + 60 ? "opacity-55" : ""}`}>
                <Dot e={e} />
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
