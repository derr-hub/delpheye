import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Activity, ArrowDown, ArrowUp, ListTree, Loader2 } from "lucide-react";
import { go } from "../lib/app";
import { useCleanup } from "../lib/cleanup";
import { useDisk } from "../lib/disk";
import { useFmt } from "../lib/format";
import { useLeftovers } from "../lib/leftovers";
import { useMetrics } from "../lib/metrics";
import { useMonitor } from "../lib/monitor";
import { useSecurity } from "../lib/security";
import { Sparkline } from "./ui";
import { checkSlowdown } from "./Slowdown";

/** Whatever long job is running anywhere in the app, so it stays visible from every page. */
function useActivity(): { label: string; progress: number | null; page: Parameters<typeof go>[0] } | null {
  const { t } = useTranslation();
  const cleanup = useCleanup((s) => s.phase);
  const leftovers = useLeftovers((s) => s.phase);
  const security = useSecurity((s) => s.phase);
  const disk = useDisk((s) => s.phase);
  const stress = useMonitor((s) => s.stress);
  if (stress.running) return { label: t("island.stress"), progress: stress.points.length / Math.max(1, stress.total), page: "monitoring" };
  if (cleanup === "scanning") return { label: t("island.cleanupScan"), progress: null, page: "cleanup" };
  if (cleanup === "cleaning") return { label: t("island.cleaning"), progress: null, page: "cleanup" };
  if (leftovers === "scanning") return { label: t("island.leftovers"), progress: null, page: "leftovers" };
  if (security === "scanning") return { label: t("island.security"), progress: null, page: "security" };
  if (disk === "indexing") return { label: t("island.disk"), progress: null, page: "disk" };
  return null;
}

const SPRING = { type: "spring", stiffness: 420, damping: 32 } as const;

/**
 * A small capsule in the middle of the title bar. At rest it shows how the machine is doing;
 * while a long job runs anywhere it shows that job; clicked, it opens into a live summary.
 */
export function Island() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const current = useMetrics((s) => s.current);
  const history = useMetrics((s) => s.history);
  const throttle = useMonitor((s) => s.frame?.throttle);
  const activity = useActivity();

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

  const cpu = current ? Math.round(current.cpuUsage) : null;
  const mem = current ? Math.round((current.memUsed / Math.max(1, current.memTotal)) * 100) : null;
  const temp = throttle?.temp ? Math.round(throttle.temp) : null;
  const tone = (cpu ?? 0) >= 90 || (mem ?? 0) >= 90 || throttle?.state === "thermal" ? "bg-warn" : "bg-safe";

  return (
    <div ref={box} className="relative flex justify-center">
      <motion.button
        layout
        transition={SPRING}
        onClick={() => setOpen(!open)}
        data-testid="island"
        aria-expanded={open}
        className="reveal flex h-[26px] items-center gap-2 overflow-hidden rounded-full border border-line bg-surface/80 px-3 text-[11px] text-muted shadow-sm hover:text-fg"
      >
        <AnimatePresence mode="popLayout" initial={false}>
          {activity ? (
            <motion.span key="job" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="flex items-center gap-2 text-fg">
              <Loader2 size={12} className="animate-spin text-accent" />
              <span className="whitespace-nowrap">{activity.label}</span>
              {activity.progress !== null && (
                <span className="h-1 w-14 overflow-hidden rounded-full bg-raised">
                  <motion.span className="block h-full rounded-full bg-accent" animate={{ width: `${Math.round(activity.progress * 100)}%` }} />
                </span>
              )}
            </motion.span>
          ) : (
            <motion.span key="rest" layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} className="num flex items-center gap-2 whitespace-nowrap">
              <span className="relative flex h-1.5 w-1.5">
                <motion.span className={`absolute inset-0 rounded-full ${tone}`} animate={{ scale: [1, 2.4], opacity: [0.6, 0] }} transition={{ duration: 1.8, repeat: Infinity, ease: "easeOut" }} />
                <span className={`relative h-1.5 w-1.5 rounded-full ${tone}`} />
              </span>
              <span>
                {t("island.cpu")} {cpu ?? "—"}%
              </span>
              <span className="text-line">|</span>
              <span>
                {t("island.ram")} {mem ?? "—"}%
              </span>
              {temp !== null && (
                <>
                  <span className="text-line">|</span>
                  <span>{temp}°</span>
                </>
              )}
            </motion.span>
          )}
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>
        {open && (
          <div className="absolute left-1/2 top-[34px] z-50 -translate-x-1/2">
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.96 }}
              transition={SPRING}
              style={{ transformOrigin: "top center" }}
              className="w-[400px] rounded-2xl border border-line bg-surface/95 p-4 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.65)] backdrop-blur-xl"
              data-testid="island-panel"
            >
              {activity && (
                <button
                  onClick={() => {
                    go(activity.page);
                    setOpen(false);
                  }}
                  className="mb-3 flex w-full items-center gap-2 rounded-xl bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"
                >
                  <Loader2 size={13} className="animate-spin" />
                  {activity.label}
                  <span className="ml-auto">{t("island.open")}</span>
                </button>
              )}
              <div className="grid grid-cols-2 gap-3">
                {(
                  [
                    [t("island.cpu"), `${cpu ?? "—"}%`, history.cpu, "var(--color-accent)"],
                    [t("island.ram"), current ? `${fmt.bytes(current.memUsed)}` : "—", history.mem, "#3987e5"],
                  ] as const
                ).map(([label, value, data, color]) => (
                  <div key={label} className="rounded-xl bg-raised/50 px-3 pb-1 pt-2">
                    <div className="flex items-baseline justify-between text-[11px] text-muted">
                      {label}
                      <span className="num text-[13px] text-fg">{value}</span>
                    </div>
                    <Sparkline data={[...data]} color={color} max={100} height={34} />
                  </div>
                ))}
              </div>
              <dl className="mt-3 grid grid-cols-[1fr_auto] gap-y-1.5 text-[12px]">
                <dt className="text-muted">{t("island.cpuState")}</dt>
                <dd>{throttle ? t(`monitor.throttle.${throttle.state}`) : "—"}{temp !== null ? ` · ${temp} °C` : ""}</dd>
                <dt className="text-muted">{t("island.network")}</dt>
                <dd className="num flex gap-3">
                  <span className="flex items-center gap-1">
                    <ArrowDown size={11} className="text-safe" />
                    {fmt.bytes(current?.netRx ?? 0)}/s
                  </span>
                  <span className="flex items-center gap-1">
                    <ArrowUp size={11} className="text-accent" />
                    {fmt.bytes(current?.netTx ?? 0)}/s
                  </span>
                </dd>
                <dt className="text-muted">{t("island.processes")}</dt>
                <dd className="num">{current?.processCount ?? "—"}</dd>
              </dl>
              <button
                onClick={() => {
                  setOpen(false);
                  checkSlowdown();
                }}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent/10 py-1.5 text-[12px] text-accent hover:bg-accent/15"
              >
                {t("slowdown.button")}
              </button>
              <div className="mt-2 flex gap-2">
                {(
                  [
                    ["processes", ListTree],
                    ["monitoring", Activity],
                  ] as const
                ).map(([page, Icon]) => (
                  <button
                    key={page}
                    onClick={() => {
                      go(page);
                      setOpen(false);
                    }}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-line py-1.5 text-[12px] text-muted hover:bg-raised hover:text-fg"
                  >
                    <Icon size={13} />
                    {t(`nav.${page}`)}
                  </button>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
