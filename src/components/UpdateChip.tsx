import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowUpCircle, Loader2 } from "lucide-react";
import { useApp } from "../lib/app";
import { checkForUpdate, installUpdate, notesFor, useUpdate } from "../lib/update";
import { Button, Modal } from "./ui";

/** The version at the foot of the navigation; it turns into an invitation when a newer release exists. */
export function UpdateChip() {
  const { t, i18n } = useTranslation();
  const version = useApp((s) => s.status?.version);
  const { phase, version: next, notes, progress, error } = useUpdate();
  const [open, setOpen] = useState(false);

  return (
    <>
      <AnimatePresence mode="popLayout" initial={false}>
        {phase === "available" || phase === "downloading" || phase === "ready" ? (
          <motion.button
            key="available"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(true)}
            data-testid="update-available"
            className="reveal mb-2 flex w-full items-center gap-2 rounded-lg bg-accent/10 px-3 py-2 text-left text-[12px] text-accent hover:bg-accent/15"
          >
            <ArrowUpCircle size={15} />
            <span className="min-w-0 flex-1 truncate">{t("update.available", { version: next })}</span>
          </motion.button>
        ) : (
          <motion.button
            key="version"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => checkForUpdate(false)}
            disabled={phase === "checking"}
            title={error ?? undefined}
            data-testid="update-check"
            className="mb-2 flex items-center gap-1.5 px-3 text-left text-[11px] text-muted/80 hover:text-fg"
          >
            {phase === "checking" && <Loader2 size={11} className="animate-spin" />}
            <span className="num">v{version ?? "…"}</span>
            <span>· {t(`update.${phase === "idle" ? "check" : phase === "none" ? "latest" : phase === "error" ? "failed" : "checking"}`)}</span>
          </motion.button>
        )}
      </AnimatePresence>

      <Modal open={open} onClose={() => phase !== "downloading" && setOpen(false)}>
        <h2 className="font-display text-[18px] font-semibold">{t("update.title", { version: next })}</h2>
        <p className="mt-1 text-[12px] text-muted">{t("update.current", { version })}</p>
        {notes && <div className="mt-3 max-h-56 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-bg/50 px-3 py-2 text-[12px] leading-relaxed">{notesFor(notes, i18n.language)}</div>}
        <p className="mt-3 text-[12px] leading-relaxed text-muted">{t("update.how")}</p>
        {phase === "downloading" && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-raised">
            <motion.div className="h-full rounded-full bg-accent" animate={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
        {phase === "error" && <p className="mt-3 text-[12px] text-risk">{t("update.error", { message: error })}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button onClick={() => setOpen(false)} disabled={phase === "downloading"}>
            {t("update.later")}
          </Button>
          <Button variant="primary" onClick={installUpdate} disabled={phase === "downloading" || phase === "ready"} data-testid="update-install">
            {phase === "downloading" ? t("update.downloading", { value: Math.round(progress * 100) }) : t("update.install")}
          </Button>
        </div>
      </Modal>
    </>
  );
}
