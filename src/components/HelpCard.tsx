import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileDown, FolderOpen, HeartHandshake, Loader2 } from "lucide-react";
import { buildReport, openReport, revealSaved, useReport, type Step } from "../lib/report";
import { Button, Card, Modal } from "./ui";

const STEPS: Step[] = ["crashes", "security", "startup", "network", "processes", "saving"];

/** On the Overview: make a report for someone who helps, or open one a relative sent. */
export function HelpCard() {
  const { t } = useTranslation();
  const { building, step, saved, error } = useReport();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  return (
    <Card className="col-span-6" title={t("report.cardTitle")} icon={<HeartHandshake size={15} />}>
      <div className="flex flex-wrap items-center gap-4">
        <p className="min-w-0 flex-1 text-[0.75rem] leading-relaxed text-muted">{t("report.cardText")}</p>
        <Button variant="primary" icon={<FileDown size={15} />} onClick={() => setOpen(true)} data-testid="report-create">
          {t("report.create")}
        </Button>
        <Button icon={<FolderOpen size={15} />} onClick={openReport} data-testid="report-open">
          {t("report.open")}
        </Button>
      </div>
      {error && !open && <p className="mt-2 text-[0.75rem] text-risk">{t("report.error", { message: error })}</p>}

      <Modal open={open} onClose={() => !building && setOpen(false)}>
        <h2 className="font-display text-[1.125rem] font-semibold">{t("report.createTitle")}</h2>
        {saved ? (
          <div className="mt-3 space-y-3 text-[0.8125rem] leading-relaxed" data-testid="report-saved">
            <p className="text-safe">{t("report.savedText")}</p>
            <p className="num break-all rounded-lg border border-line bg-bg/50 px-3 py-2 text-[0.6875rem]">{saved}</p>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setOpen(false);
                  useReport.setState({ saved: null });
                  setNote("");
                }}
              >
                {t("report.done")}
              </Button>
              <Button variant="primary" icon={<FolderOpen size={14} />} onClick={revealSaved}>
                {t("report.showFile")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{t("report.createText")}</p>
            <label className="mt-3 block text-[0.75rem] text-muted">
              {t("report.noteLabel")}
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 1000))}
                disabled={building}
                rows={3}
                placeholder={t("report.notePlaceholder")}
                className="mt-1 w-full resize-none rounded-lg border border-line bg-bg/50 px-3 py-2 text-[0.8125rem] text-fg outline-none placeholder:text-muted/60 focus:border-accent/60"
                data-testid="report-note-input"
              />
            </label>
            <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted/80">{t("report.privacy")}</p>
            {building && (
              <ul className="mt-3 space-y-1 text-[0.75rem]" data-testid="report-progress">
                {STEPS.map((s) => {
                  const index = STEPS.indexOf(s);
                  const current = step ? STEPS.indexOf(step) : -1;
                  return (
                    <li key={s} className={`flex items-center gap-2 ${index < current ? "text-safe" : index === current ? "text-fg" : "text-muted/60"}`}>
                      {index === current ? <Loader2 size={12} className="animate-spin" /> : <span className="w-3 text-center">{index < current ? "✓" : "·"}</span>}
                      {t(`report.step.${s}`)}
                    </li>
                  );
                })}
              </ul>
            )}
            {error && <p className="mt-2 text-[0.75rem] text-risk">{t("report.error", { message: error })}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <Button onClick={() => setOpen(false)} disabled={building}>
                {t("cleanup.cancel")}
              </Button>
              <Button variant="primary" icon={<FileDown size={14} />} onClick={() => buildReport(note)} disabled={building} data-testid="report-build">
                {building ? t("report.building") : t("report.build")}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </Card>
  );
}
