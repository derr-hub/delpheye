import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useFmt } from "../../lib/format";
import type { Ring } from "../../lib/disk";

/**
 * "Time layers": a sunburst of the folder on screen, three levels deep, where each piece is
 * coloured by how old its data is (size-weighted). Fresh data is bright; data nobody has
 * touched for years fades out — the faded rings are the place to look for space.
 *
 * Age is ordinal, so it uses one hue stepped from light to dark (a sequential scale), never
 * a rainbow. On the dark surface the freshest step is the lightest.
 */
// Four OKLCH lightness steps (0.95 → 0.45) at hue 232; neighbours differ by ΔE ≥ 15.9 for
// normal and colour-blind vision alike. The darkest step sits below 3:1 against the surface,
// so it always comes with words: the legend, the tooltip and the list beneath.
export const AGE_STEPS = [
  { key: "month", days: 30, color: "#cef5ff" },
  { key: "halfYear", days: 182, color: "#4fc5fc" },
  { key: "twoYears", days: 730, color: "#148fbe" },
  { key: "older", days: Infinity, color: "#055d7e" },
] as const;
const UNKNOWN = "#3a424d";
const REST = "var(--color-raised)";

export function ageStep(mark: number): (typeof AGE_STEPS)[number] | null {
  if (!mark) return null;
  const days = (Date.now() / 1000 - mark) / 86_400;
  return AGE_STEPS.find((step) => days < step.days) ?? AGE_STEPS[AGE_STEPS.length - 1];
}

export const ageColor = (mark: number) => ageStep(mark)?.color ?? UNKNOWN;

const SIZE = 400;
const C = SIZE / 2;
const CORE = 68;
/** Inner and outer radius of each ring, from the centre outwards. */
const BANDS: [number, number][] = [
  [CORE + 4, 122],
  [124, 162],
  [164, 194],
];
const MIN_ANGLE = 0.004;

interface Arc {
  ring: Ring | null;
  depth: number;
  a0: number;
  a1: number;
  /** For the "everything else" pieces. */
  restCount?: number;
  restSize?: number;
}

function layout(root: Ring): Arc[] {
  const arcs: Arc[] = [];
  const place = (node: Ring, depth: number, a0: number, a1: number) => {
    if (depth >= BANDS.length || node.size <= 0) return;
    const scale = (a1 - a0) / node.size;
    let at = a0;
    for (const child of node.children) {
      const span = child.size * scale;
      if (span >= MIN_ANGLE) {
        arcs.push({ ring: child, depth, a0: at, a1: at + span });
        place(child, depth + 1, at, at + span);
      }
      at += span;
    }
    if (node.restSize > 0 && node.restSize * scale >= MIN_ANGLE) {
      arcs.push({ ring: null, depth, a0: at, a1: at + node.restSize * scale, restCount: node.restCount, restSize: node.restSize });
    }
  };
  place(root, 0, 0, Math.PI * 2);
  return arcs;
}

function point(r: number, a: number) {
  return `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
}

function arcPath(r0: number, r1: number, a0: number, a1: number): string {
  // A full turn cannot be one SVG arc; draw it as two halves.
  if (a1 - a0 >= Math.PI * 2 - 1e-4) {
    const mid = a0 + Math.PI;
    return `${arcPath(r0, r1, a0, mid)} ${arcPath(r0, r1, mid, a1 - 1e-4)}`;
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  return `M${point(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${point(r1, a1)} L${point(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${point(r0, a0)} Z`;
}

/** Bytes of the folder in each age step, counting each drawn piece's whole size at its age. */
function layers(arcs: Arc[], root: Ring): number[] {
  const totals = AGE_STEPS.map(() => 0);
  const outermost = (arc: Arc) => !arc.ring || arc.ring.children.length === 0 || arc.depth === BANDS.length - 1;
  for (const arc of arcs.filter(outermost)) {
    const mark = arc.ring?.mark ?? root.mark;
    const step = ageStep(mark);
    const index = step ? AGE_STEPS.indexOf(step) : AGE_STEPS.length - 1;
    totals[index] += arc.ring ? arc.ring.size : (arc.restSize ?? 0);
  }
  return totals;
}

export function TimeRings({ root, onOpen, onUp }: { root: Ring; onOpen: (id: number) => void; onUp: (() => void) | null }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const arcs = useMemo(() => layout(root), [root]);
  const byAge = useMemo(() => layers(arcs, root), [arcs, root]);
  const [hover, setHover] = useState<{ arc: Arc; x: number; y: number } | null>(null);
  const total = byAge.reduce((a, b) => a + b, 0) || 1;
  const old = byAge[2] + byAge[3];

  const describe = (arc: Arc) => {
    if (!arc.ring) return { name: t("disk.rest", { value: fmt.int(arc.restCount ?? 0) }), size: arc.restSize ?? 0, age: null };
    const step = ageStep(arc.ring.mark);
    return { name: arc.ring.name, size: arc.ring.size, age: step ? t(`disk.age.${step.key}`) : t("disk.age.unknown") };
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_260px] items-center gap-6" data-testid="time-rings">
      <div className="relative mx-auto w-full max-w-[26.25rem]" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="block w-full" role="img" aria-label={t("disk.ringsLabel", { name: root.name })}>
          <AnimatePresence mode="popLayout">
            <motion.g key={root.id} initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 1.04 }} transition={{ duration: 0.28, ease: "easeOut" }} style={{ transformOrigin: "50% 50%" }}>
              {arcs.map((arc, i) => {
                const [r0, r1] = BANDS[arc.depth];
                const clickable = !!arc.ring?.isDir;
                const active = hover?.arc === arc;
                return (
                  <path
                    key={arc.ring ? arc.ring.id : `rest-${arc.depth}-${i}`}
                    d={arcPath(r0, r1, arc.a0, arc.a1)}
                    fill={arc.ring ? ageColor(arc.ring.mark) : REST}
                    // A thin surface-coloured edge keeps neighbouring pieces apart.
                    stroke="var(--color-surface)"
                    strokeWidth={1.5}
                    opacity={hover && !active ? 0.55 : 1}
                    className={clickable ? "cursor-pointer" : ""}
                    style={{ transition: "opacity 150ms" }}
                    onMouseMove={(e) => {
                      const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                      setHover({ arc, x: e.clientX - box.left, y: e.clientY - box.top });
                    }}
                    onClick={() => clickable && arc.ring && onOpen(arc.ring.id)}
                    data-testid={clickable ? "ring-arc" : undefined}
                  />
                );
              })}
            </motion.g>
          </AnimatePresence>
          <g className={onUp ? "cursor-pointer" : ""} onClick={() => onUp?.()} data-testid="ring-center">
            <circle cx={C} cy={C} r={CORE} fill="var(--color-raised)" stroke={ageColor(root.mark)} strokeWidth={3} />
            <text x={C} y={C - 10} textAnchor="middle" className="fill-[var(--color-fg)] font-display text-[0.9375rem] font-semibold">
              {root.name.length > 16 ? `${root.name.slice(0, 15)}…` : root.name}
            </text>
            <text x={C} y={C + 12} textAnchor="middle" className="num fill-[var(--color-muted)] text-[0.8125rem]">
              {fmt.bytes(root.size)}
            </text>
            {onUp && (
              <text x={C} y={C + 32} textAnchor="middle" className="fill-[var(--color-accent)] text-[0.6875rem]">
                ↑ {t("disk.up")}
              </text>
            )}
          </g>
        </svg>
        {hover && (
          <div
            className="pointer-events-none absolute z-10 min-w-[10.625rem] rounded-lg border border-line bg-raised px-3 py-2 text-[0.75rem] shadow-xl"
            style={{ left: Math.min(hover.x + 14, 260), top: hover.y + 14 }}
          >
            {(() => {
              const info = describe(hover.arc);
              return (
                <>
                  <div className="max-w-[13.75rem] truncate font-medium">{info.name}</div>
                  <div className="num mt-0.5 text-muted">
                    {fmt.bytes(info.size)} · {fmt.int((info.size / Math.max(root.size, 1)) * 100)}%
                  </div>
                  {info.age && <div className="mt-0.5 text-muted">{info.age}</div>}
                </>
              );
            })()}
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div>
          <div className="text-[0.8125rem] font-medium">{t("disk.layersTitle")}</div>
          <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">{t("disk.layersHint")}</p>
        </div>
        <ul className="space-y-1.5 text-[0.75rem]" data-testid="age-legend">
          {AGE_STEPS.map((step, i) => (
            <li key={step.key} className="flex items-center gap-2.5">
              <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: step.color }} />
              <span className="flex-1">{t(`disk.age.${step.key}`)}</span>
              <span className="num text-muted">{fmt.bytes(byAge[i])}</span>
            </li>
          ))}
          <li className="flex items-center gap-2.5 text-muted">
            <span className="h-3 w-3 shrink-0 rounded-[3px] border border-line" style={{ background: REST }} />
            <span className="flex-1">{t("disk.age.small")}</span>
          </li>
        </ul>
        {/* The same five layers as one bar, so their proportions read at a glance. */}
        <div className="flex h-2.5 w-full gap-[2px] overflow-hidden rounded-full" aria-hidden>
          {AGE_STEPS.map((step, i) =>
            byAge[i] > 0 ? <span key={step.key} style={{ width: `${(byAge[i] / total) * 100}%`, background: step.color }} /> : null,
          )}
        </div>
        <p className="text-[0.75rem] leading-relaxed" data-testid="old-share">
          {t("disk.oldShare", { size: fmt.bytes(old), share: fmt.int((old / total) * 100) })}
        </p>
      </div>
    </div>
  );
}
