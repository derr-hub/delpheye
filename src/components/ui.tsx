import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useSpring, useTransform, type HTMLMotionProps } from "motion/react";
import { useFmt } from "../lib/format";
import { go, type Page } from "../lib/app";

export function Card({
  title,
  icon,
  aside,
  children,
  className = "",
  to,
}: {
  title?: string;
  icon?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Clicking the card opens this page; its title flies up to become the page heading. */
  to?: Page;
}) {
  return (
    <motion.section
      variants={{ hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0 } }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      onClick={to ? () => go(to) : undefined}
      className={`reveal rounded-card border border-line bg-surface p-5 transition-colors duration-200 hover:border-line-strong ${to ? "cursor-pointer" : ""} ${className}`}
    >
      {title && (
        <header className="mb-4 flex items-center gap-2 text-muted">
          {icon}
          {to ? (
            <motion.h2 layoutId={`page-title-${to}`} className="text-[13px] font-medium" transition={{ type: "spring", stiffness: 300, damping: 32 }}>
              {title}
            </motion.h2>
          ) : (
            <h2 className="text-[13px] font-medium">{title}</h2>
          )}
          {aside && <div className="ml-auto">{aside}</div>}
        </header>
      )}
      {children}
    </motion.section>
  );
}

/** A number that springs to its new value instead of jumping. */
export function AnimatedNumber({ value, digits = 0 }: { value: number; digits?: number }) {
  const spring = useSpring(value, { stiffness: 90, damping: 20 });
  const text = useTransform(spring, (v) => v.toFixed(digits));
  useEffect(() => {
    spring.set(value);
  }, [value, spring]);
  return <motion.span className="num">{text}</motion.span>;
}

export function Ring({
  value,
  color,
  size = 148,
  stroke = 10,
  children,
}: {
  value: number;
  color: string;
  size?: number;
  stroke?: number;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-raised)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - Math.min(Math.max(value, 0), 100) / 100) }}
          transition={{ type: "spring", stiffness: 60, damping: 18 }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}

/** Area sparkline. `max` fixes the scale; omit it to auto-scale to the data. */
/** A smooth path through the points (Catmull-Rom turned into cubic Béziers, kept inside the box). */
export function smooth(pts: [number, number][], top: number, bottom: number): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const k = 1 / 6;
    const c1y = Math.min(bottom, Math.max(top, p1[1] + (p2[1] - p0[1]) * k));
    const c2y = Math.min(bottom, Math.max(top, p2[1] - (p3[1] - p1[1]) * k));
    d += ` C${(p1[0] + (p2[0] - p0[0]) * k).toFixed(2)},${c1y.toFixed(2)} ${(p2[0] - (p3[0] - p1[0]) * k).toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`;
  }
  return d;
}

let sparkId = 0;

/**
 * A small live chart: a smooth line over a fading area, a faint midline, and a glowing dot at the
 * newest value. Until the history fills, what there is spreads across the whole width.
 */
export function Sparkline({
  data,
  color,
  max,
  height = 44,
  points = 60,
}: {
  data: number[];
  color: string;
  max?: number;
  height?: number;
  points?: number;
}) {
  const [id] = useState(() => `spark${++sparkId}`);
  const w = 100;
  const top = Math.max(max ?? Math.max(...data, 1) * 1.15, 1e-6);
  const shown = data.slice(-points);
  const n = Math.max(shown.length - 1, 1);
  const xy: [number, number][] = shown.map((v, i) => [(i / n) * w, height - 3 - (Math.min(Math.max(v, 0), top) / top) * (height - 6)]);
  const line = smooth(xy, 2, height - 2);
  const area = line ? `${line} L${w},${height} L0,${height} Z` : "";
  const last = xy[xy.length - 1];
  return (
    <div className="relative" style={{ height }}>
      <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="absolute inset-0 block h-full w-full overflow-visible">
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.28" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={0} x2={w} y1={height / 2} y2={height / 2} stroke="var(--color-line)" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" opacity={0.6} />
        {area && <path d={area} fill={`url(#${id})`} />}
        {line && <path d={line} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />}
      </svg>
      {last && shown.length > 1 && (
        // The dot is HTML so it stays round however the chart stretches.
        <span
          className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{ left: `${last[0]}%`, top: `${(last[1] / height) * 100}%`, background: color, boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 22%, transparent)` }}
        />
      )}
    </div>
  );
}

export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-raised shadow-[inset_0_1px_2px_rgb(0_0_0/0.15)]">
      <motion.div
        className="h-full rounded-full"
        style={{ background: `linear-gradient(90deg, color-mix(in srgb, ${color} 70%, transparent), ${color})`, boxShadow: `0 0 10px -2px ${color}` }}
        initial={{ width: 0 }}
        animate={{ width: `${Math.min(Math.max(value, 0), 100)}%` }}
        transition={{ type: "spring", stiffness: 80, damping: 20 }}
      />
    </div>
  );
}

/** Semantic colour for a "how full / how loaded" percentage. */
export function loadColor(pct: number, warnAt = 75, riskAt = 90): string {
  if (pct >= riskAt) return "var(--color-risk)";
  if (pct >= warnAt) return "var(--color-warn)";
  return "var(--color-accent)";
}

/** A byte count that grows or shrinks smoothly, switching units as it goes. */
export function AnimatedBytes({ value }: { value: number }) {
  const fmt = useFmt();
  const spring = useSpring(value, { stiffness: 90, damping: 20 });
  const text = useTransform(spring, (v) => fmt.bytes(Math.max(0, v)));
  useEffect(() => {
    spring.set(value);
  }, [value, spring]);
  return <motion.span className="num">{text}</motion.span>;
}

const BUTTON_VARIANTS = {
  primary: "bg-accent text-bg hover:bg-accent-hover",
  danger: "bg-risk text-bg hover:bg-risk-hover",
  ghost: "border border-line text-fg hover:bg-raised",
  quiet: "text-muted hover:bg-raised hover:text-fg",
};

export function Button({
  variant = "ghost",
  icon,
  children,
  className = "",
  ...props
}: HTMLMotionProps<"button"> & { variant?: keyof typeof BUTTON_VARIANTS; icon?: ReactNode; children?: ReactNode }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      className={`reveal inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg px-3.5 text-[13px] font-medium transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 ${BUTTON_VARIANTS[variant]} ${className}`}
      {...props}
    >
      {icon}
      {children}
    </motion.button>
  );
}

/** Three-state checkbox: on, off, or "mixed" when only part of a group is on. */
export function Checkbox({
  state,
  onChange,
  disabled,
  label,
}: {
  state: boolean | "mixed";
  onChange: () => void;
  disabled?: boolean;
  label: string;
}) {
  const filled = state !== false;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state}
      aria-label={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-30 ${
        filled ? "border-accent bg-accent" : "border-line-strong hover:border-muted"
      }`}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="var(--color-bg)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <motion.path
          d={state === "mixed" ? "M4 8h8" : "M3.5 8.5l3 3 6-7"}
          initial={false}
          animate={{ pathLength: filled ? 1 : 0, opacity: filled ? 1 : 0 }}
          transition={{ duration: 0.16 }}
        />
      </svg>
    </button>
  );
}

export function Modal({ open, onClose, children, width = "max-w-[460px]" }: { open: boolean; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-6 backdrop-blur-[3px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            className={`w-full ${width} rounded-card border border-line bg-surface p-6 shadow-2xl`}
            initial={{ scale: 0.96, y: 8 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** An on/off switch, for things that are either running with Windows or not. */
export function Switch({ on, onChange, disabled, label }: { on: boolean; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      className={`relative h-[22px] w-[40px] shrink-0 rounded-full border transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-40 ${
        on ? "border-accent bg-accent" : "border-line-strong bg-transparent hover:border-muted"
      }`}
    >
      <motion.span
        className={`absolute top-[3px] h-[14px] w-[14px] rounded-full ${on ? "bg-bg" : "bg-muted"}`}
        initial={false}
        animate={{ left: on ? 21 : 3 }}
        transition={{ type: "spring", stiffness: 500, damping: 32 }}
      />
    </button>
  );
}
