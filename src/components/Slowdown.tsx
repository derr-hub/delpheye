import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AlertTriangle, CheckCircle2, Info, Snail, XCircle, type LucideIcon } from "lucide-react";
import { go, type Page } from "../lib/app";
import { useFmt } from "../lib/format";
import { useMonitor } from "../lib/monitor";
import { keyOf, useProcesses } from "../lib/processes";
import { Button, Modal } from "./ui";

type Level = "ok" | "warn" | "bad" | "unknown";

interface Culprit {
  name: string;
  description: string | null;
  exe: string | null;
  known: string | null;
  count: number;
  cpu: number;
  disk: number;
  memory: number;
  pid: number;
  start: number;
}

interface Cause {
  id: string;
  level: Level;
  culprit: Culprit | null;
  values: Record<string, number | null> | null;
}

interface Diagnosis {
  causes: Cause[];
}

const SECONDS = 8;

export const useSlowdown = create<{ open: boolean; running: boolean; second: number; result: Diagnosis | null; error: string | null }>(() => ({
  open: false,
  running: false,
  second: 0,
  result: null,
  error: null,
}));

let listening = false;

/** Opens the panel and starts watching. */
export async function checkSlowdown() {
  if (useSlowdown.getState().running) return;
  if (!listening) {
    listening = true;
    listen<number>("slowdown:progress", ({ payload }) => useSlowdown.setState({ second: payload })).catch(console.error);
  }
  useSlowdown.setState({ open: true, running: true, second: 0, result: null, error: null });
  try {
    useSlowdown.setState({ result: await invoke<Diagnosis>("slowdown_check"), running: false });
  } catch (e) {
    useSlowdown.setState({ error: String(e), running: false });
  }
}

const ICON: Record<Level, LucideIcon> = { ok: CheckCircle2, warn: AlertTriangle, bad: XCircle, unknown: Info };
const TONE: Record<Level, string> = { ok: "text-safe", warn: "text-warn", bad: "text-risk", unknown: "text-muted" };

/** Where each cause can be dealt with. */
const ACTION: Record<string, { page?: Page; url?: string; label: string }> = {
  thermal: { page: "monitoring", label: "toMonitoring" },
  paging: { page: "processes", label: "toProcesses" },
  "memory-full": { page: "processes", label: "toProcesses" },
  "memory-tight": { page: "processes", label: "toProcesses" },
  "cpu-busy": { page: "processes", label: "toProcesses" },
  "disk-busy": { page: "processes", label: "toProcesses" },
  "power-saver": { url: "ms-settings:powersleep", label: "toPower" },
  "drive-full": { page: "cleanup", label: "toCleanup" },
};

function CauseCard({ cause, close }: { cause: Cause; close: () => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const Icon = ICON[cause.level];
  const values = Object.fromEntries(Object.entries(cause.values ?? {}).map(([k, v]) => [k, v ?? "—"]));
  const c = cause.culprit;
  const action = ACTION[cause.id];
  const name = c ? c.description || c.name.replace(/\.exe$/i, "") : "";
  return (
    <motion.li initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="rounded-xl border border-line bg-surface px-4 py-3.5" data-testid={`slow-${cause.id}`}>
      <div className="flex items-start gap-3">
        <Icon size={18} className={`mt-0.5 shrink-0 ${TONE[cause.level]}`} />
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{t(`slowdown.cause.${cause.id}.title`, { ...values, name })}</div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{t(`slowdown.cause.${cause.id}.text`, { ...values, name })}</p>
          {c && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-raised/50 px-3 py-2 text-[12px]">
              <span className="font-medium">{name}</span>
              {c.count > 1 && <span className="text-muted">{t("overview.procCount", { count: c.count })}</span>}
              <span className="num text-muted">
                {t("slowdown.cpu")} {c.cpu.toFixed(0)}% · {t("slowdown.memory")} {fmt.bytes(c.memory)} · {t("slowdown.disk")} {fmt.bytes(c.disk)}/{t("processes.perSecond")}
              </span>
              <button
                className="ml-auto text-accent hover:underline"
                onClick={() => {
                  useProcesses.setState({ selected: keyOf(c) });
                  go("processes");
                  close();
                }}
              >
                {t("slowdown.showProcess")}
              </button>
            </div>
          )}
          {action && !c && (
            <Button
              className="mt-2"
              onClick={() => {
                if (action.url) openUrl(action.url).catch(console.error);
                else if (action.page) {
                  if (action.page === "monitoring") useMonitor.setState({ tab: "sensors" });
                  go(action.page);
                  close();
                }
              }}
            >
              {t(`slowdown.${action.label}`)}
            </Button>
          )}
        </div>
      </div>
    </motion.li>
  );
}

/** The panel: watching for a few seconds, then the causes in plain words. */
export function SlowdownPanel() {
  const { t } = useTranslation();
  const { open, running, second, result, error } = useSlowdown();
  const close = () => !running && useSlowdown.setState({ open: false });
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  });
  return (
    <Modal open={open} onClose={close}>
      <div className="w-[560px] max-w-full" data-testid="slowdown-panel">
        <h2 className="flex items-center gap-2 font-display text-[18px] font-semibold">
          <Snail size={18} className="text-accent" />
          {t("slowdown.title")}
        </h2>
        <AnimatePresence mode="wait">
          {running ? (
            <motion.div key="watching" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-6">
              <p className="text-[13px] text-muted">{t("slowdown.watching")}</p>
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-raised">
                <motion.div className="h-full rounded-full bg-accent" animate={{ width: `${(second / SECONDS) * 100}%` }} transition={{ type: "spring", stiffness: 60, damping: 18 }} />
              </div>
              <p className="mt-2 text-[11px] text-muted/80">{t("slowdown.hint")}</p>
            </motion.div>
          ) : (
            <motion.div key="result" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
              {error && <p className="mt-3 text-[12px] text-risk">{error}</p>}
              {result && (
                <ul className="mt-4 max-h-[60vh] space-y-2.5 overflow-y-auto pr-1">
                  {result.causes.map((c) => (
                    <CauseCard key={c.id} cause={c} close={() => useSlowdown.setState({ open: false })} />
                  ))}
                </ul>
              )}
              <div className="mt-5 flex justify-end gap-2">
                <Button onClick={checkSlowdown}>{t("slowdown.again")}</Button>
                <Button variant="primary" onClick={close}>
                  {t("report.done")}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  );
}
