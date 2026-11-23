import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { setTheme, useTheme, type ThemePref } from "../lib/theme";

const DRAW = { duration: 0.55, ease: [0.65, 0, 0.35, 1] as const };

/** Icons drawn stroke by stroke: replayed each time `play` changes. */
function ThemeIcon({ kind, play, size = 16 }: { kind: ThemePref; play: number; size?: number }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  const draw = (delay = 0) => ({ initial: { pathLength: 0, opacity: 0 }, animate: { pathLength: 1, opacity: 1 }, transition: { ...DRAW, delay } });
  return (
    <svg key={`${kind}-${play}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      {kind === "light" && (
        <>
          <motion.circle cx={12} cy={12} r={4} {...common} {...draw()} />
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a, i) => {
            const r = (a * Math.PI) / 180;
            return (
              <motion.line
                key={a}
                x1={12 + Math.cos(r) * 7}
                y1={12 + Math.sin(r) * 7}
                x2={12 + Math.cos(r) * 9.5}
                y2={12 + Math.sin(r) * 9.5}
                {...common}
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={{ duration: 0.25, delay: 0.25 + i * 0.04 }}
              />
            );
          })}
        </>
      )}
      {kind === "dark" && (
        <>
          <motion.path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z" {...common} {...draw()} />
          <motion.path d="M17 4.5v2M16 5.5h2" {...common} {...draw(0.45)} />
        </>
      )}
      {kind === "system" && (
        <>
          <motion.rect x={3} y={4} width={18} height={12} rx={2} {...common} {...draw()} />
          <motion.path d="M8 20h8M12 16v4" {...common} {...draw(0.35)} />
        </>
      )}
    </svg>
  );
}

/** The theme button in the sidebar: a small menu of three, the chosen icon drawn in. */
export function ThemeMenu() {
  const { t } = useTranslation();
  const pref = useTheme((s) => s.pref);
  const [open, setOpen] = useState(false);
  const [play, setPlay] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (p: ThemePref) => {
    setTheme(p);
    setPlay((x) => x + 1);
    window.setTimeout(() => setOpen(false), 380);
  };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen(!open)}
        title={t("theme.label", { mode: t(`theme.${pref}`) })}
        aria-label={t("theme.label", { mode: t(`theme.${pref}`) })}
        aria-expanded={open}
        data-testid="theme-toggle"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:bg-raised hover:text-fg"
      >
        <ThemeIcon kind={pref} play={play} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.97 }}
            transition={{ type: "spring", stiffness: 480, damping: 34 }}
            style={{ transformOrigin: "bottom center" }}
            className="absolute bottom-10 left-1/2 z-50 w-[11rem] -translate-x-1/2 rounded-xl border border-line bg-surface p-1 shadow-[0_16px_40px_-12px_rgb(0_0_0/0.5)]"
            role="menu"
            data-testid="theme-menu"
          >
            {(["system", "light", "dark"] as const).map((p) => (
              <button
                key={p}
                role="menuitemradio"
                aria-checked={pref === p}
                onClick={() => pick(p)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[0.75rem] ${pref === p ? "bg-accent/10 text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
                data-testid={`theme-${p}`}
              >
                <span className={pref === p ? "text-accent" : ""}>
                  <ThemeIcon kind={p} play={pref === p ? play : 0} />
                </span>
                <span className="flex-1">{t(`theme.option.${p}`)}</span>
                {pref === p && <Check size={13} className="text-accent" />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
