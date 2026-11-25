import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANES, TRACKS, laneOf, titleOf, type LaneId, type Reading, type TimelineEvent, type TrackId } from "../../lib/timeline";

export interface View {
  from: number;
  to: number;
}

const TRACK_H = 46;
const LANE_H = 30;
const AXIS_H = 22;
const GAP = 6;
const NARROWEST = 20 * 60;

/** Round steps for the axis, in seconds. */
const STEPS = [300, 900, 1800, 3600, 2 * 3600, 6 * 3600, 12 * 3600, 86_400, 2 * 86_400, 7 * 86_400, 14 * 86_400, 30 * 86_400, 91 * 86_400];

function ticks(v: View, width: number): { t: number; step: number }[] {
  const want = Math.max(2, width / 110);
  const step = STEPS.find((s) => (v.to - v.from) / s <= want) ?? STEPS[STEPS.length - 1];
  // Local midnight, so days and six-hour marks fall where people expect them.
  const d = new Date(v.from * 1000);
  const zero = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000;
  const out = [];
  for (let t = zero + Math.floor((v.from - zero) / step) * step; t <= v.to; t += step) if (t >= v.from) out.push({ t, step });
  return out;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(800);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(220, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** The tracks and lanes: drag to move, wheel to zoom, click to look at a moment or an event. */
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
}) {
  const { t, i18n } = useTranslation();
  const [ref, w] = useWidth<HTMLDivElement>();
  const svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number; items: TimelineEvent[] } | null>(null);
  const drag = useRef<{ x: number; view: View; moved: boolean } | null>(null);
  const locale = i18n.language.startsWith("uk") ? "uk-UA" : "en-US";

  const span = view.to - view.from;
  const x = (s: number) => ((s - view.from) / span) * w;
  const time = (px: number) => view.from + (px / w) * span;

  const rows = useMemo(() => {
    let y = AXIS_H;
    const tr = TRACKS.map((k) => {
      const on = tracks.has(k.id);
      const row = { k, on, y, h: on ? TRACK_H : 20 };
      y += row.h + GAP;
      return row;
    });
    const ln = LANES.map((l) => {
      const on = lanes.has(l.id);
      const row = { l, on, y, h: on ? LANE_H : 20 };
      y += row.h + GAP;
      return row;
    });
    return { tr, ln, h: y };
  }, [tracks, lanes]);

  const clampView = (v: View): View => {
    const width = Math.min(Math.max(v.to - v.from, NARROWEST), extent.to - extent.from);
    const mid = (v.from + v.to) / 2;
    let from = v.to - v.from === width ? v.from : mid - width / 2;
    from = Math.min(Math.max(from, extent.from), extent.to - width);
    return { from, to: from + width };
  };

  // The page must not scroll while the wheel zooms, so the listener is not passive.
  const live = useRef({ view, w, clampView, onView });
  live.current = { view, w, clampView, onView };
  useEffect(() => {
    const el = svg.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const { view: v, w: width, clampView: fit, onView: set } = live.current;
      const s = v.to - v.from;
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = ((e.deltaX || e.deltaY) / width) * s;
        return set(fit({ from: v.from + d, to: v.to + d }));
      }
      const k = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.0045);
      const p = (e.clientX - el.getBoundingClientRect().left) / width;
      const here = v.from + p * s;
      set(fit({ from: here - p * s * k, to: here + (1 - p) * s * k }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  /** A line that breaks where nothing was recorded. */
  const shapes = useMemo(
    () =>
      TRACKS.map((k) => {
        const runs: [number, number][][] = [];
        let run: [number, number][] = [];
        let last = -Infinity;
        for (const r of readings) {
          const v = k.get(r);
          if (v === null || r.t - last > Math.max(step, r.n * 60) * 2.5 + 60) {
            if (run.length) runs.push(run);
            run = [];
          }
          if (v !== null) {
            run.push([r.t + Math.max(step, 60) / 2, Math.min(1, v / k.max)]);
            last = r.t;
          }
        }
        if (run.length) runs.push(run);
        return { id: k.id, runs };
      }),
    [readings, step],
  );

  /** Events closer than a marker's width stand together. */
  const marks = useMemo(() => {
    const out: { lane: LaneId; x: number; items: TimelineEvent[] }[] = [];
    for (const l of LANES) {
      if (!lanes.has(l.id)) continue;
      let group: { lane: LaneId; x: number; items: TimelineEvent[] } | null = null;
      for (const e of events) {
        if (laneOf(e).id !== l.id || e.t < view.from || e.t > view.to) continue;
        const px = ((e.t - view.from) / span) * w;
        if (group && px - group.x < 18) group.items.push(e);
        else out.push((group = { lane: l.id, x: px, items: [e] }));
      }
    }
    return out;
  }, [events, lanes, view.from, view.to, w, span]);

  const label = (s: number, st: number) => {
    const d = new Date(s * 1000);
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    if (st < 86_400 && !midnight) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString(locale, st >= 30 * 86_400 ? { month: "short", year: "numeric" } : { day: "numeric", month: "short" });
  };
  const stamp = new Date(cursor * 1000).toLocaleString(locale, span > 60 * 86_400 ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const cx = x(cursor);
  const px = (e: { clientX: number }) => e.clientX - svg.current!.getBoundingClientRect().left;

  return (
    <div className="flex" data-testid="timeline-board">
      {/* The names switch their rows on and off. */}
      <div className="relative w-[8.5rem] shrink-0" style={{ height: rows.h }}>
        {rows.tr.map(({ k, on, y, h }) => {
          const v = at ? k.get(at) : null;
          return (
            <button key={k.id} onClick={() => onTrack(k.id)} aria-pressed={on} title={t("timeline.toggle")} className={`absolute left-0 right-2 flex flex-col justify-center rounded-md px-2 text-left hover:bg-raised ${on ? "" : "opacity-45"}`} style={{ top: y, height: h }} data-testid={`track-${k.id}`}>
              <span className="flex items-center gap-2 text-[0.6875rem] text-muted">
                <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ background: k.color }} />
                {t(`timeline.track.${k.id}`)}
              </span>
              {on && <span className="num text-[0.875rem] font-medium leading-tight">{v === null ? "—" : `${Math.round(v)}${k.unit}`}</span>}
            </button>
          );
        })}
        {rows.ln.map(({ l, on, y, h }) => (
          <button key={l.id} onClick={() => onLane(l.id)} aria-pressed={on} title={t(`timeline.lane.${l.id}.hint`)} className={`absolute left-0 right-2 flex items-center gap-2 rounded-md px-2 text-left text-[0.6875rem] text-muted hover:bg-raised ${on ? "" : "opacity-45"}`} style={{ top: y, height: h }} data-testid={`lane-${l.id}`}>
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: l.color }} />
            <span className="truncate">{t(`timeline.lane.${l.id}.name`)}</span>
          </button>
        ))}
      </div>

      <div ref={ref} className="relative min-w-0 flex-1">
        <svg
          ref={svg}
          width={w}
          height={rows.h}
          className="block cursor-grab touch-none select-none active:cursor-grabbing"
          tabIndex={0}
          role="application"
          aria-label={t("timeline.boardLabel")}
          data-testid="timeline-svg"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            svg.current!.setPointerCapture(e.pointerId);
            drag.current = { x: e.clientX, view, moved: false };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            if (!d) return;
            if (Math.abs(e.clientX - d.x) > 4) d.moved = true;
            if (d.moved) {
              const by = ((d.x - e.clientX) / w) * (d.view.to - d.view.from);
              setHover(null);
              onView(clampView({ from: d.view.from + by, to: d.view.to + by }));
            }
          }}
          onPointerUp={(e) => {
            const d = drag.current;
            drag.current = null;
            if (d && !d.moved) {
              const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-mark]");
              const m = hit ? marks[Number(hit.getAttribute("data-mark"))] : null;
              if (m) {
                // A crowd opens up; a single event is looked at.
                const first = m.items[0].t;
                const last = m.items[m.items.length - 1].t;
                if (m.items.length > 1 && last - first > NARROWEST / 2) onView(clampView({ from: first - (last - first) * 0.4 - 600, to: last + (last - first) * 0.4 + 600 }));
                const next = m.items[(m.items.findIndex((i) => i.id === picked?.id) + 1) % m.items.length];
                onPick(next);
                onCursor(next.t);
              } else {
                onPick(null);
                onCursor(Math.min(extent.to, time(px(e))));
              }
            }
          }}
          onPointerCancel={() => (drag.current = null)}
          onDoubleClick={(e) => {
            const here = time(px(e));
            onView(clampView({ from: here - span / 6, to: here + span / 6 }));
          }}
          onKeyDown={(e) => {
            const by = e.shiftKey ? span / 10 : span / 60;
            if (e.key === "ArrowLeft") onCursor(Math.max(extent.from, cursor - by));
            else if (e.key === "ArrowRight") onCursor(Math.min(extent.to, cursor + by));
            else if (e.key === "+" || e.key === "=") onView(clampView({ from: cursor - span / 4, to: cursor + span / 4 }));
            else if (e.key === "-") onView(clampView({ from: cursor - span, to: cursor + span }));
            else return;
            e.preventDefault();
          }}
        >
          {ticks(view, w).map(({ t: s, step: st }) => (
            <g key={s}>
              <line x1={x(s)} x2={x(s)} y1={AXIS_H - 4} y2={rows.h} stroke="var(--color-line)" strokeOpacity={0.6} />
              <text x={x(s) + 4} y={12} className="fill-muted text-[0.625rem]">
                {label(s, st)}
              </text>
            </g>
          ))}

          {rows.tr.map(({ k, on, y, h }) => {
            if (!on) return <line key={k.id} x1={0} x2={w} y1={y + h / 2} y2={y + h / 2} stroke="var(--color-line)" strokeDasharray="2 5" />;
            const runs = shapes.find((s) => s.id === k.id)!.runs;
            const py = (v: number) => y + h - 2 - v * (h - 6);
            return (
              <g key={k.id}>
                <rect x={0} y={y} width={w} height={h} rx={6} fill="var(--color-raised)" fillOpacity={0.35} />
                {runs.map((run, i) => {
                  const pts = run.map(([s, v]) => `${x(s).toFixed(1)},${py(v).toFixed(1)}`);
                  if (pts.length === 1) return <circle key={i} cx={x(run[0][0])} cy={py(run[0][1])} r={2} fill={k.color} />;
                  return (
                    <g key={i}>
                      <path d={`M${pts.join("L")}L${x(run[run.length - 1][0]).toFixed(1)},${y + h}L${x(run[0][0]).toFixed(1)},${y + h}Z`} fill={k.color} fillOpacity={0.16} />
                      <path d={`M${pts.join("L")}`} fill="none" stroke={k.color} strokeWidth={1.5} strokeLinejoin="round" />
                    </g>
                  );
                })}
                {k.id === "temp" && readings.filter((r) => r.hot > 0).map((r) => <rect key={r.t} x={x(r.t)} y={y} width={Math.max(2, (Math.max(step, 60) / span) * w)} height={h} fill="#e5484d" fillOpacity={0.28} />)}
              </g>
            );
          })}
          {!readings.length && (
            <text x={w / 2} y={rows.tr[0].y + 26} textAnchor="middle" className="fill-muted text-[0.6875rem]">
              {t("timeline.noReadings")}
            </text>
          )}

          {rows.ln.map(({ l, y, h }) => (
            <line key={l.id} x1={0} x2={w} y1={y + h / 2} y2={y + h / 2} stroke="var(--color-line)" strokeDasharray={lanes.has(l.id) ? undefined : "2 5"} />
          ))}
          {cx >= 0 && cx <= w && <line x1={cx} x2={cx} y1={AXIS_H - 6} y2={rows.h} stroke="var(--color-accent)" strokeWidth={1.5} pointerEvents="none" />}
          {marks.map((m, i) => {
            const row = rows.ln.find((r) => r.l.id === m.lane)!;
            const on = picked && m.items.some((e) => e.id === picked.id);
            const r = m.items.length > 1 ? 10 : 6;
            return (
              <g
                key={`${m.lane}${m.items[0].id}`}
                data-mark={i}
                className="cursor-pointer"
                transform={`translate(${m.x},${row.y + row.h / 2})`}
                onPointerEnter={() => !drag.current && setHover({ x: m.x, y: row.y, items: m.items })}
                onPointerLeave={() => setHover(null)}
              >
                <circle r={13} fill="transparent" />
                {on && <circle r={r + 4} fill="none" stroke="var(--color-accent)" strokeWidth={2} />}
                <circle r={r} fill={row.l.color} stroke="var(--color-surface)" strokeWidth={2} />
                {m.items.length > 1 && (
                  <text textAnchor="middle" y={3.5} className="num text-[0.625rem] font-semibold" fill="#fff" pointerEvents="none">
                    {m.items.length > 99 ? "99+" : m.items.length}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {cx >= 0 && cx <= w && (
          <div className="num pointer-events-none absolute top-0 -translate-x-1/2 whitespace-nowrap rounded-md bg-accent px-1.5 py-px text-[0.625rem] font-semibold text-bg" style={{ left: Math.min(Math.max(cx, 46), w - 46) }}>
            {stamp}
          </div>
        )}
        {hover && (
          <div className="pointer-events-none absolute z-20 max-w-[18rem] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[0.6875rem] shadow-lg" style={{ left: Math.min(Math.max(0, hover.x - 60), w - 200), bottom: rows.h - hover.y + 4 }}>
            {hover.items.slice(0, 4).map((e) => (
              <div key={e.id} className="truncate">
                {titleOf(e, t)} <span className="text-muted">{t(`timeline.action.${e.action}`)}</span>
              </div>
            ))}
            {hover.items.length > 4 && <div className="text-muted">{t("timeline.more", { count: hover.items.length - 4 })}</div>}
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
    <div className="pl-[8.5rem]">
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
          {bins.map((b, i) => (b.n ? <rect key={i} x={(i / bins.length) * w} y={36 - 4 - (Math.sqrt(b.n) / Math.sqrt(top)) * 26} width={Math.max(2, w / bins.length - 1.5)} height={4 + (Math.sqrt(b.n) / Math.sqrt(top)) * 26} rx={1} fill={b.bad ? "#e5484d" : "var(--color-muted)"} fillOpacity={b.bad ? 0.9 : 0.5} /> : null))}
        </svg>
        <span className="pointer-events-none absolute bottom-0.5 left-1.5 text-[0.5625rem] text-muted">{month(extent.from)}</span>
        <span className="pointer-events-none absolute bottom-0.5 right-1.5 text-[0.5625rem] text-muted">{month(extent.to)}</span>
        <div className="pointer-events-none absolute inset-y-0 rounded-md border-2 border-accent bg-accent/15" style={{ left: Math.min(x(view.from), w - 8), width: Math.max(8, x(view.to) - x(view.from)) }} />
      </div>
    </div>
  );
}
