import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { AppWindow, Gamepad2, Pause, Play, RotateCcw, TrendingDown, TrendingUp, X } from "lucide-react";
import { useFmt } from "../../lib/format";
import { story, type Beat, type Run } from "../../lib/levels";
import { laneOf, titleOf, type Reading, type TimelineEvent } from "../../lib/timeline";
import { Badge } from "./Cards";

/** Seconds a whole stretch takes to tell, by speed. */
const SPEEDS = [1, 2, 4] as const;

/** A chosen stretch of time told step by step: time runs, and what happened appears as it happens. */
export function Story({
  from,
  to,
  events,
  runs,
  readings,
  onCursor,
  onEvent,
  onRun,
  onClose,
}: {
  from: number;
  to: number;
  events: TimelineEvent[];
  runs: Run[];
  readings: Reading[];
  onCursor: (t: number) => void;
  onEvent: (e: TimelineEvent) => void;
  onRun: (r: Run) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const still = useReducedMotion();
  const beats = useMemo(() => story(from, to, events, runs, readings), [from, to, events, runs, readings]);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    setShown(0);
    setPlaying(false);
  }, [from, to]);

  // Each step gets time to be read; the moment on the board glides to it.
  useEffect(() => {
    if (!playing) return;
    if (shown >= beats.length) {
      onCursor(to);
      setPlaying(false);
      return;
    }
    const a = shown ? beats[shown - 1].t : from;
    const b = beats[shown].t;
    const wait = (still ? 300 : Math.min(2200, 700 + Math.sqrt(Math.max(0, b - a)) * 14)) / speed;
    const began = performance.now();
    let raf = 0;
    const tick = (n: number) => {
      const k = Math.min(1, (n - began) / wait);
      onCursor(a + (b - a) * k);
      if (k < 1) raf = requestAnimationFrame(tick);
      else setShown(shown + 1);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, shown, speed, beats]);

  useEffect(() => {
    const el = list.current;
    if (el && playing) el.scrollTo({ top: el.scrollHeight, behavior: still ? "auto" : "smooth" });
  }, [shown, playing, still]);

  const told = playing || shown > 0 ? beats.slice(0, shown) : beats;
  const problem = [...beats].reverse().find((b) => b.bad && b.event);
  const label = (b: Beat) => {
    if (b.kind === "event") return titleOf(b.event!, t);
    if (b.kind === "run") return t(b.run!.game ? "timeline.story.game" : "timeline.story.run", { name: b.run!.title || b.run!.name });
    if (b.kind === "end") return t("timeline.story.end", { name: b.run!.title || b.run!.name });
    return t(`timeline.story.${b.key}`, b.v ?? {});
  };
  const note = (b: Beat) => {
    if (b.kind === "event") return `${t(`timeline.lane.${laneOf(b.event!).id}.name`)} · ${t(`timeline.action.${b.event!.action}`)}`;
    if (b.kind === "change") return t("timeline.story.measured");
    return b.run!.name;
  };
  const clock = (s: number) => new Date(s * 1000).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <section className="rounded-card border border-accent/50 bg-surface p-5" data-testid="story">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-[0.8125rem] font-medium">{t("timeline.story.title")}</h3>
          <p className="num text-[0.75rem] text-muted">
            {fmt.dateTime(Math.floor(from))} — {fmt.dateTime(Math.floor(to))} · {t("timeline.story.count", { count: beats.length })}
          </p>
        </div>
        <button
          onClick={() => {
            if (!playing && (shown === 0 || shown >= beats.length)) {
              setShown(0);
              onCursor(from);
            }
            setPlaying(!playing);
          }}
          disabled={!beats.length}
          className="flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-[0.75rem] font-semibold text-bg disabled:opacity-40"
          data-testid="story-play"
        >
          {playing ? <Pause size={13} /> : <Play size={13} />}
          {t(playing ? "timeline.stop" : "timeline.play")}
        </button>
        <div className="flex rounded-lg border border-line p-0.5 text-[0.6875rem]">
          {SPEEDS.map((s) => (
            <button key={s} onClick={() => setSpeed(s)} aria-pressed={speed === s} className={`rounded-md px-2 py-1 ${speed === s ? "bg-raised text-fg" : "text-muted"}`}>
              {s}×
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setPlaying(false);
            setShown(0);
            onCursor(from);
          }}
          title={t("timeline.story.again")}
          aria-label={t("timeline.story.again")}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-raised"
        >
          <RotateCcw size={13} />
        </button>
        <button onClick={onClose} title={t("timeline.story.close")} aria-label={t("timeline.story.close")} className="flex h-8 w-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-raised" data-testid="story-close">
          <X size={14} />
        </button>
      </div>
      {!beats.length && <p className="py-6 text-center text-[0.75rem] text-muted">{t("timeline.story.empty")}</p>}
      <ol ref={list} className="relative mt-3 max-h-[24rem] overflow-y-auto pr-1">
        <AnimatePresence initial={false}>
          {told.map((b, i) => (
            <motion.li key={b.id} initial={{ opacity: 0, x: -14 }} animate={{ opacity: 1, x: 0 }} transition={{ type: "spring", stiffness: 380, damping: 30 }} data-testid="beat">
              <button
                onClick={() => {
                  setPlaying(false);
                  onCursor(b.t);
                  if (b.event) onEvent(b.event);
                  else if (b.run) onRun(b.run);
                }}
                className={`flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-raised ${playing && i === told.length - 1 ? "bg-raised" : ""}`}
              >
                <span className="num w-16 shrink-0 text-[0.6875rem] text-muted">{clock(b.t)}</span>
                {b.event ? (
                  <Badge e={b.event} size={26} />
                ) : (
                  <span className={`flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg ${b.bad ? "bg-risk/15 text-risk" : "bg-accent/15 text-accent"}`}>
                    {b.kind === "change" ? b.key?.endsWith("Down") ? <TrendingDown size={14} /> : <TrendingUp size={14} /> : b.run?.game ? <Gamepad2 size={14} /> : <AppWindow size={14} />}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[0.8125rem] ${b.bad ? "font-medium text-risk" : ""}`}>{label(b)}</span>
                  <span className="block truncate text-[0.6875rem] text-muted">{note(b)}</span>
                </span>
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
      </ol>
      {!playing && shown >= beats.length && shown > 0 && <p className="mt-3 rounded-lg bg-raised/60 px-3 py-2 text-[0.75rem] leading-relaxed">{problem ? t("timeline.story.endBad", { name: label(problem), count: beats.indexOf(problem) }) : t("timeline.story.endOk")}</p>}
    </section>
  );
}
