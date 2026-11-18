import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { ArchiveRestore, Brush, ChevronDown, History, ListX, Rocket, ShieldHalf, ShieldOff, Trash2, Undo2, type LucideIcon } from "lucide-react";
import type { CategoryResult } from "../lib/cleanup";
import { useFmt } from "../lib/format";
import { useCleanupNames } from "./cleanup/Report";

interface Entry {
  id: number;
  /** Unix seconds. */
  at: number;
  kind: string;
  bytes: number;
  files: number;
  skipped: number;
  details: { categories?: CategoryResult[]; sandbox?: boolean; items?: { path: string; bytes: number }[]; name?: string; from?: string; to?: string } | null;
}

function Row({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const names = useCleanupNames();
  const [open, setOpen] = useState(false);
  const categories = entry.details?.categories ?? [];
  const items = entry.details?.items ?? [];
  const Icon: LucideIcon = { trash: Trash2, quarantine: ArchiveRestore, restore: Undo2, purge: ShieldOff, startup: Rocket, security: ShieldHalf, process: ListX }[entry.kind] ?? Brush;
  const known = ["cleanup", "trash", "quarantine", "restore", "purge", "startup", "security", "process"].includes(entry.kind);
  // Quarantine and restore move things but free nothing, so they show a count instead.
  const frees = !["quarantine", "restore", "startup", "security", "process"].includes(entry.kind);

  return (
    <li className="border-b border-line last:border-b-0" data-testid="journal-entry">
      <button
        className="flex w-full items-center gap-3.5 px-5 py-3.5 text-left transition-colors duration-150 hover:bg-raised/40"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
          <Icon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] font-medium">
            {known ? t(`journal.${entry.kind}`) : entry.kind}
            {entry.details?.sandbox && (
              <span className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] font-normal text-warn">{t("app.sandbox")}</span>
            )}
          </div>
          <div className="num text-[12px] text-muted">{fmt.dateTime(entry.at)}</div>
        </div>
        <div className="shrink-0 text-right">
          {frees && <div className="num text-[14px] text-safe">{t("journal.freed", { value: fmt.bytes(entry.bytes) })}</div>}
          <div className={`num text-muted ${frees ? "text-[11px]" : "text-[13px]"}`}>
            {t(frees ? "journal.files" : "journal.items", { value: fmt.int(entry.files) })}
            {entry.skipped > 0 && ` · ${t("journal.skipped", { value: fmt.int(entry.skipped) })}`}
          </div>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="shrink-0 text-muted">
          <ChevronDown size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden border-t border-line/60 bg-bg/40 pl-[70px] pr-5 text-[13px]"
          >
            {entry.details?.name && (
              <li className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate">{entry.details.name}</span>
                <span className="shrink-0 text-muted">
                  {t(`startup.state.${entry.details.from}`)} → {t(`startup.state.${entry.details.to}`, { defaultValue: entry.details.to })}
                </span>
              </li>
            )}
            {items.map((item) => (
              <li key={item.path} className="flex items-center gap-3 py-2">
                <span className="num min-w-0 flex-1 truncate text-[12px]" title={item.path}>
                  {item.path}
                </span>
                <span className="num shrink-0 text-muted">{fmt.bytes(item.bytes)}</span>
              </li>
            ))}
            {categories.map((c) => (
              <li key={c.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 truncate">{names.category(c)}</span>
                {c.skippedFiles > 0 && (
                  <span className="num shrink-0 text-[11px] text-warn">{t("journal.skipped", { value: fmt.int(c.skippedFiles) })}</span>
                )}
                <span className="num shrink-0 text-muted">{fmt.bytes(c.freedBytes)}</span>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </li>
  );
}

export function Journal() {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    invoke<Entry[]>("journal_list", { limit: 200 })
      .then(setEntries)
      .catch((e) => {
        console.error("journal_list failed", e);
        setEntries([]);
      });
  }, []);

  if (!entries) return null;
  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-surface text-muted">
          <History size={28} />
        </div>
        <h2 className="font-display text-[18px] font-semibold">{t("journal.empty")}</h2>
        <p className="mt-2 max-w-[48ch] text-[13px] leading-relaxed text-muted">{t("journal.emptyText")}</p>
        <div className="mt-6">
          <ErrorLogLink />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-3 pb-2">
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {entries.map((entry) => (
          <Row key={entry.id} entry={entry} />
        ))}
      </ul>
      <ErrorLogLink />
    </div>
  );
}

/** Where to find the error log when something went wrong. */
function ErrorLogLink() {
  const { t } = useTranslation();
  return (
    <p className="px-1 text-[12px] text-muted">
      {t("journal.errorLog")}{" "}
      <button className="text-accent hover:underline" onClick={() => invoke("open_log_folder").catch(console.error)} data-testid="open-log">
        {t("journal.openErrorLog")}
      </button>
    </p>
  );
}
