import { useEffect, type ReactNode } from "react";
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
      className={`reveal rounded-card border border-line bg-surface p-5 transition-colors duration-200 hover:border-[#36404d] ${to ? "cursor-pointer" : ""} ${className}`}
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
  const w = 100;
  const top = Math.max(max ?? Math.max(...data, 1), 1e-6);
  const step = w / (points - 1);
  const offset = points - data.length;
  const xy = data.map((v, i) => {
    const x = (offset + i) * step;
    const y = height - 2 - (Math.min(v, top) / top) * (height - 4);
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const line = xy.length > 1 ? `M${xy.join(" L")}` : "";
  const area = line ? `${line} L${w},${height} L${(offset * step).toFixed(2)},${height} Z` : "";
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      {area && <path d={area} fill={color} opacity={0.12} />}
      {line && (
        <path d={line} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      )}
    </svg>
  );
}

export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-raised">
      <motion.div
        className="h-full rounded-full"
        style={{ background: color }}
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
  primary: "bg-accent text-bg hover:bg-[#74cfff]",
  danger: "bg-risk text-bg hover:bg-[#ffb3bb]",
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
        filled ? "border-accent bg-accent" : "border-[#4a5462] hover:border-muted"
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

export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
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
            className="w-full max-w-[460px] rounded-card border border-line bg-surface p-6 shadow-2xl"
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
        on ? "border-accent bg-accent" : "border-[#4a5462] bg-transparent hover:border-muted"
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
