import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Layers, Maximize2, Play, Thermometer } from "lucide-react";
import { useFmt } from "../../lib/format";
import { bundles, causes, iconOf, isProblem, laneOf, loadReadings, titleOf, valueOf, type Bundle, type Cause, type Level, type Reading, type TimelineEvent } from "../../lib/timeline";
import { useWidth } from "./Board";
import { EventCard, EventRow } from "./Cards";

interface Node {
  id: string;
  kind: "problem" | "bundle" | "cause" | "state" | "after";
  title: string;
  sub: string;
  color: string;
  e?: TimelineEvent;
  bundle?: Bundle;
  cause?: Cause;
  level?: Level;
  parent?: string;
  children: Node[];
  x: number;
  y: number;
  depth: number;
  order: number;
}

const COL = 122;
const TOP = 58;
const HEIGHT = 600;
const R = [30, 24, 19];
const EDGE: Record<Level | "state" | "after", { color: string; dash?: string; width: number }> = {
  likely: { color: "#ef5a60", width: 3 },
  possible: { color: "#f0a04b", width: 2.2, dash: "8 5" },
  timing: { color: "#7f8ea3", width: 1.5, dash: "2 6" },
  state: { color: "#3b9ee5", width: 2, dash: "8 5" },
  after: { color: "#b04c93", width: 1.8, dash: "8 5" },
};

/** Leaves side by side, every parent centred above its own: branches never cross. */
function place(root: Node, width: number): { w: number; fit: number; h: number } {
  let next = 0;
  let deep = 0;
  const walk = (n: Node, depth: number) => {
    n.depth = depth;
    deep = Math.max(deep, depth);
    if (!n.children.length) {
      n.x = next * COL + COL / 2;
      next += 1;
      return;
    }
    for (const c of n.children) walk(c, depth + 1);
    n.x = (n.children[0].x + n.children[n.children.length - 1].x) / 2;
  };
  walk(root, 0);
  // The rows spread to fill the height, whatever the scale turned out to be.
  const w = Math.max(next, 3) * COL;
  const fit = Math.max(0.62, Math.min(1.2, (width - 24) / w));
  const gap = deep ? Math.min(270, Math.max(150, (HEIGHT / fit - TOP - 150) / deep)) : 0;
  const down = (n: Node) => {
    n.y = TOP + n.depth * gap;
    n.children.forEach(down);
  };
  down(root);
  return { w, fit, h: TOP + deep * gap + 100 };
}

/** Why a problem happened, as a map: the problem, what may have led to it, what came after. */
export function Connections({ all, start }: { all: TimelineEvent[]; start: TimelineEvent | null }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const still = useReducedMotion();
  const problems = useMemo(() => all.filter(isProblem).reverse(), [all]);
  const [root, setRoot] = useState<TimelineEvent | null>(start && isProblem(start) ? start : (problems.find((p) => p.kind === "crash") ?? problems[0] ?? null));
  const [days, setDays] = useState(3);
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [lit, setLit] = useState<number | null>(null);
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [before, setBefore] = useState<Reading[] | null>(null);
  const [box, width] = useWidth<HTMLDivElement>(700);
  const [pan, setPan] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    if (start && isProblem(start)) setRoot(start);
  }, [start]);
  useEffect(() => {
    if (!root) return;
    let alive = true;
    setBefore(null);
    setPicked(null);
    setLit(null);
    setOpened(new Set());
    loadReadings(root.t - 1800, root.t + 60, 60)
      .then((r) => alive && setBefore(r))
      .catch(() => alive && setBefore([]));
    return () => {
      alive = false;
    };
  }, [root]);

  const tree = useMemo(() => {
    if (!root) return null;
    const found = bundles(causes(root, all, days)).slice(0, 5);
    const node = (n: Partial<Node> & Pick<Node, "id" | "kind" | "title" | "sub" | "color">): Node => ({ children: [], x: 0, y: 0, depth: 0, order: 0, ...n });
    const top = node({ id: root.id, kind: "problem", title: titleOf(root, t), sub: valueOf(root, t) || fmt.dateTime(root.t), color: laneOf(root).color, e: root });
    // Oldest on the left: the map reads in the order things happened.
    const strongest = new Set(found.filter((b) => b.items.length > 1).slice(0, 2).map((b) => b.id));
    for (const b of [...found].sort((a, z) => a.t - z.t)) {
      const first = b.items[0].e;
      const hours = Math.max(1, Math.round((root.t - first.t) / 3600));
      const one = b.items.length === 1;
      const n = node({
        id: `b${b.id}`,
        kind: one ? "cause" : "bundle",
        title: one ? titleOf(first, t) : t("timeline.conn.bundle", { name: titleOf(b.items.find((i) => i.e.kind === "program" || i.e.kind === "service")?.e ?? first, t), count: b.items.length - 1 }),
        sub: hours < 48 ? t("timeline.before.ago", { hours }) : t("timeline.conn.daysBefore", { days: Math.round(hours / 24) }),
        color: laneOf(first).color,
        e: first,
        bundle: b,
        cause: b.items[0],
        level: b.level,
        parent: root.id,
      });
      // The two strongest open by themselves; a click opens or folds any.
      if (!one && strongest.has(b.id) !== opened.has(b.id))
        for (const c of b.items.slice(0, 3).sort((a, z) => a.e.t - z.e.t)) n.children.push(node({ id: `c${c.e.id}`, kind: "cause", title: titleOf(c.e, t), sub: c.e.kind === "service" ? t("timeline.conn.service") : valueOf(c.e, t).slice(0, 34), color: laneOf(c.e).color, e: c.e, cause: c, level: c.level, parent: n.id }));
      top.children.push(n);
    }
    if (before && before.length) {
      const hot = Math.max(...before.map((r) => r.cpuTempMax ?? r.cpuTemp ?? 0));
      const ram = Math.max(...before.map((r) => r.ram ?? 0));
      const bad = hot >= 92 || ram >= 92 || before.some((r) => r.hot > 0);
      top.children.push(node({ id: "state", kind: "state", title: t(bad ? "timeline.conn.stateBad" : "timeline.conn.stateOk"), sub: `${hot ? `${Math.round(hot)} °C` : "—"} · ${t("timeline.track.ram")} ${Math.round(ram)}%`, color: bad ? "#d8434a" : "#2d7fd3", level: bad ? "likely" : undefined, parent: root.id }));
    }
    for (const a of all.filter((x) => isProblem(x) && x.t > root.t && x.t - root.t < 3 * 86_400 && (x.kind === "crash" || x.name === root.name)).slice(0, 2)) top.children.push(node({ id: `a${a.id}`, kind: "after", title: titleOf(a, t), sub: t("timeline.conn.later", { hours: Math.max(1, Math.round((a.t - root.t) / 3600)) }), color: laneOf(a).color, e: a, parent: root.id }));
    const { w, fit, h } = place(top, width);
    const flat: Node[] = [];
    const walk = (n: Node) => {
      flat.push(n);
      n.children.forEach(walk);
    };
    walk(top);
    // The order in which the search lights up: strongest causes first, then what they consist of.
    let i = 1;
    for (const b of found) {
      const n = flat.find((x) => x.id === `b${b.id}`);
      if (!n) continue;
      n.order = i++;
      n.children.forEach((c) => (c.order = i++));
    }
    flat.forEach((n) => {
      if (n.kind === "state" || n.kind === "after") n.order = i++;
    });
    return { top, flat, w, fit, h, best: found[0] ?? null, steps: i };
  }, [root, all, days, before, t, fmt, width, opened]);

  const height = HEIGHT;
  const fitted = tree?.fit ?? 1;
  useEffect(() => setPan({ x: 0, y: 0, k: 1 }), [root?.id, days]);

  // The search: each step lights the next node.
  useEffect(() => {
    if (lit === null || !tree) return;
    if (lit >= tree.steps) return;
    const id = window.setTimeout(() => setLit(lit + 1), still ? 0 : 420);
    return () => window.clearTimeout(id);
  }, [lit, tree, still]);

  const area = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      setPan((p) => ({ ...p, k: Math.min(2.5, Math.max(0.5, p.k * Math.exp(-e.deltaY * 0.0012))) }));
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [tree === null]);

  if (!problems.length || !root || !tree)
    return <div className="rounded-card border border-line bg-surface px-6 py-16 text-center text-[0.8125rem] text-muted">{t("timeline.conn.none")}</div>;

  const chosen = tree.flat.find((n) => n.id === picked) ?? null;
  const focus = hover ?? picked;
  const family = new Set<string>();
  if (focus) {
    const n = tree.flat.find((x) => x.id === focus);
    if (n) {
      family.add(tree.top.id);
      family.add(n.id);
      if (n.parent) family.add(n.parent);
      n.children.forEach((c) => family.add(c.id));
    }
  }
  const dim = (n: Node) => (lit !== null && n.order > lit ? 0.12 : focus && focus !== tree.top.id && !family.has(n.id) ? 0.28 : 1);
  const scale = fitted * pan.k;
  const ox = width / 2 - (tree.w / 2) * scale + pan.x;
  const oy = Math.max(8, (height - tree.h * fitted) / 2) + pan.y;

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="timeline-connections">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.75rem] text-muted">{t("timeline.conn.problem")}</span>
        <select value={root.id} onChange={(e) => setRoot(problems.find((p) => p.id === e.target.value) ?? root)} className="max-w-[24rem] rounded-lg border border-line bg-surface px-2.5 py-1.5 text-[0.75rem]" data-testid="conn-problem" aria-label={t("timeline.conn.problem")}>
          {problems.slice(0, 80).map((p) => (
            <option key={p.id} value={p.id}>{`${fmt.dateTime(p.t)} · ${titleOf(p, t)}`}</option>
          ))}
        </select>
        <div className="flex rounded-lg border border-line p-0.5 text-[0.75rem]">
          {[1, 3, 7].map((d) => (
            <button key={d} onClick={() => setDays(d)} aria-pressed={days === d} className={`rounded-md px-2.5 py-1 ${days === d ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}>
              {t(`timeline.conn.window.${d}`)}
            </button>
          ))}
        </div>
        <button
          onClick={() => {
            setPicked(null);
            setLit(0);
          }} className="flex h-8 items-center gap-2 rounded-lg bg-accent px-3 text-[0.75rem] font-semibold text-bg" data-testid="conn-search">
          <Play size={13} />
          {t("timeline.conn.search")}
        </button>
        <button onClick={() => setPan({ x: 0, y: 0, k: 1 })} className="flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-[0.75rem] text-muted hover:bg-raised" title={t("timeline.conn.fit")}>
          <Maximize2 size={13} />
        </button>
        <div className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-[0.6875rem] text-muted">
          {(["likely", "possible", "timing"] as const).map((k) => (
            <span key={k} className="flex items-center gap-1.5">
              <svg width={22} height={6}>
                <line x1={0} x2={22} y1={3} y2={3} stroke={EDGE[k].color} strokeWidth={EDGE[k].width} strokeDasharray={EDGE[k].dash} />
              </svg>
              {t(`timeline.level.${k}`)}
            </span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4">
        <div ref={box} className="relative overflow-hidden rounded-card border border-line bg-surface" style={{ height }}>
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_10%,rgb(239_90_96/0.10),transparent_55%)]" />
          <svg
            ref={area}
            width={width}
            height={height}
            className="relative block cursor-grab touch-none select-none active:cursor-grabbing"
            data-testid="conn-svg"
            onPointerDown={(e) => {
              if ((e.target as Element).closest("[data-node]")) return;
              (e.currentTarget as Element).setPointerCapture(e.pointerId);
              drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
            }}
            onPointerMove={(e) => drag.current && setPan({ ...pan, x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y })}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <g transform={`translate(${ox},${oy}) scale(${scale})`}>
              {tree.flat.map((n) => {
                const p = n.parent ? tree.flat.find((x) => x.id === n.parent) : null;
                if (!p) return null;
                const e = EDGE[n.kind === "after" ? "after" : n.kind === "state" && !n.level ? "state" : (n.level ?? "timing")];
                // From under the parent's caption to the top of the child.
                const y1 = p.depth === 0 ? p.y + R[0] + 4 : p.y + R[p.depth] + 62;
                const y2 = n.y - R[n.depth] - 8;
                const d = `M${p.x},${y1}C${p.x},${(y1 + y2) / 2} ${n.x},${(y1 + y2) / 2} ${n.x},${y2}`;
                const on = dim(n) === 1;
                return (
                  <g key={`e${n.id}`} style={{ opacity: dim(n), transition: "opacity .3s" }}>
                    <motion.path key={root.id + n.id} d={d} fill="none" stroke={e.color} strokeWidth={e.width} strokeLinecap="round" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: still ? 0 : 0.6, delay: still ? 0 : n.depth * 0.25 }} strokeOpacity={e.dash ? 0.25 : 0.9} />
                    {e.dash && <path d={d} fill="none" stroke={e.color} strokeWidth={e.width} strokeDasharray={e.dash} className={on ? "tl-flow" : undefined} />}
                    {!e.dash && on && <path d={d} fill="none" stroke="#fff" strokeOpacity={0.65} strokeWidth={1.4} strokeDasharray="3 16" className="tl-flow" />}
                    <path d={`M${n.x - 4.5},${y2 - 2}l4.5,7l4.5,-7Z`} fill={e.color} />
                  </g>
                );
              })}
              {tree.flat.map((n) => {
                const Icon = n.kind === "bundle" ? Layers : n.kind === "state" ? Thermometer : n.e ? iconOf(n.e) : Layers;
                const r = R[n.depth];
                const on = picked === n.id;
                const cap = n.depth === 0;
                return (
                  <motion.g
                    key={root.id + n.id}
                    data-node={n.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.title}. ${n.sub}`}
                    className="cursor-pointer outline-none"
                    initial={{ opacity: 0, scale: 0.6 }}
                    animate={{ opacity: dim(n), scale: 1 }}
                    transition={{ type: "spring", stiffness: 320, damping: 24, delay: still || lit !== null || focus ? 0 : n.depth * 0.25 + 0.1 }}
                    style={{ transformOrigin: `${n.x}px ${n.y}px`, transformBox: "view-box" }}
                    onPointerEnter={() => setHover(n.id)}
                    onPointerLeave={() => setHover(null)}
                    onClick={() => {
                      setPicked(on ? null : n.id);
                      if (n.kind === "bundle" && n.bundle) {
                        const next = new Set(opened);
                        if (!next.delete(n.bundle.id)) next.add(n.bundle.id);
                        setOpened(next);
                      }
                    }}
                    onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setPicked(on ? null : n.id)}
                  >
                    {cap && !still && <circle cx={n.x} cy={n.y} r={r} fill="none" stroke={n.color} strokeWidth={2} className="tl-ring" style={{ transformOrigin: `${n.x}px ${n.y}px` }} />}
                    <circle cx={n.x} cy={n.y} r={r + 5} fill={n.color} fillOpacity={0.16} />
                    <circle cx={n.x} cy={n.y} r={r} fill={n.color} stroke={on ? "var(--color-fg)" : "rgb(255 255 255 / .25)"} strokeWidth={on ? 2.5 : 1.5} />
                    <Icon x={n.x - r * 0.46} y={n.y - r * 0.46} width={r * 0.92} height={r * 0.92} color="#fff" strokeWidth={2} />
                    <foreignObject x={cap ? n.x + r + 14 : n.x - COL / 2 + 4} y={cap ? n.y - 24 : n.y + r + 8} width={cap ? 280 : COL - 8} height={cap ? 60 : 60} style={{ pointerEvents: "none", overflow: "visible" }}>
                      <div className={cap ? "" : "text-center"}>
                        <div className={`${cap ? "text-[15px] font-semibold" : "line-clamp-2 text-[12.5px] font-medium"} leading-[1.2] text-fg`}>{n.title}</div>
                        <div className="truncate text-[11px] text-muted">{n.sub}</div>
                      </div>
                    </foreignObject>
                  </motion.g>
                );
              })}
            </g>
          </svg>
          {!tree.top.children.length && <p className="absolute inset-x-8 bottom-10 text-center text-[0.8125rem] text-muted">{t("timeline.before.none")}</p>}
          <p className="pointer-events-none absolute bottom-2.5 left-4 right-4 text-[0.6875rem] text-muted">{t("timeline.conn.hint")}</p>
        </div>

        <div className="grid gap-4">
          {chosen && chosen.kind === "bundle" && chosen.bundle ? (
            <section className="rounded-card border border-line bg-surface p-5">
              <h3 className="font-display text-[1rem] font-semibold">{chosen.title}</h3>
              <p className="mt-1 text-[0.75rem] text-muted">{t("timeline.conn.bundleText", { count: chosen.bundle.items.length })}</p>
              <Reasons c={chosen.bundle.items[0]} />
              <div className="mt-2">
                {chosen.bundle.items.map((c) => (
                  <EventRow key={c.e.id} e={c.e} note={`${t(`timeline.level.${c.level}`)} · ${fmt.dateTime(c.e.t)}`} onPick={() => setPicked(tree.flat.some((n) => n.id === `c${c.e.id}`) ? `c${c.e.id}` : chosen.id)} />
                ))}
              </div>
            </section>
          ) : chosen?.e ? (
            <>
              {chosen.cause && (
                <section className="rounded-card border border-line bg-surface p-5">
                  <h3 className="text-[0.8125rem] font-medium">{t("timeline.conn.why")}</h3>
                  <Reasons c={chosen.cause} />
                </section>
              )}
              <EventCard
                e={chosen.e}
                all={all}
                onPick={(e) => {
                  if (isProblem(e)) setRoot(e);
                }}
              />
            </>
          ) : chosen?.kind === "state" ? (
            <section className="rounded-card border border-line bg-surface p-5 text-[0.8125rem] leading-relaxed">
              <h3 className="font-display text-[1rem] font-semibold">{chosen.title}</h3>
              <p className="mt-1 text-muted">{t("timeline.conn.stateText")}</p>
              <p className="num mt-2">{chosen.sub}</p>
            </section>
          ) : (
            <section className="rounded-card border border-line bg-surface p-5" data-testid="conn-summary">
              <h3 className="font-display text-[1rem] font-semibold">{t("timeline.conn.summary")}</h3>
              <p className="mt-2 text-[0.8125rem] leading-relaxed">{tree.best ? t(`timeline.conn.best.${tree.best.level}`, { name: titleOf(tree.best.items[0].e, t) }) : t("timeline.before.none")}</p>
              {tree.best && <Reasons c={tree.best.items[0]} />}
              <p className="mt-3 text-[0.75rem] leading-relaxed text-muted">{t("timeline.before.note")}</p>
              <p className="mt-2 text-[0.75rem] text-muted">{t("timeline.conn.click")}</p>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function Reasons({ c }: { c: Cause }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2">
      <span className="rounded-full px-2 py-0.5 text-[0.6875rem] font-medium" style={{ background: `${EDGE[c.level].color}26`, color: EDGE[c.level].color }}>
        {t(`timeline.level.${c.level}`)}
      </span>
      <ul className="mt-2 list-inside list-disc space-y-0.5 text-[0.75rem] text-muted">
        {c.reasons.map((r) => (
          <li key={r}>{t(`timeline.reason.${r}`)}</li>
        ))}
        {!c.reasons.length && <li>{t("timeline.reason.none")}</li>}
      </ul>
    </div>
  );
}
