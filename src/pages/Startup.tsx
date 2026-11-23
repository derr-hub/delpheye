import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  Ban,
  ChevronDown,
  Clock,
  Cloud,
  Cpu,
  Download,
  FolderOpen,
  Gamepad2,
  Globe,
  Lock,
  MessageCircle,
  Music,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Undo2,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button, Modal, Switch } from "../components/ui";
import { relaunchElevated } from "../lib/app";
import { shortenPath, useFmt } from "../lib/format";
import {
  disableRecommended,
  load,
  recommended,
  removeBroken,
  revert,
  setState,
  isListed,
  tabOf,
  useStartup,
  type Advice,
  type Category,
  type Entry,
  type Filter,
  type Impact,
  type StartType,
  type Tab,
} from "../lib/startup";

const CATEGORY_ICON: Record<Category, LucideIcon> = {
  windows: AppWindow,
  security: ShieldCheck,
  hardware: Cpu,
  launcher: Gamepad2,
  updater: Download,
  messenger: MessageCircle,
  cloud: Cloud,
  browser: Globe,
  media: Music,
  other: Wrench,
};
const ADVICE_TONE: Record<Advice, string> = {
  keep: "bg-safe/10 text-safe",
  optional: "bg-raised text-muted",
  disable: "bg-accent/10 text-accent",
  review: "bg-warn/10 text-warn",
  broken: "bg-risk/10 text-risk",
};
const IMPACT_LEVEL: Record<Impact, number> = { none: 0, low: 1, medium: 2, high: 3 };
const START_TYPES: StartType[] = ["auto", "delayed", "manual", "disabled"];
const TABS: Tab[] = ["apps", "tasks", "services"];
const FILTERS: Filter[] = ["all", "disable", "review", "changed"];

const reveal = (path: string) => revealItemInDir(path).catch((e) => console.error("reveal failed", e));

function AdviceBadge({ advice }: { advice: Advice }) {
  const { t } = useTranslation();
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] ${ADVICE_TONE[advice]}`}>{t(`startup.advice.${advice}`)}</span>;
}

/** Three short bars, filled up to the impact level, with the level spelled out beside them. */
function ImpactMeter({ impact }: { impact: Impact }) {
  const { t } = useTranslation();
  const level = IMPACT_LEVEL[impact];
  const color = level === 3 ? "bg-risk" : level === 2 ? "bg-warn" : "bg-accent";
  return (
    <span className="flex w-[104px] shrink-0 items-center gap-2" title={t("startup.impactHint")}>
      <span className="flex items-end gap-[3px]" aria-hidden>
        {[1, 2, 3].map((bar) => (
          <span key={bar} className={`w-[5px] rounded-sm ${bar <= level ? color : "bg-raised"}`} style={{ height: 5 + bar * 3 }} />
        ))}
      </span>
      <span className="text-[11px] text-muted">{t(`startup.impact.${impact}`)}</span>
    </span>
  );
}

function Control({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  const busy = useStartup((s) => s.busy.has(entry.id));
  const elevated = useStartup((s) => s.report?.elevated ?? false);
  if (!entry.editable) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11px] text-muted" title={t("startup.why.windows")} data-testid="startup-locked">
        <Lock size={11} />
        {t("startup.lockedShort")}
      </span>
    );
  }
  const locked = busy || (entry.needsAdmin && !elevated);
  if (entry.needsAdmin && !elevated && !busy) {
    return (
      <span className="flex shrink-0 items-center gap-1 rounded-full border border-warn/30 bg-warn/[0.06] px-2 py-0.5 text-[11px] text-warn" title={t("startup.why.admin")} data-testid="startup-admin">
        <ShieldAlert size={11} />
        {t("startup.adminShort")}
      </span>
    );
  }
  if (entry.kind === "service" && entry.start) {
    return (
      <select
        value={entry.start}
        disabled={locked}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => setState(entry.id, e.target.value)}
        title={entry.needsAdmin && !elevated ? t("cleanup.needsAdmin") : t("startup.startType")}
        className="h-8 w-[132px] shrink-0 rounded-lg border border-line bg-surface px-2 text-[12px] text-fg outline-none focus:border-accent disabled:opacity-40"
        data-testid="start-type"
      >
        {START_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(`startup.start.${type}`)}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Switch
      on={entry.enabled}
      disabled={locked}
      onChange={() => setState(entry.id, entry.enabled ? "off" : "on")}
      label={entry.needsAdmin && !elevated ? t("cleanup.needsAdmin") : t(entry.enabled ? "startup.turnOff" : "startup.turnOn")}
    />
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** Why this entry cannot be switched from here, and what would make it possible. */
function WhyLocked({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  const elevated = useStartup((s) => s.report?.elevated ?? false);
  const [declined, setDeclined] = useState(false);
  const why = !entry.editable ? "windows" : entry.needsAdmin && !elevated ? "admin" : !entry.exists && !entry.removable ? "missing" : null;
  if (!why) return null;
  return (
    <div className={`flex max-w-[90ch] items-start gap-3 rounded-lg border px-3 py-2.5 leading-relaxed ${why === "admin" ? "border-warn/30 bg-warn/[0.06]" : "border-line bg-raised/40"}`} data-testid="startup-why">
      {why === "admin" ? <ShieldAlert size={15} className="mt-0.5 shrink-0 text-warn" /> : <Lock size={15} className="mt-0.5 shrink-0 text-muted" />}
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t(`startup.whyTitle.${why}`)}</div>
        <div className="text-muted">{declined ? t("cleanup.adminDeclined") : t(`startup.why.${why}`)}</div>
      </div>
      {why === "admin" && (
        <Button className="shrink-0" onClick={async () => setDeclined(!(await relaunchElevated()))}>
          {t("cleanup.adminAction")}
        </Button>
      )}
    </div>
  );
}

function Details({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const fp = entry.footprint;
  return (
    <div className="space-y-3 border-t border-line/60 bg-bg/40 py-4 pl-[76px] pr-5 text-[12px]">
      <WhyLocked entry={entry} />
      {entry.description && entry.description.toLowerCase() !== entry.name.toLowerCase() && (
        <p className="max-w-[80ch] leading-relaxed text-muted">{entry.description}</p>
      )}
      <ul className="space-y-1">
        {entry.reasons.map((reason) => (
          <li key={reason} className="flex gap-2 leading-relaxed">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted" />
            {t(`startup.reason.${reason}`)}
          </li>
        ))}
      </ul>
      <dl className="grid grid-cols-[150px_1fr] gap-x-4 gap-y-1.5">
        <Fact label={t("startup.command")}>
          <span className="num select-text text-[11px]">{entry.command || "—"}</span>
        </Fact>
        {entry.program && (
          <Fact label={t("startup.program")}>
            <button className="num inline-flex items-center gap-1.5 text-left text-[11px] hover:text-accent" onClick={() => reveal(entry.program!)} title={t("disk.reveal")}>
              {shortenPath(entry.program, 90)}
              <FolderOpen size={12} className="shrink-0" />
            </button>
          </Fact>
        )}
        <Fact label={t("startup.where")}>
          <span className="num text-[11px]">{entry.location}</span>
        </Fact>
        <Fact label={t("startup.scope")}>{t(entry.machine ? "startup.allUsers" : "startup.thisUser")}</Fact>
        <Fact label={t("startup.now")}>
          {fp.processes > 0
            ? t("startup.footprint", { processes: fp.processes, memory: fmt.bytes(fp.memory), cpu: fmt.int(fp.cpuSeconds), read: fmt.bytes(fp.readBytes) })
            : t("startup.notRunning")}
        </Fact>
        {entry.bootDelayMs !== null && <Fact label={t("startup.bootDelay")}>{t("startup.bootDelayValue", { value: fmt.duration(entry.bootDelayMs) })}</Fact>}
      </dl>
      <div className="flex flex-wrap gap-2">
        {entry.changed && (
          <Button icon={<Undo2 size={14} />} onClick={() => revert([entry.id])} data-testid="revert-one">
            {t("startup.revertOne", { state: t(`startup.state.${entry.changed.original}`) })}
          </Button>
        )}
        {entry.removable && (
          <Button variant="quiet" icon={<Trash2 size={14} />} onClick={() => removeBroken(entry.id)}>
            {t("startup.removeBroken")}
          </Button>
        )}
      </div>
    </div>
  );
}

function Row({ entry }: { entry: Entry }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [open, setOpen] = useState(false);
  const error = useStartup((s) => (s.error?.id === entry.id ? s.error.code : null));
  const Icon = CATEGORY_ICON[entry.category];

  return (
    <div className="border-b border-line last:border-b-0" data-testid={`startup-${entry.name}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}
        className={`flex cursor-pointer items-center gap-3.5 px-5 py-3 transition-colors duration-150 hover:bg-raised/40 ${entry.enabled ? "" : "opacity-60"}`}
      >
        <Control entry={entry} />
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
          <Icon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium">{entry.name}</span>
            <AdviceBadge advice={entry.advice} />
            {entry.changed && (
              <span className="shrink-0 text-[11px] text-accent" title={t("startup.changedHint")}>
                {t("startup.changedTag")}
              </span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 truncate text-[12px] text-muted">
            {entry.signed === true && <ShieldCheck size={12} className="shrink-0 text-safe" aria-label={t("startup.signed")} />}
            {entry.signed === false && <ShieldAlert size={12} className="shrink-0 text-warn" aria-label={t("startup.unsigned")} />}
            <span className="truncate">{entry.publisher ?? t("startup.unknownPublisher")}</span>
            {entry.running && <span className="shrink-0">· {t("startup.running")}</span>}
          </div>
          {error && (
            <div className="mt-1 text-[11px] text-risk" role="alert">
              {t(`startup.error.${error}`, { defaultValue: t("startup.error.other") })}
            </div>
          )}
        </div>
        <ImpactMeter impact={entry.impact} />
        <span className="num w-20 shrink-0 text-right text-[12px] text-muted">{entry.footprint.memory > 0 ? fmt.bytes(entry.footprint.memory) : "—"}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="shrink-0 text-muted">
          <ChevronDown size={16} />
        </motion.span>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: "easeOut" }} className="overflow-hidden">
            <Details entry={entry} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Summary() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const report = useStartup((s) => s.report)!;
  const [confirming, setConfirming] = useState(false);
  const [declined, setDeclined] = useState(false);

  const thirdParty = report.entries.filter((e) => !e.windows && isListed(e, false));
  const starting = thirdParty.filter((e) => e.enabled);
  const memory = starting.reduce((sum, e) => sum + e.footprint.memory, 0);
  const suggested = recommended(report);
  const changed = report.entries.filter((e) => e.changed).length + report.removed.length;
  const last = report.boots[0];
  const average = report.boots.length ? report.boots.reduce((sum, b) => sum + b.totalMs, 0) / report.boots.length : 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-6 rounded-card border border-line bg-surface px-5 py-4">
        <div className="min-w-0 flex-1">
          {last ? (
            <>
              <div className="flex items-baseline gap-2">
                <Clock size={18} className="self-center text-accent" />
                <span className="font-display text-[30px] font-semibold leading-none" data-testid="boot-time">
                  {fmt.duration(last.totalMs)}
                </span>
                <span className="text-[13px] text-muted">{t("startup.lastBoot")}</span>
              </div>
              <div className="mt-1.5 text-[12px] text-muted">
                {t("startup.bootSplit", { main: fmt.duration(last.mainMs), post: fmt.duration(last.postMs) })}
                {report.boots.length > 1 && ` · ${t("startup.bootAverage", { count: report.boots.length, value: fmt.duration(average) })}`}
              </div>
            </>
          ) : (
            <>
              <div className="font-display text-[24px] font-semibold leading-tight" data-testid="startup-count">
                {t("startup.startingCount", { count: starting.length })}
              </div>
              <div className="mt-1.5 text-[12px] text-muted">{t("startup.memoryNow", { value: fmt.bytes(memory) })}</div>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button icon={<RefreshCw size={15} />} onClick={load}>
            {t("startup.refresh")}
          </Button>
          {changed > 0 && (
            <Button icon={<Undo2 size={15} />} onClick={() => revert([])} data-testid="revert-all">
              {t("startup.revertAll", { count: changed })}
            </Button>
          )}
          <Button variant="primary" icon={<Zap size={15} />} disabled={suggested.length === 0} onClick={() => setConfirming(true)} data-testid="disable-recommended">
            {t("startup.disableRecommended", { count: suggested.length })}
          </Button>
        </div>
      </div>

      {last && (
        <p className="px-1 text-[12px] text-muted">
          {t("startup.startingCount", { count: starting.length })} · {t("startup.memoryNow", { value: fmt.bytes(memory) })}
        </p>
      )}

      {!report.elevated && (
        <div className="flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-3">
          <ShieldAlert size={18} className="shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">{declined ? t("cleanup.adminDeclined") : t("startup.adminHint")}</p>
          <Button onClick={async () => setDeclined(!(await relaunchElevated()))}>{t("cleanup.adminAction")}</Button>
        </div>
      )}

      <Modal open={confirming} onClose={() => setConfirming(false)}>
        <h2 className="font-display text-[18px] font-semibold">{t("startup.confirmTitle")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("startup.confirmText")}</p>
        <ul className="mt-4 max-h-[240px] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-bg/50 px-3.5 py-2.5 text-[13px]">
          {suggested.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              <span className="shrink-0 text-[11px] text-muted">{t(`startup.category.${entry.category}`)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirming(false)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="disable-recommended-confirm"
            onClick={() => {
              setConfirming(false);
              disableRecommended(suggested);
            }}
          >
            {t("startup.turnOffAll", { count: suggested.length })}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function Startup() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { report, loading, tab, filter, query, showWindows, error } = useStartup();

  useEffect(() => {
    if (!useStartup.getState().report) load();
  }, []);

  const visible = useMemo(() => {
    if (!report) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return report.entries.filter((e) => {
      if (tabOf(e) !== tab || !isListed(e, showWindows)) return false;
      if (filter === "disable" && !(e.advice === "disable" && e.enabled)) return false;
      if (filter === "review" && !(e.advice === "review" || e.advice === "broken")) return false;
      if (filter === "changed" && !e.changed) return false;
      const text = `${e.name} ${e.publisher ?? ""} ${e.command}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [report, tab, filter, query, showWindows]);

  if (!report) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <motion.div className="h-14 w-14 rounded-full border-[5px] border-raised border-t-accent" animate={{ rotate: 360 }} transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }} />
        <p className="mt-5 text-[13px] text-muted">{loading ? t("startup.loading") : t("startup.error.other")}</p>
        {error && !loading && (
          <Button className="mt-4" onClick={load}>
            {t("startup.refresh")}
          </Button>
        )}
      </div>
    );
  }

  const count = (id: Tab) => report.entries.filter((e) => tabOf(e) === id && isListed(e, showWindows)).length;

  return (
    <div className="flex flex-col gap-4 pb-2">
      <Summary />
      {error && error.id === null && (
        <p className="px-1 text-[12px] text-risk" role="alert">
          {error.code.startsWith("revert:") ? t("startup.revertFailed", { names: error.code.slice(7) }) : t(`startup.error.${error.code}`, { defaultValue: t("startup.error.other") })}
        </p>
      )}

      <div className="flex gap-1 rounded-lg border border-line p-0.5 text-[13px]" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => useStartup.setState({ tab: id })}
            data-testid={`startup-tab-${id}`}
            className={`relative h-8 flex-1 rounded-md transition-colors duration-150 ${tab === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            {tab === id && <motion.span layoutId="startup-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
            <span className="relative">
              {t(`startup.tab.${id}`)} <span className="num text-muted">{count(id)}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-line p-0.5 text-[12px]">
          {FILTERS.map((id) => (
            <button
              key={id}
              onClick={() => useStartup.setState({ filter: id })}
              className={`h-7 rounded-md px-2.5 transition-colors duration-150 ${filter === id ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
            >
              {t(`startup.filter.${id}`)}
            </button>
          ))}
        </div>
        <label className="flex h-8 min-w-[200px] flex-1 items-center gap-2 rounded-lg border border-line px-3 focus-within:border-accent">
          <Search size={14} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => useStartup.setState({ query: e.target.value })}
            placeholder={t("startup.search")}
            className="min-w-0 flex-1 select-text bg-transparent text-[13px] outline-none placeholder:text-muted/60"
          />
        </label>
        {tab !== "apps" && (
          <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted">
            <Switch on={showWindows} onChange={() => useStartup.setState({ showWindows: !showWindows })} label={t("startup.showWindows")} />
            {t("startup.showWindows")}
          </label>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="flex flex-col items-center py-12 text-center text-[13px] text-muted">
          <Ban size={22} className="mb-3" />
          {t("startup.nothingHere")}
        </div>
      ) : (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {visible.map((entry) => (
            <Row key={entry.id} entry={entry} />
          ))}
        </div>
      )}
      {tab === "apps" && report.removed.length > 0 && (
        <section data-testid="removed-list">
          <h2 className="mb-2 px-1 text-[11px] uppercase tracking-wider text-muted">{t("startup.removedTitle")}</h2>
          <ul className="overflow-hidden rounded-card border border-line bg-surface">
            {report.removed.map((item) => (
              <li key={item.id} className="flex items-center gap-3 border-b border-line px-5 py-2.5 text-[13px] last:border-b-0">
                <Trash2 size={15} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <span className="num shrink-0 text-[11px] text-muted">{fmt.dateTime(item.at)}</span>
                <Button icon={<Undo2 size={14} />} onClick={() => revert([item.id])} data-testid="restore-removed">
                  {t("leftovers.restore")}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p className="px-1 text-[11px] text-muted/80">{t("startup.footnote")}</p>
    </div>
  );
}
