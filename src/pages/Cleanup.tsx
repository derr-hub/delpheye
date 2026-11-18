import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { History, RefreshCw, ScanSearch } from "lucide-react";
import { AnimatedBytes, AnimatedNumber, Button, Ring } from "../components/ui";
import { go } from "../lib/app";
import { cancel, scan, useCleanup, type CleanReport, type Progress } from "../lib/cleanup";
import { useFmt } from "../lib/format";
import { Report, useCleanupNames } from "./cleanup/Report";

const KNOWN_ERRORS = ["busy", "stale", "environment"];

function Intro({ error }: { error: string | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="relative mb-7 flex h-28 w-28 items-center justify-center rounded-full border border-line bg-surface text-accent">
        <motion.span
          className="absolute inset-0 rounded-full border border-accent/50"
          animate={{ scale: [1, 1.28], opacity: [0.7, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
        />
        <ScanSearch size={44} strokeWidth={1.4} />
      </div>
      <h2 className="font-display text-[20px] font-semibold">{t("cleanup.introTitle")}</h2>
      <p className="mt-2 max-w-[44ch] text-[13px] leading-relaxed text-muted">{t("cleanup.introText")}</p>
      <Button variant="primary" className="mt-6 !h-10 !px-7" onClick={scan} data-testid="scan">
        {t("cleanup.scan")}
      </Button>
      {error && (
        <p className="mt-4 text-[12px] text-risk" role="alert">
          {KNOWN_ERRORS.includes(error) ? t(`cleanup.error.${error}`) : t("cleanup.error.other", { message: error })}
        </p>
      )}
    </div>
  );
}

function Working({ progress, cleaning }: { progress: Progress | null; cleaning: boolean }) {
  const { t } = useTranslation();
  const percent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Ring value={percent} color={cleaning ? "var(--color-safe)" : "var(--color-accent)"} size={168}>
        <span className="font-display text-[36px] font-semibold leading-none">
          <AnimatedNumber value={percent} />
          <span className="text-[16px] text-muted">%</span>
        </span>
      </Ring>
      <div className="mt-6 font-display text-[18px] font-semibold">{t(cleaning ? "cleanup.cleaning" : "cleanup.scanning")}</div>
      <div className="mt-1 text-[13px] text-muted">
        {progress ? (
          <>
            {t(cleaning ? "cleanup.freedSoFar" : "cleanup.foundSoFar")} <AnimatedBytes value={progress.bytes} />
          </>
        ) : (
          t("cleanup.preparing")
        )}
      </div>
      {/* Fixed height: the line must not make the layout jump as paths come and go. */}
      <div className="num mt-3 h-4 w-[70%] truncate text-[11px] text-muted/70">{progress?.path ?? ""}</div>
      <Button variant="quiet" className="mt-5" onClick={cancel} data-testid="cancel">
        {t("cleanup.cancel")}
      </Button>
    </div>
  );
}

function Done({ result }: { result: CleanReport }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const names = useCleanupNames();
  const skipped = result.inUse + result.denied + result.failed;
  const reasons = [
    result.inUse > 0 && t("cleanup.skippedInUse", { value: fmt.int(result.inUse) }),
    result.denied > 0 && t("cleanup.skippedDenied", { value: fmt.int(result.denied) }),
    result.failed > 0 && t("cleanup.skippedFailed", { value: fmt.int(result.failed) }),
  ].filter(Boolean);

  return (
    <div className="mx-auto flex min-h-full max-w-[540px] flex-col items-center justify-center py-4 text-center" data-testid="done">
      <motion.div
        initial={{ scale: 0.5, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-safe/10 text-safe"
      >
        <svg viewBox="0 0 24 24" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <motion.path d="M5 12.5l4.5 4.5L19 7.5" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay: 0.15, duration: 0.35 }} />
        </svg>
      </motion.div>
      <h2 className="font-display text-[26px] font-semibold" data-testid="done-title">
        {result.freedBytes > 0 ? t("cleanup.doneTitle", { value: fmt.bytes(result.freedBytes) }) : t("cleanup.doneNothing")}
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        {t("cleanup.doneDeleted", { value: fmt.int(result.deletedFiles) })} · {t("cleanup.doneTook", { value: fmt.duration(result.durationMs) })}
        {result.cancelled && ` · ${t("cleanup.doneCancelled")}`}
      </p>

      {result.categories.length > 0 && (
        <ul className="mt-5 w-full rounded-card border border-line bg-surface px-5 py-2 text-left text-[13px]">
          {result.categories.map((c) => (
            <li key={c.id} className="flex items-center gap-3 border-b border-line/60 py-2 last:border-b-0">
              <span className="min-w-0 flex-1 truncate">{names.category(c)}</span>
              {c.skippedFiles > 0 && (
                <span className="num shrink-0 text-[11px] text-warn">{t("journal.skipped", { value: fmt.int(c.skippedFiles) })}</span>
              )}
              <span className="num shrink-0 text-muted">{fmt.bytes(c.freedBytes)}</span>
            </li>
          ))}
        </ul>
      )}
      {skipped > 0 && (
        <p className="mt-3 w-full rounded-card border border-warn/25 bg-warn/[0.06] px-5 py-3 text-left text-[12px] leading-relaxed text-muted" data-testid="skipped">
          <span className="text-warn">{t("cleanup.skipped", { value: fmt.int(skipped) })}</span>
          <br />
          {reasons.join(" · ")}
        </p>
      )}

      <div className="mt-6 flex gap-2">
        {result.journalId !== null && (
          <Button icon={<History size={15} />} onClick={() => go("journal")} data-testid="open-journal">
            {t("cleanup.openJournal")}
          </Button>
        )}
        <Button variant="primary" icon={<RefreshCw size={15} />} onClick={scan} data-testid="done-rescan">
          {t("cleanup.rescan")}
        </Button>
      </div>
    </div>
  );
}

export function Cleanup() {
  const { phase, progress, report, result, error } = useCleanup();
  // Scanning and deleting share one screen, so the ring carries on between them.
  const view = phase === "scanning" || phase === "cleaning" ? "working" : phase;

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={view}
        className="h-full"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        {view === "working" && <Working progress={progress} cleaning={phase === "cleaning"} />}
        {view === "report" && report && <Report report={report} />}
        {view === "done" && result && <Done result={result} />}
        {view === "idle" && <Intro error={error} />}
      </motion.div>
    </AnimatePresence>
  );
}
