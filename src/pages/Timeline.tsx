import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Camera, CircleHelp, Clock, Crosshair, Database, GitBranch, GitCompareArrows, Layers, Loader2, MousePointerClick, Move, Pause, Play, Radio, Rewind as RewindIcon, Spline, ZoomIn } from "lucide-react";
import { useFmt } from "../lib/format";
import { LANES, TRACKS, laneOf, loadEvents, loadReadings, type LaneId, type Reading, type Row, type Stats, type TimelineEvent, type TrackId } from "../lib/timeline";
import { Board, Overview, type View } from "./timeline/Board";
import { EventCard, EventList, MomentCard } from "./timeline/Cards";
import { Compare } from "./timeline/Compare";
import { Connections } from "./timeline/Connections";
import { Rewind } from "./timeline/Rewind";
import { Memory, Snapshots } from "./timeline/Archive";

const DAY = 86_400;
const PRESETS = [
  ["day", DAY],
  ["week", 7 * DAY],
  ["month", 30 * DAY],
  ["quarter", 91 * DAY],
] as const;
const SECTIONS = [
  ["line", Clock],
  ["rewind", RewindIcon],
  ["connections", GitBranch],
  ["compare", GitCompareArrows],
  ["snapshots", Camera],
  ["memory", Database],
] as const;
type Section = (typeof SECTIONS)[number][0];
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
  const still = useReducedMotion();
  const [now, setNow] = useState(seconds);
  const [stats, setStats] = useState<Stats | null>(null);
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [present, setPresent] = useState<Row[]>([]);
  const [tab, setTab] = useState<Section>("line");
  const [view, setView] = useState<View>(() => ({ from: seconds() - 7 * DAY, to: seconds() }));
  const [cursor, setCursor] = useState(seconds);
  const [picked, setPicked] = useState<TimelineEvent | null>(null);
  const [problem, setProblem] = useState<TimelineEvent | null>(null);
  const [readings, setReadings] = useState<Reading[]>([]);
  const [step, setStep] = useState(60);
  const [tracks, setTracks] = useState(() => remembered("timeline.tracksOff", TRACK_IDS));
  const [lanes, setLanes] = useState(() => remembered("timeline.lanesOff", LANE_IDS));
  const [layers, setLayers] = useState(false);
  const [links, setLinks] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [help, setHelp] = useState(() => {
    try {
      return localStorage.getItem("timeline.helpSeen") !== "1";
    } catch {
      return true;
    }
  });
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, e, p] = await Promise.all([invoke<Stats>("timeline_stats"), loadEvents(), invoke<Row[]>("timeline_present")]);
      setStats(s);
      setEvents(e);
      setPresent(p);
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

  // The view and the moment glide to where they are sent.
  const live = useRef({ cursor, view });
  live.current = { cursor, view };
  const glide = useRef(0);
  const send = (to: View, moment?: number) => {
    cancelAnimationFrame(glide.current);
    const a = { ...live.current };
    if (still) {
      setView(to);
      if (moment !== undefined) setCursor(moment);
      return;
    }
    const began = performance.now();
    const tick = (n: number) => {
      const k = Math.min(1, (n - began) / 550);
      const e = 1 - (1 - k) ** 3;
      setView({ from: a.view.from + (to.from - a.view.from) * e, to: a.view.to + (to.to - a.view.to) * e });
      if (moment !== undefined) setCursor(a.cursor + (moment - a.cursor) * e);
      if (k < 1) glide.current = requestAnimationFrame(tick);
    };
    glide.current = requestAnimationFrame(tick);
  };
  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  // Playing: the moment walks through what is on screen in about twenty seconds.
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (at: number) => {
      const p = live.current;
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
    const w = view.to - view.from;
    if (e.t >= view.from && e.t <= view.to) return setCursor(e.t);
    const from = Math.min(Math.max(e.t - w / 2, extent.from), extent.to - w);
    send({ from, to: from + w }, e.t);
  };
  const toggle = <T extends string>(set: Set<T>, id: T) => {
    const next = new Set(set);
    if (!next.delete(id)) next.add(id);
    return next;
  };
  const preset = (w: number) => {
    const width = Math.min(w, extent.to - extent.from);
    const to = Math.min(extent.to, Math.max(extent.from + width, cursor + (now - cursor < width / 2 ? width : width / 2)));
    send({ from: to - width, to });
  };
  const closeHelp = () => {
    setHelp(false);
    try {
      localStorage.setItem("timeline.helpSeen", "1");
    } catch {
      /* this session only */
    }
  };
  const rewindTo = (s: number) => {
    setCursor(Math.min(now, s));
    setTab("rewind");
  };

  if (error && !events) return <div className="rounded-card border border-line bg-surface p-6 text-center text-[0.8125rem] text-muted">{t("timeline.error")}</div>;
  if (!events || !stats)
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-[0.8125rem] text-muted">
        <Loader2 size={16} className="animate-spin" />
        {t("timeline.loading")}
      </div>
    );

  const tool = (on: boolean) => `flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.75rem] ${on ? "border-accent/60 bg-accent/10 text-fg" : "border-line text-muted hover:bg-raised hover:text-fg"}`;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4 pb-6" data-testid="timeline-page">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6" role="tablist">
        {SECTIONS.map(([k, Icon]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`relative overflow-hidden rounded-xl border px-3.5 py-2.5 text-left transition-colors ${tab === k ? "border-accent/60" : "border-line bg-surface hover:bg-raised"}`} data-testid={`timeline-tab-${k}`}>
            {tab === k && <motion.span layoutId="timeline-tab" className="absolute inset-0 bg-accent/10" transition={{ type: "spring", stiffness: 420, damping: 36 }} />}
            <span className="relative flex items-center gap-2.5">
              <Icon size={17} className={tab === k ? "text-accent" : "text-muted"} />
              <span className="min-w-0">
                <span className="block text-[0.8125rem] font-semibold leading-tight">{t(`timeline.tab.${k}`)}</span>
                <span className="block truncate text-[0.6875rem] text-muted">{t(`timeline.tabHint.${k}`)}</span>
              </span>
            </span>
          </button>
        ))}
      </div>

      {tab === "compare" ? (
        <Compare events={events} stats={stats} now={now} />
      ) : tab === "rewind" ? (
        <Rewind at={cursor} onAt={setCursor} extent={extent} events={events} stats={stats} present={present} now={now} />
      ) : tab === "connections" ? (
        <Connections all={events} start={problem} />
      ) : tab === "snapshots" ? (
        <Snapshots present={present} onChange={load} />
      ) : tab === "memory" ? (
        <Memory
          events={events}
          stats={stats}
          now={now}
          onReload={() => {
            setPicked(null);
            load();
          }}
          onPick={(e) => {
            setTab("line");
            focus(e);
          }}
        />
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
                    [Spline, "links"],
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
                  cancelAnimationFrame(glide.current);
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
                <button onClick={() => send(extent)} className={`rounded-md px-2.5 py-1 ${Math.abs(view.from - extent.from) < 60 ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid="timeline-all">
                  {t("timeline.preset.all")}
                </button>
              </div>
              <button
                onClick={() => {
                  const w = view.to - view.from;
                  setPicked(null);
                  setPlaying(false);
                  send({ from: now - w, to: now }, now);
                }}
                className={tool(false)}
                data-testid="timeline-now"
              >
                <Crosshair size={13} />
                {t("timeline.toNow")}
              </button>
              <button onClick={() => setLayers(!layers)} aria-pressed={layers} className={tool(layers)} title={t("timeline.layersHint")} data-testid="timeline-layers">
                <Layers size={13} />
                {t("timeline.layers")}
              </button>
              <button onClick={() => setLinks(!links)} aria-pressed={links} className={tool(links)} title={t("timeline.linksHint")} data-testid="timeline-links">
                <Spline size={13} />
                {t("timeline.links")}
              </button>
              <span className={`ml-auto flex items-center gap-1.5 text-[0.6875rem] ${stats.paused ? "text-warn" : "text-muted"}`} title={t("timeline.recordHint")}>
                <Radio size={13} className={stats.paused ? "" : "text-safe"} />
                {stats.paused ? t("timeline.paused") : t("timeline.recording", { size: fmt.bytes(stats.bytes) })}
              </span>
              <button onClick={() => (help ? closeHelp() : setHelp(true))} aria-expanded={help} title={t("timeline.help.title")} aria-label={t("timeline.help.title")} className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-raised hover:text-fg" data-testid="timeline-help">
                <CircleHelp size={15} />
              </button>
            </div>
            <Board
              view={view}
              extent={extent}
              onView={(v) => {
                cancelAnimationFrame(glide.current);
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
              layers={layers}
              links={links}
              playing={playing}
            />
            <div className="mt-3">
              <Overview
                extent={extent}
                view={view}
                onView={(v) => {
                  cancelAnimationFrame(glide.current);
                  setView(v);
                }}
                events={shown}
              />
            </div>
          </section>

          <div className="grid items-start gap-4 lg:grid-cols-2">
            {picked ? (
              <EventCard
                e={picked}
                all={events}
                onPick={focus}
                onRewind={rewindTo}
                onConnections={(e) => {
                  setProblem(e);
                  setTab("connections");
                }}
              />
            ) : (
              <MomentCard cursor={cursor} at={at} events={shown} now={now} recordedFrom={stats.firstReading} onPick={focus} onRewind={rewindTo} />
            )}
            <EventList events={inView} picked={picked} cursor={cursor} onPick={focus} />
          </div>
        </>
      )}
    </div>
  );
}
