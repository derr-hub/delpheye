import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  Bug,
  ChevronDown,
  Download,
  FileClock,
  Folder,
  FolderOpen,
  Globe,
  Image,
  Info,
  Layers,
  MemoryStick,
  RefreshCw,
  ScrollText,
  Share2,
  ShieldAlert,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { AnimatedBytes, Button, Checkbox, Modal } from "../../components/ui";
import { relaunchElevated } from "../../lib/app";
import {
  GROUPS,
  clean,
  isSelectable,
  isVisible,
  scan,
  selectedBytes,
  targetKey,
  toggleCategory,
  toggleTarget,
  useCleanup,
  type CategoryReport,
  type Risk,
  type ScanReport,
  type TargetReport,
} from "../../lib/cleanup";
import { shortenPath, useFmt } from "../../lib/format";

const ICONS: Record<string, LucideIcon> = {
  user_temp: FileClock,
  windows_temp: FileClock,
  inet_cache: Globe,
  thumbnails: Image,
  shader_cache: Layers,
  error_reports: Bug,
  memory_dumps: MemoryStick,
  windows_update: Download,
  delivery_optimization: Share2,
  windows_logs: ScrollText,
  recycle_bin: Trash2,
  app_cache: AppWindow,
  dev_cache: SquareTerminal,
};

const isBrowser = (id: string) => id.startsWith("browser_");
const iconFor = (id: string) => ICONS[id] ?? (isBrowser(id) ? Globe : Folder);

/** Display names: product names come from the backend, everything else is translated. */
export function useCleanupNames() {
  const { t } = useTranslation();
  return {
    category: (c: { id: string; title: string | null }) => c.title ?? t(`cleanup.cat.${c.id}.name`),
    description: (c: { id: string }) => (isBrowser(c.id) ? t("cleanup.browserDesc") : t(`cleanup.cat.${c.id}.desc`)),
    target: (tg: { label: string; labelKey: string | null }) =>
      tg.labelKey ? t(`cleanup.target.${tg.labelKey}`) : tg.label,
  };
}

const reveal = (path: string) => revealItemInDir(path).catch((e) => console.error("reveal failed", e));

function RiskBadge({ risk }: { risk: Risk }) {
  const { t } = useTranslation();
  const tone = risk === "safe" ? "bg-safe/10 text-safe" : "bg-warn/10 text-warn";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] ${tone}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {t(`cleanup.risk.${risk}`)}
    </span>
  );
}

function Note({ tone = "muted", icon: Icon, children }: { tone?: "muted" | "warn"; icon: LucideIcon; children: string }) {
  return (
    <p className={`flex items-start gap-2 text-[12px] leading-relaxed ${tone === "warn" ? "text-warn" : "text-muted"}`}>
      <Icon size={14} className="mt-[3px] shrink-0" />
      {children}
    </p>
  );
}

function AdminBanner() {
  const { t } = useTranslation();
  const [declined, setDeclined] = useState(false);
  return (
    <div className="flex items-center gap-4 rounded-card border border-warn/25 bg-warn/[0.06] px-5 py-3.5">
      <ShieldAlert size={20} className="shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{t("cleanup.adminTitle")}</div>
        <div className="text-[12px] text-muted">{declined ? t("cleanup.adminDeclined") : t("cleanup.adminText")}</div>
      </div>
      <Button data-testid="relaunch-admin" onClick={async () => setDeclined(!(await relaunchElevated()))}>
        {t("cleanup.adminAction")}
      </Button>
    </div>
  );
}

function TargetRow({ report, category, target, solo }: { report: ScanReport; category: CategoryReport; target: TargetReport; solo: boolean }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const names = useCleanupNames();
  const checked = useCleanup((s) => s.selected.has(targetKey(category.id, target.id)));
  const locked = target.needsAdmin && !report.elevated;

  return (
    <li className="flex items-start gap-3 py-1.5" data-testid={`target-${category.id}-${target.id}`}>
      {/* A category with one target is ticked from its own row. */}
      {!solo && (
        <span className="mt-0.5">
          <Checkbox
            state={checked}
            disabled={!isSelectable(report, target)}
            onChange={() => toggleTarget(category.id, target.id)}
            label={names.target(target)}
          />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="truncate">{names.target(target)}</span>
          {locked && (
            <span className="shrink-0 text-warn" title={t("cleanup.needsAdmin")}>
              <ShieldAlert size={13} />
            </span>
          )}
        </div>
        {target.paths.map((path) => (
          <div key={path} className="num truncate text-[11px] text-muted/80" title={path}>
            {shortenPath(path, 84)}
          </div>
        ))}
        {target.blocked && <div className="text-[11px] text-warn">{t("cleanup.partial")}</div>}
      </div>
      <span className="num shrink-0 pt-px text-[12px] text-muted">{fmt.bytes(target.bytes)}</span>
      {target.paths.length > 0 && (
        <button
          className="shrink-0 rounded p-1 text-muted transition-colors duration-150 hover:bg-raised hover:text-fg"
          title={t("cleanup.reveal")}
          aria-label={t("cleanup.reveal")}
          onClick={() => reveal(target.paths[0])}
        >
          <FolderOpen size={14} />
        </button>
      )}
    </li>
  );
}

const TARGETS_SHOWN = 6;

function Details({ report, category }: { report: ScanReport; category: CategoryReport }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const names = useCleanupNames();
  const [all, setAll] = useState(false);

  const targets = [...category.targets].sort((a, b) => b.bytes - a.bytes);
  const shown = all ? targets : targets.slice(0, TARGETS_SHOWN);
  const largest = category.targets
    .flatMap((tg) => tg.largest)
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5);
  const age = category.minAgeHours;

  return (
    <div className="space-y-3 border-t border-line/60 bg-bg/40 py-4 pl-[88px] pr-5">
      <p className="max-w-[78ch] text-[12px] leading-relaxed text-muted">{names.description(category)}</p>
      {age !== null && (
        <Note icon={Info}>
          {age % 24 === 0 && age > 24 ? t("cleanup.olderDays", { value: age / 24 }) : t("cleanup.olderHours", { value: age })}
        </Note>
      )}
      {category.running && (
        <Note tone="warn" icon={TriangleAlert}>
          {t("cleanup.running", { name: category.running })}
        </Note>
      )}
      {!report.elevated && category.targets.some((tg) => tg.needsAdmin) && (
        <Note tone="warn" icon={ShieldAlert}>
          {t("cleanup.needsAdmin")}
        </Note>
      )}

      <ul>
        {shown.map((tg) => (
          <TargetRow key={tg.id} report={report} category={category} target={tg} solo={targets.length === 1} />
        ))}
      </ul>
      {targets.length > TARGETS_SHOWN && (
        <button className="text-[12px] text-accent hover:underline" onClick={() => setAll(!all)}>
          {all ? t("cleanup.showLess") : t("cleanup.showAll", { value: targets.length })}
        </button>
      )}

      {largest.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-muted/70">{t("cleanup.largest")}</div>
          <ul>
            {largest.map((file) => (
              <li key={file.path}>
                <button
                  className="group flex w-full items-center gap-3 rounded py-1 text-left"
                  title={`${file.path}\n${t("cleanup.reveal")}`}
                  onClick={() => reveal(file.path)}
                >
                  <span className="num min-w-0 flex-1 truncate text-[11px] text-muted transition-colors duration-150 group-hover:text-fg">
                    {shortenPath(file.path, 96)}
                  </span>
                  <span className="num shrink-0 text-[11px] text-muted">{fmt.bytes(file.bytes)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function CategoryRow({ report, category }: { report: ScanReport; category: CategoryReport }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const names = useCleanupNames();
  const selected = useCleanup((s) => s.selected);
  const [open, setOpen] = useState(false);

  const selectable = category.targets.filter((tg) => isSelectable(report, tg));
  const picked = selectable.filter((tg) => selected.has(targetKey(category.id, tg.id))).length;
  const state = picked === 0 ? false : picked === selectable.length ? true : "mixed";
  const needsAdmin = !report.elevated && category.targets.some((tg) => tg.needsAdmin);
  const Icon = iconFor(category.id);
  const name = names.category(category);

  return (
    <div className="border-b border-line last:border-b-0" data-testid={`cat-${category.id}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}
        className="flex cursor-pointer items-center gap-3.5 px-5 py-3.5 transition-colors duration-150 hover:bg-raised/40"
      >
        <Checkbox state={state} disabled={selectable.length === 0} onChange={() => toggleCategory(report, category)} label={name} />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
          <Icon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{name}</span>
            <RiskBadge risk={category.risk} />
            {needsAdmin && (
              <span className="shrink-0 text-warn" title={t("cleanup.needsAdmin")}>
                <ShieldAlert size={14} />
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-muted">{names.description(category)}</div>
        </div>
        <div className="shrink-0 text-right">
          <div className="num text-[14px]">{category.bytes > 0 ? fmt.bytes(category.bytes) : "—"}</div>
          <div className="num text-[11px] text-muted">{t("cleanup.filesCount", { value: fmt.int(category.files) })}</div>
        </div>
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
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <Details report={report} category={category} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ConfirmDialog({ report, open, onClose }: { report: ScanReport; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const names = useCleanupNames();
  const selected = useCleanup((s) => s.selected);

  const rows = report.categories
    .map((c) => ({
      category: c,
      bytes: c.targets.filter((tg) => selected.has(targetKey(c.id, tg.id))).reduce((sum, tg) => sum + tg.bytes, 0),
    }))
    .filter((row) => row.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes);
  const size = fmt.bytes(rows.reduce((sum, row) => sum + row.bytes, 0));

  return (
    <Modal open={open} onClose={onClose}>
      <h2 className="font-display text-[18px] font-semibold">{t("cleanup.confirmTitle")}</h2>
      <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("cleanup.confirmText", { size })}</p>
      <ul className="mt-4 max-h-[220px] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-bg/50 px-3.5 py-2.5 text-[13px]">
        {rows.map(({ category, bytes }) => (
          <li key={category.id} className="flex items-center gap-3">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${category.risk === "safe" ? "bg-safe" : "bg-warn"}`} />
            <span className="min-w-0 flex-1 truncate">{names.category(category)}</span>
            <span className="num shrink-0 text-muted">{fmt.bytes(bytes)}</span>
          </li>
        ))}
      </ul>
      {rows.some((row) => row.category.risk === "caution") && (
        <div className="mt-3">
          <Note tone="warn" icon={TriangleAlert}>
            {t("cleanup.confirmCaution")}
          </Note>
        </div>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button autoFocus onClick={onClose} data-testid="confirm-cancel">
          {t("cleanup.cancel")}
        </Button>
        <Button
          variant="danger"
          data-testid="confirm-delete"
          onClick={() => {
            onClose();
            clean();
          }}
        >
          {t("cleanup.confirmOk", { size })}
        </Button>
      </div>
    </Modal>
  );
}

export function Report({ report }: { report: ScanReport }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const selected = useCleanup((s) => s.selected);
  const [confirming, setConfirming] = useState(false);

  const visible = report.categories.filter(isVisible);
  const cleanCount = report.categories.length - visible.length;
  const totalBytes = visible.reduce((sum, c) => sum + c.bytes, 0);
  const totalFiles = visible.reduce((sum, c) => sum + c.files, 0);
  const chosen = selectedBytes(report, selected);
  const adminWouldHelp = !report.elevated && report.categories.some((c) => c.targets.some((tg) => tg.needsAdmin));

  return (
    <div className="flex flex-col gap-4 pb-2">
      {/* Stays in view while the list scrolls, so the action is always at hand. */}
      <div className="sticky -top-6 z-10 -mx-7 -mt-5 bg-bg/90 px-7 pb-2 pt-5 shadow-[0_-8px_0_0_var(--color-bg)] backdrop-blur-md">
        <div className="flex items-center gap-6 rounded-card border border-line bg-surface px-5 py-4">
          <div className="min-w-0">
            <div className="font-display text-[30px] font-semibold leading-none" data-testid="total-bytes">
              {totalBytes > 0 ? <AnimatedBytes value={totalBytes} /> : t("cleanup.allClean")}
            </div>
            <div className="mt-1.5 truncate text-[12px] text-muted">
              {totalBytes > 0 && `${t("cleanup.reclaimable")} · ${t("cleanup.filesCount", { value: fmt.int(totalFiles) })} · `}
              {t("cleanup.scanTook", { value: fmt.duration(report.durationMs) })}
            </div>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button icon={<RefreshCw size={15} />} onClick={scan} data-testid="rescan">
              {t("cleanup.rescan")}
            </Button>
            <Button
              variant="primary"
              icon={<Trash2 size={15} />}
              disabled={chosen === 0}
              onClick={() => setConfirming(true)}
              data-testid="delete-selected"
            >
              {chosen > 0 ? `${t("cleanup.deleteSelected")} · ${fmt.bytes(chosen)}` : t("cleanup.nothingSelected")}
            </Button>
          </div>
        </div>
      </div>

      {adminWouldHelp && <AdminBanner />}

      {GROUPS.map((group) => {
        const categories = visible.filter((c) => c.group === group).sort((a, b) => b.bytes - a.bytes);
        if (categories.length === 0) return null;
        return (
          <section key={group}>
            <h2 className="mb-2 flex items-baseline justify-between px-1 text-[11px] uppercase tracking-wider text-muted">
              {t(`cleanup.group.${group}`)}
              <span className="num normal-case tracking-normal">{fmt.bytes(categories.reduce((sum, c) => sum + c.bytes, 0))}</span>
            </h2>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {categories.map((c) => (
                <CategoryRow key={c.id} report={report} category={c} />
              ))}
            </div>
          </section>
        );
      })}

      {cleanCount > 0 && (
        <p className="py-1 text-center text-[12px] text-muted">{t("cleanup.cleanCategories", { value: cleanCount })}</p>
      )}

      <ConfirmDialog report={report} open={confirming} onClose={() => setConfirming(false)} />
    </div>
  );
}
