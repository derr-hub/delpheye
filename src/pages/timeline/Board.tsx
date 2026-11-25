import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AppWindow, Gamepad2, Power } from "lucide-react";
import type { Run } from "../../lib/levels";
import { LANES, TRACKS, awake, causes, isProblem, iconOf, laneOf, titleOf, type LaneId, type Level, type Reading, type TimelineEvent, type TrackId } from "../../lib/timeline";

export interface View {
  from: number;
  to: number;
}

const AXIS_H = 30;
const ROW = 42;
const SMALL = 20;
const GAP = 6;
const TRACK_H = 44;
const LAYERS_H = 150;
export const NARROWEST = 20 * 60;

const STEPS = [300, 900, 1800, 3600, 2 * 3600, 6 * 3600, 12 * 3600, 86_400, 2 * 86_400, 7 * 86_400, 14 * 86_400, 30 * 86_400, 91 * 86_400];

function ticks(v: View, width: number): { t: number; step: number }[] {
  const want = Math.max(2, width / 110);
  const step = STEPS.find((s) => (v.to - v.from) / s <= want) ?? STEPS[STEPS.length - 1];
  const d = new Date(v.from * 1000);
  const zero = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const out = [];
  for (let t = zero + Math.floor((v.from - zero) / step) * step; t <= v.to; t += step) if (t >= v.from) out.push({ t, step });
  return out;
}

export function useWidth<T extends HTMLElement>(start = 800) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(start);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function fit(v: View, extent: View): View {
  const width = Math.min(Math.max(v.to - v.from, NARROWEST), extent.to - extent.from);
  const mid = (v.from + v.to) / 2;
  let from = v.to - v.from === width ? v.from : mid - width / 2;
  from = Math.min(Math.max(from, extent.from), extent.to - width);
  return { from, to: from + width };
}

interface Block {
  key: string;
  from: number;
  to: number;
  label: string;
  color: string;
}
interface Group {
  lane: LaneId;
  items: TimelineEvent[];
  x: number;
  end: number;
  w: number;
  y: number;
}

const LINK: Record<Level, { color: string; dash?: string }> = { likely: { color: "#ef5a60" }, possible: { color: "#f0a04b", dash: "7 5" }, timing: { color: "#8b95a5", dash: "2 5" } };

/** An orthogonal line with rounded corners between two rows. */
function elbow(x1: number, y1: number, x2: number, y2: number) {
  if (Math.abs(x2 - x1) < 2) return `M${x1},${y1}V${y2}`;
  const mid = y1 + (y2 > y1 ? 1 : -1) * Math.min(14, Math.abs(y2 - y1) / 2);
  const r = Math.min(7, Math.abs(x2 - x1) / 2, Math.abs(mid - y1), Math.abs(y2 - mid));
  const sx = Math.sign(x2 - x1);
  const sy = Math.sign(y2 - y1);
  return `M${x1},${y1}V${mid - sy * r}Q${x1},${mid} ${x1 + sx * r},${mid}H${x2 - sx * r}Q${x2},${mid} ${x2},${mid + sy * r}V${y2}`;
}

/** Rows of blocks: what ran, how the computer felt and what changed, with the links between them. */
export function Board({
  view,
  extent,
  onView,
  cursor,
  onCursor,
  readings,
  step,
  events,
  picked,
  onPick,
  tracks,
  lanes,
  onTrack,
  onLane,
  at,
  layers,
  links,
  playing,
  runs,
  run,
  onRun,
  span: chosen,
  onSpan,
  choosing,
}: {
  view: View;
  extent: View;
  onView: (v: View) => void;
  cursor: number;
  onCursor: (t: number) => void;
  readings: Reading[];
  step: number;
  events: TimelineEvent[];
  picked: TimelineEvent | null;
  onPick: (e: TimelineEvent | null) => void;
  tracks: Set<TrackId>;
  lanes: Set<LaneId>;
  onTrack: (id: TrackId) => void;
  onLane: (id: LaneId) => void;
  at: Reading | null;
  /** All tracks and events drawn over one another. */
  layers: boolean;
  links: boolean;
  playing: boolean;
  runs: Run[];
  run: Run | null;
  onRun: (r: Run) => void;
  /** A stretch chosen with Shift, or with the interval tool on. */
  span: View | null;
  onSpan: (v: View | null) => void;
  choosing: boolean;
}) {
  const { t, i18n } = useTranslation();
  const [ref, w] = useWidth<HTMLDivElement>();
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; items: TimelineEvent[] } | null>(null);
  const drag = useRef<{ x: number; view: View; moved: boolean; pick: boolean } | null>(null);
  const locale = i18n.language.startsWith("uk") ? "uk-UA" : "en-US";

  const span = view.to - view.from;
  const x = (s: number) => ((s - view.from) / span) * w;
  const time = (px: number) => view.from + (px / w) * span;

  /** Programs at work, in as few rows as they need (three at most): games and long work first. */
  const works = useMemo(() => {
    const least = span > 20 * 86_400 ? 1800 : span > 3 * 86_400 ? 300 : span > 86_400 ? 90 : 15;
    const list = runs.filter((r) => (r.front >= least || (r.game && r.end - r.start >= least)) && r.end >= view.from && r.start <= view.to).sort((a, b) => Number(b.game) - Number(a.game) || b.front - a.front);
    const taken: [number, number][][] = [[], [], []];
    const out: { r: Run; row: number }[] = [];
    for (const r of list.slice(0, 160)) {
      const pad = span / 260;
      const row = taken.findIndex((x) => x.every(([a, b]) => r.end + pad < a || r.start - pad > b));
      if (row < 0) continue;
      taken[row].push([r.start, r.end]);
      out.push({ r, row });
    }
    return { out, rows: Math.max(1, taken.filter((x) => x.length).length) };
  }, [runs, view.from, view.to, span]);
  const empty = useMemo(() => new Set(LANES.filter((l) => !events.some((e) => laneOf(e).id === l.id)).map((l) => l.id)), [events]);
  const past = useMemo(() => awake(events, extent.to), [events, extent.to]);

  const rows = useMemo(() => {
    let y = AXIS_H;
    const take = (h: number) => {
      const at0 = y;
      y += h + GAP;
      return at0;
    };
    const session = take(26);
    const activity = take(works.rows * 30 + 8);
    const overlay = layers ? take(LAYERS_H) : 0;
    const tr = TRACKS.map((k) => {
      const on = tracks.has(k.id);
      const h = layers ? 0 : on ? TRACK_H : SMALL;
      return { k, on, y: layers ? 0 : take(h), h };
    });
    const ln = LANES.map((l) => {
      const on = lanes.has(l.id);
      const h = on && !empty.has(l.id) ? ROW : SMALL;
      return { l, on, y: take(h), h };
    });
    return { session, activity, overlay, tr, ln, h: y };
  }, [tracks, lanes, layers, works.rows, empty]);

  // The page must not scroll while the wheel zooms, so the listener is not passive.
  const live = useRef({ view, w, extent, onView });
  live.current = { view, w, extent, onView };
  useEffect(() => {
    const el = svg.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, w: width, extent: ex, onView: set } = live.current;
      const s = v.to - v.from;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.deltaX || e.deltaY) / width) * s;
        return set(fit({ from: v.from + d, to: v.to + d }, ex));
      }
      const k = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.0045);
      const p = (e.clientX - el.getBoundingClientRect().left) / width;
      const here = v.from + p * s;
      set(fit({ from: here - p * s * k, to: here + (1 - p) * s * k }, ex));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const broke = (a: Reading, b: Reading) => b.t - a.t > Math.max(step, a.n * 60, b.n * 60) * 2.5 + 60;

  /** When the computer was watched, and what kept it busy. */
  const { sessions, activity } = useMemo(() => {
    const ses: Block[] = [];
    const act: Block[] = [];
    let last: Reading | null = null;
    for (const r of readings) {
      const end = r.t + Math.max(step, 60);
      const gap = !last || broke(last, r);
      if (gap) ses.push({ key: `s${r.t}`, from: r.t, to: end, label: "", color: "var(--color-accent)" });
      else ses[ses.length - 1].to = end;
      const a = act[act.length - 1];
      const hot = r.hot > 0 || (r.cpuTempMax ?? 0) >= 95;
      const busy = (r.cpu ?? 0) >= 50 || (r.gpu ?? 0) >= 60;
      const name = r.top ?? "";
      const color = hot ? "#d8434a" : busy ? "#2d7fd3" : "#4b6380";
      if (a && !gap && a.label === name && a.color === color) a.to = end;
      else if (a && !gap && end - a.from < span / 140 && act.length) a.to = end;
      else act.push({ key: `a${r.t}`, from: r.t, to: end, label: name, color });
      last = r;
    }
    return { sessions: ses, activity: act };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readings, step, span]);

  const shapes = useMemo(
    () =>
      TRACKS.map((k) => {
        const runs: [number, number][][] = [];
        let run: [number, number][] = [];
        let last: Reading | null = null;
        for (const r of readings) {
          const v = k.get(r);
          if (v === null || (last && broke(last, r))) {
            if (run.length) runs.push(run);
            run = [];
          }
          if (v !== null) {
            run.push([r.t + Math.max(step, 60) / 2, Math.min(1, v / k.max)]);
            last = r;
          }
        }
        if (run.length) runs.push(run);
        return { id: k.id, runs };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [readings, step],
  );

  /** Events of a lane as blocks: each starts at its moment; close ones share a block. */
  const groups = useMemo(() => {
    const out: Group[] = [];
    for (const row of rows.ln) {
      if (!row.on || empty.has(row.l.id)) continue;
      const mine: Group[] = [];
      for (const e of events) {
        if (laneOf(e).id !== row.l.id || e.t < view.from - span * 0.1 || e.t > view.to) continue;
        const px = x(e.t);
        const g = mine[mine.length - 1];
        if (g && px - g.end < 36) {
          g.items.push(e);
          g.end = px;
        } else mine.push({ lane: row.l.id, items: [e], x: px, end: px, w: 0, y: row.y });
      }
      mine.forEach((g, i) => {
        const room = (mine[i + 1]?.x ?? w + 40) - g.x - 12;
        const text = (g.items.length > 1 ? `${titleOf(g.items[0], t)} +${g.items.length - 1}` : titleOf(g.items[0], t)).length;
        g.w = Math.max(30, g.end - g.x + 30, Math.min(room, 40 + text * 6.1, 230));
      });
      out.push(...mine);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, rows, view.from, view.to, w, t]);

  const where = useMemo(() => {
    const m = new Map<string, Group>();
    for (const g of groups) for (const e of g.items) m.set(e.id, g);
    return m;
  }, [groups]);

  /** Lines from a change to the problem after it. All of the picked one's, the strongest of the others'. */
  const lines = useMemo(() => {
    if (!links) return [];
    const problems = picked && (isProblem(picked)) ? [picked] : groups.filter((g) => g.lane === "crash").map((g) => g.items.find((e) => e.kind === "crash") ?? g.items[g.items.length - 1]).slice(-8);
    const seen = new Set<string>();
    const out: { key: string; d: string; level: Level; strong: boolean }[] = [];
    for (const p of problems) {
      const to = where.get(p.id);
      if (!to) continue;
      const strong = picked?.id === p.id;
      for (const c of causes(p, events).slice(0, strong ? 6 : 1)) {
        if (!strong && c.level === "timing") continue;
        const from = where.get(c.e.id);
        if (!from || from === to) continue;
        const key = `${from.lane}${from.x}-${to.lane}${to.x}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const below = from.y > to.y;
        out.push({ key, level: c.level, strong, d: elbow(from.x + 14, below ? from.y + 5 : from.y + ROW - 5, to.x + 14, below ? to.y + ROW - 5 : to.y + 5) });
      }
    }
    return out;
  }, [links, picked, groups, where, events]);

  const label = (s: number, st: number) => {
    const d = new Date(s * 1000);
    if (st < 86_400 && (d.getHours() || d.getMinutes())) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(locale, st >= 30 * 86_400 ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" });
  };
  const stamp = new Date(cursor * 1000).toLocaleString(locale, span > 60 * 86_400 ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const cx = x(cursor);
  const px = (e: { clientX: number }) => e.clientX - svg.current!.getBoundingClientRect().left;
  const head = "absolute left-0 right-3 flex items-center gap-2.5 rounded-lg border border-line/60 bg-raised/50 px-2.5 text-left transition-colors hover:bg-raised";
  const length = (s: number) => (s >= 5400 ? `${Math.round(s / 3600)} ${t("units.h")}` : `${Math.max(1, Math.round(s / 60))} ${t("units.m")}`);

  const plot = (id: TrackId, color: string, y: number, h: number, soft: boolean) => {
    const py = (v: number) => y + h - 2 - v * (h - 6);
    return shapes
      .find((s) => s.id === id)!
      .runs.map((run, i) => {
        if (x(run[run.length - 1][0]) < -20 || x(run[0][0]) > w + 20) return null;
        const pts = run.map(([s, v]) => `${x(s).toFixed(1)},${py(v).toFixed(1)}`);
        if (pts.length === 1) return <circle key={i} cx={x(run[0][0])} cy={py(run[0][1])} r={2} fill={color} />;
        return (
          <g key={i}>
            <path d={`M${pts.join("L")}L${x(run[run.length - 1][0]).toFixed(1)},${y + h}L${x(run[0][0]).toFixed(1)},${y + h}Z`} fill={color} fillOpacity={soft ? 0.1 : 0.18} />
            <path d={`M${pts.join("L")}`} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeOpacity={soft ? 0.85 : 1} />
          </g>
        );
      });
  };

  return (
    <div className="flex" data-testid="timeline-board">
      <div className="relative w-[10.5rem] shrink-0" style={{ height: rows.h }}>
        <div className="absolute left-0 right-3 flex items-center gap-2.5 px-2.5 text-[0.6875rem] text-muted" style={{ top: rows.session, height: 26 }}>
          <Power size={14} className="shrink-0 text-accent" />
          {t("timeline.row.session")}
        </div>
        <div className={head} style={{ top: rows.activity, height: works.rows * 30 + 8 }}>
          <AppWindow size={15} className="shrink-0 text-accent" />
          <span className="min-w-0 text-[0.75rem]">
            <span className="block">{t("timeline.row.activity")}</span>
            <span className="block truncate text-[0.625rem] text-muted">{at?.top ?? "—"}</span>
          </span>
        </div>
        {layers && (
          <div className="absolute left-0 right-3 flex flex-col justify-center gap-1" style={{ top: rows.overlay, height: LAYERS_H }}>
            {TRACKS.map((k) => {
              const v = at ? k.get(at) : null;
              return (
                <button key={k.id} onClick={() => onTrack(k.id)} aria-pressed={tracks.has(k.id)} className={`flex items-center gap-2 rounded-md px-2 py-1 text-[0.6875rem] text-muted hover:bg-raised ${tracks.has(k.id) ? "" : "opacity-40"}`}>
                  <span className="h-[3px] w-3 rounded-full" style={{ background: k.color }} />
                  {t(`timeline.track.${k.id}`)}
                  <span className="num ml-auto text-fg">{v === null ? "—" : `${Math.round(v)}${k.unit}`}</span>
                </button>
              );
            })}
          </div>
        )}
        {!layers &&
          rows.tr.map(({ k, on, y, h }) => {
            const v = at ? k.get(at) : null;
            return (
              <button key={k.id} onClick={() => onTrack(k.id)} aria-pressed={on} title={t("timeline.toggle")} className={`${head} ${on ? "" : "opacity-45"}`} style={{ top: y, height: h }} data-testid={`track-${k.id}`}>
                <span className="h-[3px] w-3.5 shrink-0 rounded-full" style={{ background: k.color }} />
                <span className="min-w-0 flex-1 truncate text-[0.6875rem] text-muted">{t(`timeline.track.${k.id}`)}</span>
                {on && <span className="num text-[0.8125rem] font-medium">{v === null ? "—" : `${Math.round(v)}${k.unit}`}</span>}
              </button>
            );
          })}
        {rows.ln.map(({ l, on, y, h }) => (
          <button key={l.id} onClick={() => onLane(l.id)} aria-pressed={on} title={t(`timeline.lane.${l.id}.hint`)} className={`${head} ${on ? "" : "opacity-45"}`} style={{ top: y, height: h }} data-testid={`lane-${l.id}`}>
            <l.icon size={on ? 15 : 12} className="shrink-0" style={{ color: l.color }} />
            <span className="truncate text-[0.75rem]">{t(`timeline.lane.${l.id}.name`)}</span>
            {empty.has(l.id) && <span className="ml-auto shrink-0 text-[0.625rem] text-muted">{t("timeline.emptyLane")}</span>}
          </button>
        ))}
      </div>

      <div ref={ref} className="relative min-w-0 flex-1">
        <svg
          ref={svg}
          width={w}
          height={rows.h}
          className={`block touch-none select-none outline-none ${choosing ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing"} focus-visible:ring-2 focus-visible:ring-accent`}
          tabIndex={0}
          role="application"
          aria-label={t("timeline.boardLabel")}
          data-testid="timeline-svg"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            svg.current!.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, view, moved: false, pick: e.shiftKey || choosing };
            if (e.shiftKey || choosing) onSpan(null);
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
            if (d.moved && d.pick) {
              const a = view.from + ((d.x - svg.current!.getBoundingClientRect().left) / w) * span;
              const b = time(px(e));
              const keep = (s: number) => Math.min(extent.to, Math.max(extent.from, s));
              onSpan({ from: keep(Math.min(a, b)), to: keep(Math.max(a, b)) });
              return;
            }
            if (d.moved) {
              const by = ((d.x - e.clientX) / w) * (d.view.to - d.view.from);
              setHover(null);
              onView(fit({ from: d.view.from + by, to: d.view.to + by }, extent));
            }
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (!d || d.moved) return;
            const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-mark]");
            const g = hit ? groups[Number(hit.getAttribute("data-mark"))] : null;
            const job = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-run]");
            if (job) {
              const w0 = works.out[Number(job.getAttribute("data-run"))];
              if (w0) {
                onRun(w0.r);
                return onCursor(Math.min(Math.max(time(px(e)), w0.r.start), w0.r.end));
              }
            }
            if (g) {
              const first = g.items[0].t;
              const last = g.items[g.items.length - 1].t;
              const open = g.items.findIndex((i) => i.id === picked?.id);
              // A second click on a crowd opens it up; the first shows what is in it.
              if (open >= 0 && g.items.length > 1 && last - first > 60) onView(fit({ from: first - (last - first) * 0.4 - 600, to: last + (last - first) * 0.4 + 600 }, extent));
              const next = open >= 0 ? g.items[(open + 1) % g.items.length] : (g.items.find((i) => i.kind === "crash") ?? g.items[0]);
              onPick(next);
              onCursor(next.t);
            } else {
              onPick(null);
              onCursor(Math.min(extent.to, time(px(e))));
            }
          }}
          onPointerCancel={() => (drag.current = null)}
          onDoubleClick={(e) => {
            if (document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-mark],[data-run]")) return;
            const here = time(px(e));
            onView(fit({ from: here - span / 6, to: here + span / 6 }, extent));
          }}
          onKeyDown={(e) => {
            const by = e.shiftKey ? span / 10 : span / 60;
            if (e.key === "ArrowLeft") onCursor(Math.max(extent.from, cursor - by));
            else if (e.key === "ArrowRight") onCursor(Math.min(extent.to, cursor + by));
            else if (e.key === "+" || e.key === "=") onView(fit({ from: cursor - span / 4, to: cursor + span / 4 }, extent));
            else if (e.key === "-") onView(fit({ from: cursor - span, to: cursor + span }, extent));
            else return;
            e.preventDefault();
          }}
        >
          <defs>
            {LANES.map((l) => (
              <linearGradient key={l.id} id={`tl-${l.id}`} x1="0" x2="1">
                <stop offset="0" stopColor={l.color} stopOpacity={0.95} />
                <stop offset="1" stopColor={l.color} stopOpacity={0.55} />
              </linearGradient>
            ))}
            {(["likely", "possible", "timing"] as const).map((k) => (
              <marker key={k} id={`tl-arrow-${k}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto">
                <path d="M0,0L8,4L0,8Z" fill={LINK[k].color} />
              </marker>
            ))}
          </defs>
          {ticks(view, w).map(({ t: s, step: st }) => (
            <g key={s}>
              <line x1={x(s)} x2={x(s)} y1={AXIS_H - 8} y2={rows.h} stroke="var(--color-line)" strokeOpacity={0.55} />
              <circle cx={x(s)} cy={AXIS_H - 9} r={2.5} fill="var(--color-muted)" />
              <text x={x(s) + 5} y={12} className="fill-muted text-[0.625rem]">
                {label(s, st)}
              </text>
            </g>
          ))}

          {/* The thread of time, bright where the computer was watched. */}
          <line x1={0} x2={w} y1={rows.session + 13} y2={rows.session + 13} stroke="var(--color-line)" strokeWidth={6} strokeLinecap="round" />
          {past.map((b) => {
            const a = Math.max(0, x(b.from));
            const z = Math.min(w, x(b.to));
            return z < 0 || a > w || z - a < 0.5 ? null : <line key={`p${b.from}`} x1={a} x2={z} y1={rows.session + 13} y2={rows.session + 13} stroke="var(--color-accent)" strokeOpacity={0.28} strokeWidth={6} strokeLinecap="round" />;
          })}
          {sessions.map((b) => {
            const a = Math.max(0, x(b.from));
            const z = Math.min(w, x(b.to));
            if (z < 0 || a > w) return null;
            return (
              <g key={b.key}>
                <line x1={a} x2={Math.max(a + 1, z)} y1={rows.session + 13} y2={rows.session + 13} stroke="var(--color-accent)" strokeOpacity={0.55} strokeWidth={6} strokeLinecap="round" />
                {x(b.from) >= 0 && <circle cx={x(b.from)} cy={rows.session + 13} r={4} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={1.5} />}
              </g>
            );
          })}

          {works.out.map(({ r, row }, i) => {
            const a = Math.max(-6, x(r.start));
            const width = Math.max(4, Math.min(w + 6, x(r.end)) - a);
            const on = run?.exe === r.exe && run.start === r.start;
            const y = rows.activity + 4 + row * 30;
            const Icon = r.game ? Gamepad2 : AppWindow;
            const name = r.title || r.name.replace(/\.exe$/i, "");
            const room = Math.floor((width - 30) / 6.1);
            return (
              <g key={`${r.exe}${r.start}`} data-run={i} className="tl-block cursor-pointer">
                <title>{`${name} · ${length(r.end - r.start)}`}</title>
                {on && <rect x={a - 2.5} y={y - 1.5} width={width + 5} height={29} rx={9} fill="none" stroke="var(--color-accent)" strokeWidth={2} />}
                <rect x={a} y={y + 1} width={width} height={24} rx={Math.min(7, width / 2)} fill={r.game ? "#7a4fd0" : "#2f6fb0"} fillOpacity={0.85} />
                {width > 26 && <Icon x={a + 8} y={y + 6} width={14} height={14} color="#fff" strokeWidth={2} />}
                {room >= 4 && (
                  <text x={a + 27} y={y + 17} className="text-[0.6875rem] font-medium" fill="#fff" pointerEvents="none">
                    {name.length > room ? `${name.slice(0, room - 1)}…` : name}
                  </text>
                )}
              </g>
            );
          })}
          {!works.out.length && activity.map((b) => {
            const a = Math.max(-4, x(b.from));
            const z = Math.min(w + 4, x(b.to));
            if (z < 0 || a > w || z - a < 0.8) return null;
            const width = Math.max(1, z - a - 1.5);
            return (
              <g key={b.key}>
                <title>{`${b.label || t("timeline.row.quiet")} · ${length(b.to - b.from)}`}</title>
                <rect x={a} y={rows.activity + 6} width={width} height={26} rx={Math.min(7, width / 2)} fill={b.color} fillOpacity={b.label ? 0.78 : 0.28} />
                {width > 70 && b.label && (
                  <text x={a + 9} y={rows.activity + 22.5} className="text-[0.6875rem] font-medium" fill="#fff" pointerEvents="none">
                    {`${b.label.replace(/\.exe$/i, "")}${width > 150 ? ` · ${length(b.to - b.from)}` : ""}`.slice(0, Math.floor((width - 14) / 6.2))}
                  </text>
                )}
              </g>
            );
          })}

          {layers && (
            <g>
              <rect x={0} y={rows.overlay} width={w} height={LAYERS_H} rx={8} fill="var(--color-raised)" fillOpacity={0.35} />
              {groups.map((g) => (
                <rect key={`${g.lane}${g.items[0].id}`} x={g.x - 1} y={rows.overlay} width={Math.max(3, g.end - g.x + 3)} height={LAYERS_H} fill={LANES.find((l) => l.id === g.lane)!.color} fillOpacity={0.22} />
              ))}
              {TRACKS.filter((k) => tracks.has(k.id)).map((k) => (
                <g key={k.id}>{plot(k.id, k.color, rows.overlay, LAYERS_H, true)}</g>
              ))}
            </g>
          )}
          {!layers &&
            rows.tr.map(({ k, on, y, h }) =>
              on ? (
                <g key={k.id}>
                  <rect x={0} y={y} width={w} height={h} rx={8} fill="var(--color-raised)" fillOpacity={0.35} />
                  {plot(k.id, k.color, y, h, false)}
                  {k.id === "temp" && readings.filter((r) => r.hot > 0).map((r) => <rect key={r.t} x={x(r.t)} y={y} width={Math.max(2, (Math.max(step, 60) / span) * w)} height={h} fill="#e5484d" fillOpacity={0.28} />)}
                </g>
              ) : (
                <line key={k.id} x1={0} x2={w} y1={y + h / 2} y2={y + h / 2} stroke="var(--color-line)" strokeDasharray="2 5" />
              ),
            )}
          {!readings.length && !works.out.length && (
            <text x={w / 2} y={rows.activity + 22} textAnchor="middle" className="fill-muted text-[0.6875rem]">
              {t("timeline.noReadings")}
            </text>
          )}

          {rows.ln.map(({ l, on, y, h }) => (
            <line key={l.id} x1={0} x2={w} y1={y + h / 2} y2={y + h / 2} stroke="var(--color-line)" strokeOpacity={0.8} strokeDasharray={on ? undefined : "2 5"} />
          ))}
          {lines.map((l) => (
            <path key={l.key} d={l.d} fill="none" stroke={LINK[l.level].color} strokeWidth={l.strong ? 2 : 1.3} strokeOpacity={l.strong ? 0.95 : 0.45} strokeDasharray={LINK[l.level].dash ?? "9 5"} markerEnd={`url(#tl-arrow-${l.level})`} className={l.strong ? "tl-flow" : undefined} pointerEvents="none" />
          ))}

          {groups.map((g, i) => {
            const lane = LANES.find((l) => l.id === g.lane)!;
            const on = !!picked && g.items.some((e) => e.id === picked.id);
            const first = on ? picked! : (g.items.find((e) => e.kind === "crash") ?? g.items[0]);
            const Icon = iconOf(first);
            const room = Math.floor((g.w - 34) / 6.1);
            const text = `${titleOf(first, t)}${g.items.length > 1 ? ` +${g.items.length - 1}` : ""}`;
            const passing = playing && cx >= g.x - 2 && cx <= g.x + 26;
            const next = groups[i + 1]?.lane === g.lane ? groups[i + 1] : null;
            const tail = g.x + g.w;
            return (
              <g key={`${g.lane}${g.items[0].id}`}>
                {next && next.x - tail > 12 && <path d={`M${tail + 2},${g.y + ROW / 2}H${next.x - 5}`} stroke={lane.color} strokeOpacity={0.5} strokeWidth={1.2} markerEnd="" pointerEvents="none" />}
                {next && next.x - tail > 12 && <path d={`M${next.x - 8},${g.y + ROW / 2 - 3}l5,3l-5,3Z`} fill={lane.color} fillOpacity={0.7} pointerEvents="none" />}
                <g data-mark={i} className="tl-block cursor-pointer" onPointerEnter={() => !drag.current && setHover({ x: g.x, y: g.y, items: g.items })} onPointerLeave={() => setHover(null)}>
                  {(on || passing) && <rect x={g.x - 3} y={g.y + 3} width={g.w + 6} height={ROW - 6} rx={10} fill="none" stroke={on ? "var(--color-accent)" : lane.color} strokeWidth={2} className={passing ? "tl-pulse" : undefined} />}
                  {on && lane.id === "crash" && <rect x={g.x - 3} y={g.y + 3} width={g.w + 6} height={ROW - 6} rx={10} fill="none" stroke="#ef5a60" strokeWidth={2} className="tl-wave" />}
                  <rect x={g.x} y={g.y + 6} width={g.w} height={ROW - 12} rx={7} fill={`url(#tl-${lane.id})`} />
                  <rect x={g.x + 0.5} y={g.y + 6.5} width={g.w - 1} height={ROW - 13} rx={6.5} fill="none" stroke="#fff" strokeOpacity={0.18} />
                  <rect x={g.x} y={g.y + 6} width={3} height={ROW - 12} rx={1.5} fill="#fff" fillOpacity={0.85} />
                  <Icon x={g.x + 9} y={g.y + ROW / 2 - 7.5} width={15} height={15} color="#fff" strokeWidth={2} />
                  {room >= 4 ? (
                    <text x={g.x + 30} y={g.y + ROW / 2 + 3.8} className="text-[0.6875rem] font-medium" fill="#fff" pointerEvents="none">
                      {text.length > room ? `${text.slice(0, room - 1)}…` : text}
                    </text>
                  ) : g.items.length > 1 ? (
                    <g pointerEvents="none">
                      <circle cx={g.x + g.w - 1} cy={g.y + 8} r={7.5} fill="var(--color-surface)" stroke={lane.color} />
                      <text x={g.x + g.w - 1} y={g.y + 11} textAnchor="middle" className="num fill-fg text-[0.5625rem] font-semibold">
                        {g.items.length > 99 ? "99" : g.items.length}
                      </text>
                    </g>
                  ) : null}
                </g>
              </g>
            );
          })}
          {chosen && (
            <g pointerEvents="none" data-testid="timeline-span">
              <rect x={x(chosen.from)} y={AXIS_H - 10} width={Math.max(1, x(chosen.to) - x(chosen.from))} height={rows.h - AXIS_H + 10} fill="var(--color-accent)" fillOpacity={0.1} />
              {[chosen.from, chosen.to].map((s) => (
                <line key={s} x1={x(s)} x2={x(s)} y1={AXIS_H - 10} y2={rows.h} stroke="var(--color-accent)" strokeDasharray="4 4" />
              ))}
            </g>
          )}
          {cx >= 0 && cx <= w && <line x1={cx} x2={cx} y1={AXIS_H - 10} y2={rows.h} stroke="var(--color-accent)" strokeWidth={1.5} pointerEvents="none" />}
        </svg>
        {cx >= 0 && cx <= w && (
          <div className="num pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-accent px-1.5 py-0.5 text-[0.625rem] font-semibold text-bg" style={{ left: Math.min(Math.max(cx, 46), w - 46) }}>
            {stamp}
          </div>
        )}
        {hover && (
          <div className="pointer-events-none absolute z-20 max-w-[19rem] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[0.6875rem] shadow-lg" style={{ left: Math.min(Math.max(0, hover.x), Math.max(0, w - 240)), bottom: rows.h - hover.y }}>
            {hover.items.slice(0, 5).map((e) => (
              <div key={e.id} className="truncate">
                {titleOf(e, t)} <span className="text-muted">{t(`timeline.action.${e.action}`)}</span>
              </div>
            ))}
            {hover.items.length > 5 && <div className="text-muted">{t("timeline.more", { count: hover.items.length - 5 })}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** The whole history in one strip: the bright window is what the board shows. */
export function Overview({ extent, view, onView, events }: { extent: View; view: View; onView: (v: View) => void; events: TimelineEvent[] }) {
  const { t, i18n } = useTranslation();
  const [ref, w] = useWidth<HTMLDivElement>();
  const grab = useRef<number | null>(null);
  const span = extent.to - extent.from;
  const x = (s: number) => ((s - extent.from) / span) * w;
  const bins = useMemo(() => {
    const n = Math.max(20, Math.floor(w / 5));
    const b = Array.from({ length: n }, () => ({ n: 0, bad: 0 }));
    for (const e of events) {
      const i = Math.min(n - 1, Math.max(0, Math.floor(((e.t - extent.from) / span) * n)));
      b[i].n++;
      if (e.kind === "crash") b[i].bad++;
    }
    return b;
  }, [events, extent.from, span, w]);
  const top = Math.max(1, ...bins.map((b) => b.n));
  const width = view.to - view.from;
  const move = (clientX: number) => {
    const at = extent.from + ((clientX - ref.current!.getBoundingClientRect().left) / w) * span;
    const from = Math.min(Math.max(at - (grab.current ?? 0.5) * width, extent.from), extent.to - width);
    onView({ from, to: from + width });
  };
  const month = (s: number) => new Date(s * 1000).toLocaleDateString(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { month: "short", year: "numeric" });
  return (
    <div className="pl-[10.5rem]">
      <div
        ref={ref}
        className="relative h-10 cursor-pointer touch-none overflow-hidden rounded-lg border border-line bg-raised/40"
        title={t("timeline.overview")}
        data-testid="timeline-overview"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = extent.from + ((e.clientX - ref.current!.getBoundingClientRect().left) / w) * span;
          grab.current = p >= view.from && p <= view.to ? (p - view.from) / width : 0.5;
          move(e.clientX);
        }}
        onPointerMove={(e) => grab.current !== null && move(e.clientX)}
        onPointerUp={() => (grab.current = null)}
        onPointerCancel={() => (grab.current = null)}
      >
        <svg width={w} height={38} className="pointer-events-none absolute inset-0">
          {bins.map((b, i) => {
            const h = 4 + (Math.sqrt(b.n) / Math.sqrt(top)) * 22;
            return b.n ? <rect key={i} x={(i / bins.length) * w} y={26 - h} width={Math.max(2, w / bins.length - 1.5)} height={h} rx={1} fill={b.bad ? "#e5484d" : "var(--color-muted)"} fillOpacity={b.bad ? 0.9 : 0.5} /> : null;
          })}
        </svg>
        <span className="pointer-events-none absolute bottom-0 left-1.5 text-[0.5625rem] text-muted">{month(extent.from)}</span>
        <span className="pointer-events-none absolute bottom-0 right-1.5 text-[0.5625rem] text-muted">{month(extent.to)}</span>
        <div className="pointer-events-none absolute inset-y-0 rounded-md border-2 border-accent bg-accent/15" style={{ left: Math.min(x(view.from), w - 8), width: Math.max(8, x(view.to) - x(view.from)) }} />
      </div>
    </div>
  );
}
