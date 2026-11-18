import { useMemo, useState } from "react";

/** Categorical colours for the dark surface, in fixed order (validated set). */
export const SERIES_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500"];

export interface Series {
  id: string;
  name: string;
  color: string;
  /** Oldest first, one per second. */
  values: number[];
}

/**
 * A small time chart: thin lines, a quiet grid, a legend above, and a crosshair with a
 * tooltip that lists every series at the hovered moment.
 */
export function LineChart({
  series,
  format,
  height = 150,
  points = 300,
  minRange = 10,
  floor,
  label,
  markers = false,
}: {
  series: Series[];
  format: (v: number) => string;
  height?: number;
  points?: number;
  /** The y axis spans at least this much, so flat lines are not blown up into noise. */
  minRange?: number;
  /** The lowest the y axis may start, e.g. 0 for speeds. */
  floor?: number;
  label: string;
  /** Draw a dot on every value; for sparse series such as one point per test run. */
  markers?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 600;
  const pad = { top: 8, right: 8, bottom: 18, left: 44 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const { lo, hi } = useMemo(() => {
    const all = series.flatMap((s) => s.values);
    if (!all.length) return { lo: 0, hi: minRange };
    let lo = Math.min(...all);
    let hi = Math.max(...all);
    if (hi - lo < minRange) {
      const mid = (hi + lo) / 2;
      lo = mid - minRange / 2;
      hi = mid + minRange / 2;
    }
    if (floor !== undefined) lo = Math.max(floor, lo);
    const step = (hi - lo) / 10;
    // The margin keeps lines off the edges, but never pushes the axis below its floor
    // (no "−2 KB/s" on a traffic chart).
    return { lo: floor !== undefined ? Math.max(floor, lo - step) : lo - step, hi: hi + step };
  }, [series, minRange, floor]);

  const x = (i: number, n: number) => pad.left + ((points - n + i) / (points - 1)) * innerW;
  const y = (v: number) => pad.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const grid = [0, 0.5, 1].map((f) => lo + (hi - lo) * f);
  const longest = Math.max(0, ...series.map((s) => s.values.length));

  return (
    <div>
      {series.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
          {series.map((s) => (
            <li key={s.id} className="flex items-center gap-1.5">
              <span className="h-[3px] w-3 rounded-full" style={{ background: s.color }} />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="block w-full"
          role="img"
          aria-label={label}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            const px = ((e.clientX - box.left) / box.width) * width;
            const index = Math.round(((px - pad.left) / innerW) * (points - 1)) - (points - longest);
            setHover(index >= 0 && index < longest ? index : null);
          }}
        >
          {grid.map((v) => (
            <g key={v}>
              <line x1={pad.left} x2={width - pad.right} y1={y(v)} y2={y(v)} stroke="var(--color-line)" strokeWidth={1} />
              <text x={pad.left - 6} y={y(v) + 4} textAnchor="end" className="num fill-[var(--color-muted)] text-[10px]">
                {format(v)}
              </text>
            </g>
          ))}
          {series.map((s) => (
            <polyline
              key={s.id}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              points={s.values.map((v, i) => `${x(i, s.values.length).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
            />
          ))}
          {markers &&
            series.map((s) =>
              s.values.map((v, i) => <circle key={`${s.id}-${i}`} cx={x(i, s.values.length)} cy={y(v)} r={4} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} />),
            )}
          {hover !== null && (
            <g>
              <line x1={x(hover, longest)} x2={x(hover, longest)} y1={pad.top} y2={pad.top + innerH} stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="3 3" />
              {series.map((s) => {
                const i = hover - (longest - s.values.length);
                return i >= 0 ? <circle key={s.id} cx={x(i, s.values.length)} cy={y(s.values[i])} r={4} fill={s.color} stroke="var(--color-surface)" strokeWidth={2} /> : null;
              })}
            </g>
          )}
        </svg>
        {hover !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 rounded-lg border border-line bg-raised px-3 py-2 text-[12px] shadow-xl"
            style={{ left: `${Math.min((x(hover, longest) / width) * 100, 70)}%` }}
          >
            {series.map((s) => {
              const i = hover - (longest - s.values.length);
              return i >= 0 ? (
                <div key={s.id} className="flex items-center gap-2">
                  <span className="h-[3px] w-3 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted">{s.name}</span>
                  <span className="num ml-auto pl-3">{format(s.values[i])}</span>
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>
    </div>
  );
}
