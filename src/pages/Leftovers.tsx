import { Hero } from "../components/Hero";
import { FolderSearch } from "lucide-react";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArchiveRestore,
  ChevronDown,
  Folder,
  FolderOpen,
  KeyRound,
  ListX,
  PackageSearch,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Undo2,
} from "lucide-react";
import { AnimatedNumber, Button, Checkbox, Modal, Ring } from "../components/ui";
import { relaunchElevated } from "../lib/app";
import { shortenPath, useFmt } from "../lib/format";
import {
  CONFIDENCES,
  actOnHeld,
  cancelScan,
  isSelectable,
  loadHeld,
  quarantineSelected,
  scan,
  toggle,
  toggleLevel,
  useLeftovers,
  type Confidence,
  type Held,
  type Leftover,
  type ScanReport,
} from "../lib/leftovers";

const reveal = (path: string) => revealItemInDir(path).catch((e) => console.error("reveal failed", e));
const LEVEL_TONE: Record<Confidence, string> = {
  high: "bg-safe/10 text-safe",
  medium: "bg-warn/10 text-warn",
  low: "bg-risk/10 text-risk",
};
const KNOWN_ERRORS = ["busy", "stale", "environment"];

/** "3 months", "1.5 years": how long something has been left alone. */
function useIdle() {
  const { t } = useTranslation();
  return (lastUsed: number) => {
    const days = Math.max(0, Math.floor((Date.now() / 1000 - lastUsed) / 86_400));
    if (days < 60) return t("leftovers.idleDays", { count: days });
    if (days < 730) return t("leftovers.idleMonths", { count: Math.round(days / 30) });
    return t("leftovers.idleYears", { count: Math.round(days / 365) });
  };
}

function Badge({ level }: { level: Confidence }) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${LEVEL_TONE[level]}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(`leftovers.level.${level}`)}
    </span>
  );
}

function Notice() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const notice = useLeftovers((s) => s.notice);
  if (!notice) return null;
  return (
    <div
      className={`rounded-card border px-5 py-3 text-[12px] leading-relaxed ${notice.failed.length ? "border-warn/25 bg-warn/[0.06]" : "border-safe/25 bg-safe/[0.06]"}`}
      data-testid="leftovers-notice"
    >
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[13px]">{t(`leftovers.notice.${notice.kind}`, { count: notice.count, size: fmt.bytes(notice.bytes) })}</span>
        <button className="text-muted hover:text-fg" onClick={() => useLeftovers.setState({ notice: null })}>
          {t("disk.dismiss")}
        </button>
      </div>
      {notice.failed.map((failure) => (
        <div key={failure.path} className="mt-1 flex gap-2 text-muted">
          <span className="shrink-0 text-warn">{t(`leftovers.fail.${failure.reason}`, { defaultValue: t("leftovers.fail.failed") })}</span>
          <span className="num min-w-0 truncate" title={failure.path}>
            {shortenPath(failure.path, 90)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Intro() {
  const { t } = useTranslation();
  const error = useLeftovers((s) => s.error);
  return (
    <div className="flex flex-1 flex-col">
      <Hero
        icon={PackageSearch}
        title={t("leftovers.introTitle")}
        text={t("leftovers.introText")}
        features={[
          { icon: FolderSearch, title: t("hero.leftovers.f1"), text: t("hero.leftovers.f1t") },
          { icon: FolderOpen, title: t("hero.leftovers.f2"), text: t("hero.leftovers.f2t") },
          { icon: ArchiveRestore, title: t("hero.leftovers.f3"), text: t("hero.leftovers.f3t") },
        ]}
        action={
          <Button variant="primary" className="!h-11 !px-8 text-[14px]" onClick={scan} data-testid="leftovers-scan">
            {t("cleanup.scan")}
          </Button>
        }
        error={
          error && (
            <p className="text-[12px] text-risk" role="alert">
              {KNOWN_ERRORS.includes(error) ? t(`cleanup.error.${error}`) : t("cleanup.error.other", { message: error })}
            </p>
          )
        }
      />
    </div>
  );
}

function Scanning({ holding }: { holding: boolean }) {
  const { t } = useTranslation();
  const progress = useLeftovers((s) => s.progress);
  const percent = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;
  return (
    <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
      <Ring value={holding ? 100 : percent} color="var(--color-accent)" size={150}>
        <span className="font-display text-[32px] font-semibold leading-none">
          <AnimatedNumber value={holding ? 100 : percent} />
          <span className="text-[15px] text-muted">%</span>
        </span>
      </Ring>
      <div className="mt-6 font-display text-[18px] font-semibold">{t(holding ? "leftovers.holding" : "leftovers.scanning")}</div>
      <div className="num mt-3 h-4 w-[70%] truncate text-[11px] text-muted/70">{holding ? "" : (progress?.path ?? t("cleanup.preparing"))}</div>
      {!holding && (
        <Button variant="quiet" className="mt-5" onClick={cancelScan}>
          {t("cleanup.cancel")}
        </Button>
      )}
    </div>
  );
}

function Row({ report, item }: { report: ScanReport; item: Leftover }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const idle = useIdle();
  const checked = useLeftovers((s) => s.selected.has(item.id));
  const [open, setOpen] = useState(false);
  const locked = !isSelectable(report, item);
  const entry = item.kind === "entry";

  const facts = entry
    ? [t("leftovers.entryFact")]
    : [
        t("leftovers.idleFor", { value: idle(item.lastUsed) }),
        item.files === 0 ? t("leftovers.empty") : t("cleanup.filesCount", { value: fmt.int(item.files) }),
        item.hasPrograms ? t("leftovers.hasPrograms") : null,
        item.hasSaves ? t("leftovers.hasSaves") : null,
        item.keys.length ? t("leftovers.keysFact", { count: item.keys.length }) : null,
      ].filter(Boolean);

  return (
    <div className="border-b border-line last:border-b-0" data-testid={`leftover-${item.name}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}
        className={`flex cursor-pointer items-center gap-3.5 px-5 py-3 transition-colors duration-150 hover:bg-raised/40 ${checked ? "bg-accent/[0.05]" : ""}`}
      >
        <Checkbox state={checked} disabled={locked} onChange={() => toggle(item.id)} label={item.name} />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
          {entry ? <ListX size={17} /> : <Folder size={17} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{item.name}</span>
            {locked && (
              <span className="shrink-0 text-warn" title={t("cleanup.needsAdmin")}>
                <ShieldAlert size={14} />
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">{facts.join(" · ")}</div>
        </div>
        <span className="num shrink-0 text-[14px]">{entry ? "—" : fmt.bytes(item.bytes)}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="shrink-0 text-muted">
          <ChevronDown size={16} />
        </motion.span>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <ul className="space-y-1.5 border-t border-line/60 bg-bg/40 py-3 pl-[88px] pr-5 text-[12px]">
              {item.folders.map((folder) => (
                <li key={folder.path} className="group flex items-center gap-3">
                  <Folder size={13} className="shrink-0 text-muted" />
                  <span className="num min-w-0 flex-1 truncate" title={folder.path}>
                    {shortenPath(folder.path, 80)}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted">{fmt.date(folder.lastUsed)}</span>
                  <span className="num w-20 shrink-0 text-right text-muted">{fmt.bytes(folder.bytes)}</span>
                  <button className="shrink-0 rounded p-1 text-muted hover:text-fg" title={t("disk.reveal")} aria-label={t("disk.reveal")} onClick={() => reveal(folder.path)}>
                    <FolderOpen size={13} />
                  </button>
                </li>
              ))}
              {item.keys.map((key) => (
                <li key={key.path} className="flex items-center gap-3">
                  <KeyRound size={13} className="shrink-0 text-muted" />
                  <span className="num min-w-0 flex-1 truncate" title={key.path}>
                    {key.path}
                  </span>
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Report({ report }: { report: ScanReport }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const selected = useLeftovers((s) => s.selected);
  const [confirming, setConfirming] = useState(false);
  const [declined, setDeclined] = useState(false);

  const chosen = report.items.filter((i) => selected.has(i.id));
  const chosenBytes = chosen.reduce((sum, i) => sum + i.bytes, 0);
  const chosenFolders = chosen.reduce((sum, i) => sum + i.folders.length, 0);
  const chosenKeys = chosen.reduce((sum, i) => sum + i.keys.length, 0);
  const total = report.items.reduce((sum, i) => sum + i.bytes, 0);
  const adminWouldHelp = !report.elevated && report.items.some((i) => i.needsAdmin);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-6 rounded-card border border-line bg-surface px-5 py-4">
        <div className="min-w-0">
          <div className="font-display text-[30px] font-semibold leading-none" data-testid="leftovers-total">
            {report.items.length ? fmt.bytes(total) : t("leftovers.none")}
          </div>
          <div className="mt-1.5 truncate text-[12px] text-muted">
            {report.items.length > 0 && `${t("leftovers.found", { count: report.items.length })} · `}
            {t("leftovers.checked", { folders: fmt.int(report.checked), apps: fmt.int(report.installed), time: fmt.duration(report.durationMs) })}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <Button icon={<RefreshCw size={15} />} onClick={scan}>
            {t("cleanup.rescan")}
          </Button>
          <Button variant="primary" icon={<ArchiveRestore size={15} />} disabled={chosen.length === 0} onClick={() => setConfirming(true)} data-testid="leftovers-hold">
            {chosen.length ? `${t("leftovers.toQuarantine")} · ${fmt.bytes(chosenBytes)}` : t("cleanup.nothingSelected")}
          </Button>
        </div>
      </div>

      {adminWouldHelp && (
        <div className="flex items-center gap-4 rounded-card border border-warn/25 bg-warn/[0.06] px-5 py-3.5">
          <ShieldAlert size={20} className="shrink-0 text-warn" />
          <div className="min-w-0 flex-1 text-[12px] text-muted">{declined ? t("cleanup.adminDeclined") : t("leftovers.adminText")}</div>
          <Button onClick={async () => setDeclined(!(await relaunchElevated()))}>{t("cleanup.adminAction")}</Button>
        </div>
      )}

      {CONFIDENCES.map((level) => {
        const items = report.items.filter((i) => i.confidence === level);
        if (!items.length) return null;
        const selectable = items.filter((i) => isSelectable(report, i));
        const on = selectable.filter((i) => selected.has(i.id)).length;
        return (
          <section key={level} data-testid={`level-${level}`}>
            <div className="mb-2 flex items-center gap-3 px-1">
              <Checkbox
                state={on === 0 ? false : on === selectable.length ? true : "mixed"}
                disabled={selectable.length === 0}
                onChange={() => toggleLevel(report, level)}
                label={t(`leftovers.level.${level}`)}
              />
              <Badge level={level} />
              <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{t(`leftovers.levelHint.${level}`)}</span>
              <span className="num shrink-0 text-[12px] text-muted">{fmt.bytes(items.reduce((sum, i) => sum + i.bytes, 0))}</span>
            </div>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {items.map((item) => (
                <Row key={item.id} report={report} item={item} />
              ))}
            </div>
          </section>
        );
      })}

      <Modal open={confirming} onClose={() => setConfirming(false)}>
        <h2 className="font-display text-[18px] font-semibold">{t("leftovers.confirmTitle")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {t("leftovers.confirmText", { folders: chosenFolders, keys: chosenKeys, size: fmt.bytes(chosenBytes) })}
        </p>
        {chosen.some((i) => i.confidence !== "high") && (
          <p className="mt-3 flex gap-2 text-[12px] leading-relaxed text-warn">
            <ShieldAlert size={14} className="mt-[3px] shrink-0" />
            {t("leftovers.confirmCaution")}
          </p>
        )}
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirming(false)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="leftovers-hold-confirm"
            onClick={() => {
              setConfirming(false);
              quarantineSelected();
            }}
          >
            {t("leftovers.toQuarantine")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function HeldRow({ entry, picked, onPick, onPurge }: { entry: Held; picked: boolean; onPick: () => void; onPurge: (entries: Held[]) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const days = Math.max(0, Math.ceil((entry.expires - Date.now() / 1000) / 86_400));
  return (
    <li className={`flex items-center gap-3.5 border-b border-line px-5 py-3 transition-colors last:border-b-0 ${picked ? "bg-accent/[0.06]" : ""}`} data-testid="held-entry">
      <Checkbox state={picked} onChange={onPick} label={entry.name} />
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
        {entry.kind === "folder" ? <Folder size={17} /> : <KeyRound size={17} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[14px] font-medium">
          <span className="truncate">{entry.name}</span>
          {entry.admin && <ShieldAlert size={13} className="shrink-0 text-warn" />}
        </div>
        <div className="num truncate text-[11px] text-muted" title={entry.original}>
          {shortenPath(entry.original, 90)}
        </div>
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-[13px]">{entry.kind === "folder" ? fmt.bytes(entry.bytes) : "—"}</div>
        <div className="text-[11px] text-muted">{t("leftovers.expiresIn", { count: days })}</div>
      </div>
      <Button icon={<Undo2 size={14} />} onClick={() => actOnHeld([entry.id], true)} data-testid="held-restore">
        {t("leftovers.restore")}
      </Button>
      <Button variant="quiet" icon={<Trash2 size={14} />} onClick={() => onPurge([entry])} title={t("leftovers.purgeNow")} aria-label={t("leftovers.purgeNow")} />
    </li>
  );
}

function Quarantine() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const held = useLeftovers((s) => s.held);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [purging, setPurging] = useState<Held[] | null>(null);
  const [busy, setBusy] = useState(false);

  // Forget picks for entries that are gone (restored, deleted, expired).
  useEffect(() => {
    setPicked((old) => new Set([...old].filter((id) => held.some((h) => h.id === id))));
  }, [held]);

  if (!held.length) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center py-10 text-center">
        <div className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl border border-line bg-surface text-muted">
          <ArchiveRestore size={28} />
        </div>
        <h2 className="font-display text-[18px] font-semibold">{t("leftovers.quarantineEmpty")}</h2>
        <p className="mt-2 max-w-[50ch] text-[13px] leading-relaxed text-muted">{t("leftovers.quarantineText")}</p>
      </div>
    );
  }

  const chosen = held.filter((h) => picked.has(h.id));
  const chosenBytes = chosen.reduce((sum, h) => sum + h.bytes, 0);
  const all = chosen.length === held.length;
  const toggle = (id: number) =>
    setPicked((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const run = async (ids: number[], restore: boolean) => {
    setBusy(true);
    await actOnHeld(ids, restore);
    setBusy(false);
    setPicked(new Set());
  };
  const purgeBytes = (purging ?? []).reduce((sum, h) => sum + h.bytes, 0);
  const purgeAdmin = (purging ?? []).some((h) => h.admin);

  return (
    <div className="space-y-3">
      <p className="px-1 text-[12px] leading-relaxed text-muted">
        {t("leftovers.quarantineSummary", { size: fmt.bytes(held.reduce((sum, h) => sum + h.bytes, 0)) })}
      </p>
      <div className="sticky top-[52px] z-10 flex items-center gap-3 rounded-card border border-line bg-surface/95 px-5 py-2.5 backdrop-blur" data-testid="held-bar">
        <Checkbox
          state={all ? true : chosen.length ? "mixed" : false}
          onChange={() => setPicked(all ? new Set() : new Set(held.map((h) => h.id)))}
          label={t("leftovers.selectAll")}
        />
        <span className="min-w-0 flex-1 text-[13px]">
          {chosen.length ? t("leftovers.picked", { count: chosen.length, size: fmt.bytes(chosenBytes) }) : <span className="text-muted">{t("leftovers.selectAll")}</span>}
        </span>
        <Button icon={<Undo2 size={14} />} disabled={!chosen.length || busy} onClick={() => run(chosen.map((h) => h.id), true)} data-testid="held-restore-picked">
          {t("leftovers.restorePicked")}
        </Button>
        <Button variant="danger" icon={<Trash2 size={14} />} disabled={!chosen.length || busy} onClick={() => setPurging(chosen)} data-testid="held-purge-picked">
          {t("leftovers.purgePicked")}
        </Button>
      </div>
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {held.map((entry) => (
          <HeldRow key={entry.id} entry={entry} picked={picked.has(entry.id)} onPick={() => toggle(entry.id)} onPurge={setPurging} />
        ))}
      </ul>
      <Modal open={purging !== null} onClose={() => setPurging(null)}>
        <h2 className="font-display text-[18px] font-semibold">{t("leftovers.purgeTitle")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">
          {purging && purging.length === 1
            ? t("leftovers.purgeText", { name: purging[0].name })
            : t("leftovers.purgeManyText", { count: purging?.length ?? 0, size: fmt.bytes(purgeBytes) })}
        </p>
        {purging && purging.length > 1 && (
          <ul className="mt-3 max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-line bg-bg/50 px-3 py-2 text-[12px]">
            {purging.map((h) => (
              <li key={h.id} className="truncate">
                {h.name}
              </li>
            ))}
          </ul>
        )}
        {purgeAdmin && <p className="mt-2 text-[12px] text-warn">{t("leftovers.purgeAdminNote")}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setPurging(null)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="danger"
            data-testid="held-purge-confirm"
            onClick={() => {
              if (purging) run(purging.map((h) => h.id), false);
              setPurging(null);
            }}
          >
            {purging && purging.length > 1 ? t("leftovers.purgeManyButton", { count: purging.length }) : t("leftovers.purgeNow")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function Leftovers() {
  const { t } = useTranslation();
  const { phase, report, tab, held } = useLeftovers();

  useEffect(() => {
    loadHeld();
  }, []);

  return (
    <div className="flex min-h-full flex-col gap-4">
      <div className="flex gap-1 rounded-lg border border-line p-0.5 text-[13px]" role="tablist">
        {(["found", "quarantine"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => useLeftovers.setState({ tab: id })}
            data-testid={`leftovers-tab-${id}`}
            className={`relative h-8 flex-1 rounded-md transition-colors duration-150 ${tab === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            {tab === id && (
              <motion.span layoutId="leftovers-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
            )}
            <span className="relative">
              {t(`leftovers.tab.${id}`)}
              {id === "quarantine" && held.length > 0 && <span className="num ml-1.5 text-muted">{held.length}</span>}
            </span>
          </button>
        ))}
      </div>

      <Notice />

      {tab === "quarantine" ? (
        <Quarantine />
      ) : phase === "scanning" || phase === "holding" ? (
        <Scanning holding={phase === "holding"} />
      ) : phase === "report" && report ? (
        <Report report={report} />
      ) : (
        <Intro />
      )}
    </div>
  );
}
