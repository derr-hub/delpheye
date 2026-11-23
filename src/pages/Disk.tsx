import { lazy, Suspense } from "react";
import { useMetrics } from "../lib/metrics";
import { ZONE_COLOURS, zoneOf } from "./disk/DiskBuild3D";
const DiskBuild3D = lazy(() => import("./disk/DiskBuild3D"));
const FileCity = lazy(() => import("./disk/FileCity"));
import { Hero } from "../components/Hero";
import { Clock3, FileStack } from "lucide-react";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ChevronRight,
  Copy,
  File,
  Folder as FolderIcon,
  FolderOpen,
  HardDrive,
  Info,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { AnimatedBytes, Bar, Button, Checkbox, Modal } from "../components/ui";
import { relaunchElevated } from "../lib/app";
import {
  DUPES_SIZES,
  SEARCH_LIMIT,
  cancelWork,
  clearPicked,
  findDuplicates,
  isLastCopy,
  openFolder,
  pickSpareCopies,
  search,
  showTab,
  openDrive,
  startIndex,
  togglePick,
  trashPicked,
  useDisk,
  type DupeGroup,
  type Folder,
  type Item,
  type Tab,
} from "../lib/disk";
import { shortenPath, useFmt } from "../lib/format";
import { TimeRings, ageColor } from "./disk/TimeRings";

const reveal = (path: string) => revealItemInDir(path).catch((e) => console.error("reveal failed", e));
/** A folder opens in the map; a file is shown in Explorer. */
const activate = (item: Item) => (item.isDir ? (showTab("map"), openFolder(item.id)) : reveal(item.path));

const TABS: Tab[] = ["map", "largest", "search", "dupes"];
const KNOWN_ERRORS = ["busy", "bad-drive", "no-index"];

function ErrorLine({ error }: { error: string | null }) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <p className="text-[12px] text-risk" role="alert">
      {KNOWN_ERRORS.includes(error) ? t(`disk.error.${error}`) : t("disk.error.other", { message: error })}
    </p>
  );
}

function Intro() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { drives, drive, error } = useDisk();
  return (
    <Hero
      icon={HardDrive}
      title={t("disk.introTitle")}
      text={t("disk.introText")}
      features={[
        { icon: Clock3, title: t("hero.disk.f1"), text: t("hero.disk.f1t") },
        { icon: FileStack, title: t("hero.disk.f2"), text: t("hero.disk.f2t") },
        { icon: Copy, title: t("hero.disk.f3"), text: t("hero.disk.f3t") },
      ]}
      action={
        <Button variant="primary" className="!h-11 !px-8 text-[14px]" disabled={!drive} onClick={startIndex} data-testid="disk-index">
          {t("disk.index", { drive: drive?.replace(/\\$/, "") ?? "" })}
        </Button>
      }
      error={<ErrorLine error={error} />}
    >
      {drives.length > 1 && (
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {drives.map((d) => (
            <button
              key={d.mount}
              onClick={() => useDisk.setState({ drive: d.mount })}
              className={`rounded-lg border px-3 py-1.5 text-[12px] transition-colors duration-150 ${
                d.mount === drive ? "border-accent bg-accent/10 text-fg" : "border-line text-muted hover:text-fg"
              }`}
            >
              <span className="num font-medium">{d.mount.replace(/\\$/, "")}</span> · {fmt.bytes(d.total - d.available)} / {fmt.bytes(d.total)}
            </button>
          ))}
        </div>
      )}
    </Hero>
  );
}

function Indexing() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const progress = useDisk((s) => s.progress);
  const { drives, drive } = useDisk();
  const disks = useMetrics((s) => s.current?.disks ?? []);
  const d = drives.find((x) => x.mount === drive);
  const used = d ? Math.max(1, d.total - d.available) : 1;
  const media = disks.find((x) => x.mount === drive)?.kind?.toLowerCase().includes("hdd") ? "hdd" : "ssd";
  const fill = Math.min(0.98, (progress?.bytes ?? 0) / used);
  const zone = zoneOf(progress?.path ?? "");
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 lg:flex-row lg:gap-10">
      <div className="relative h-[360px] w-full max-w-[560px]">
        <div className="pointer-events-none absolute inset-8 rounded-full bg-accent/10 blur-3xl" />
        <Suspense fallback={null}>
          <DiskBuild3D kind={media} fill={fill} zone={zone} />
        </Suspense>
      </div>
      <div className="w-full max-w-[360px] text-center lg:text-left">
        <div className="text-[12px] uppercase tracking-wider text-muted">{t(media === "hdd" ? "disk.build.hdd" : "disk.build.ssd")}</div>
        <div className="mt-1 font-display text-[22px] font-semibold">{t("disk.indexing")}</div>
        <div className="mt-2 flex items-baseline justify-center gap-2 lg:justify-start">
          <span className="num font-display text-[34px] font-semibold leading-none text-accent">{Math.round(fill * 100)}%</span>
          <span className="text-[12px] text-muted">{t("disk.build.ofUsed", { used: fmt.bytes(used) })}</span>
        </div>
        <div className="mt-2 text-[13px] text-muted">
          {t("disk.filesSoFar", { value: fmt.int(progress?.files ?? 0) })} · <AnimatedBytes value={progress?.bytes ?? 0} />
        </div>
        <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
          {ZONE_COLOURS.map((c, i) => (
            <li key={c} className={`flex items-center gap-2 transition-opacity ${zone === i ? "opacity-100" : "opacity-55"}`}>
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: c, boxShadow: zone === i ? `0 0 8px ${c}` : undefined }} />
              {t(`disk.build.zone.${i}`)}
            </li>
          ))}
        </ul>
        <div className="num mt-4 h-4 truncate text-[11px] text-muted/70" title={progress?.path}>
          {progress?.path ?? ""}
        </div>
        <Button variant="quiet" className="mt-4" onClick={cancelWork}>
          {t("cleanup.cancel")}
        </Button>
      </div>
    </div>
  );
}

function ItemRow({ item, share, showPath, lastCopy, aged }: { item: Item; share?: number; showPath?: boolean; lastCopy?: boolean; aged?: boolean }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const checked = useDisk((s) => s.picked.has(item.id));
  const Icon = item.isDir ? FolderIcon : File;
  return (
    <li
      className={`group flex items-center gap-3 border-b border-line/60 px-5 py-2 last:border-b-0 hover:bg-raised/40 ${checked ? "bg-accent/[0.06]" : ""}`}
      data-testid="disk-item"
    >
      <span title={lastCopy ? t("disk.keepOne") : undefined}>
        <Checkbox state={checked} disabled={lastCopy} onChange={() => togglePick(item)} label={item.name} />
      </span>
      <button className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => activate(item)} title={item.path}>
        {aged ? (
          <span className="h-3 w-3 shrink-0 rounded-[3px]" style={{ background: ageColor(item.mark) }} />
        ) : (
          <Icon size={15} className={`shrink-0 ${item.isDir ? "text-accent" : "text-muted"}`} />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px]">{item.name}</span>
          {showPath && <span className="num block truncate text-[11px] text-muted/80">{shortenPath(item.path, 100)}</span>}
        </span>
      </button>
      {share !== undefined && (
        <span className="hidden w-28 shrink-0 md:block">
          <span className="block h-1.5 overflow-hidden rounded-full bg-raised">
            <span className="block h-full rounded-full bg-accent/70" style={{ width: `${Math.max(share * 100, 0.5)}%` }} />
          </span>
        </span>
      )}
      <span className="num w-28 shrink-0 whitespace-nowrap text-right text-[11px] text-muted">
        {item.isDir ? t("disk.filesSoFar", { value: fmt.int(item.files) }) : item.modified > 0 ? fmt.date(item.modified) : ""}
      </span>
      <span className="num w-20 shrink-0 text-right text-[13px]">{fmt.bytes(item.size)}</span>
      <button
        className="shrink-0 rounded p-1 text-muted opacity-0 transition-opacity duration-150 hover:text-fg group-hover:opacity-100"
        title={t("disk.reveal")}
        aria-label={t("disk.reveal")}
        onClick={() => reveal(item.path)}
      >
        <FolderOpen size={14} />
      </button>
    </li>
  );
}

const CITY_KEY = "disk.view";
const loadView = (): "rings" | "city" => {
  try {
    return localStorage.getItem(CITY_KEY) === "city" ? "city" : "rings";
  } catch {
    return "rings";
  }
};

function MapTab({ folder }: { folder: Folder }) {
  const rings = useDisk((s) => s.rings);
  const [view, setViewState] = useState<"rings" | "city">(loadView);
  const setView = (v: "rings" | "city") => {
    setViewState(v);
    try {
      localStorage.setItem(CITY_KEY, v);
    } catch {
      /* this session only */
    }
  };
  const parent = folder.trail.length > 1 ? folder.trail[folder.trail.length - 2].id : null;
  const { t } = useTranslation();
  const fmt = useFmt();
  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-1 text-[13px]" aria-label="breadcrumb">
        {folder.trail.map((crumb, i) => {
          const last = i === folder.trail.length - 1;
          return (
            <span key={crumb.id} className="flex items-center gap-1">
              {i > 0 && <ChevronRight size={13} className="text-muted/60" />}
              <button
                disabled={last}
                onClick={() => openFolder(crumb.id)}
                className={`rounded px-1.5 py-0.5 ${last ? "font-medium text-fg" : "text-muted hover:bg-raised hover:text-fg"}`}
              >
                {crumb.name}
              </button>
            </span>
          );
        })}
        <span className="num ml-auto text-muted">{fmt.bytes(folder.item.size)}</span>
        <div className="flex rounded-lg border border-line p-0.5 text-[12px]">
          {(["rings", "city"] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 ${view === v ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`disk-view-${v}`}>
              {t(`disk.city.view.${v}`)}
            </button>
          ))}
        </div>
      </nav>
      {rings && rings.id === folder.item.id && view === "rings" && (
        <div className="rounded-card border border-line bg-surface p-5">
          <TimeRings root={rings} onOpen={openFolder} onUp={parent === null ? null : () => openFolder(parent)} />
        </div>
      )}
      {rings && rings.id === folder.item.id && view === "city" && (
        <Suspense fallback={<div className="skeleton h-[560px]" />}>
          <FileCity root={rings} base={folder.item.path.replace(/\\$/, "")} onOpen={openFolder} onUp={parent === null ? null : () => openFolder(parent)} />
        </Suspense>
      )}
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {folder.children.map((child) => (
          <ItemRow key={child.id} item={child} share={folder.item.size > 0 ? child.size / folder.item.size : 0} aged />
        ))}
        {folder.children.length === 0 && <li className="px-5 py-4 text-[13px] text-muted">{t("disk.emptyFolder")}</li>}
        {folder.moreCount > 0 && (
          <li className="flex justify-between px-5 py-2 text-[12px] text-muted">
            {t("disk.rest", { value: fmt.int(folder.moreCount) })}
            <span className="num">{fmt.bytes(folder.moreBytes)}</span>
          </li>
        )}
      </ul>
    </div>
  );
}

function SearchTab() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { query, found } = useDisk();
  const [text, setText] = useState(query);

  // Wait for a pause in typing rather than searching on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => text !== useDisk.getState().query && search(text), 120);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <div className="space-y-3">
      <label className="flex h-11 items-center gap-3 rounded-card border border-line bg-surface px-4 focus-within:border-accent">
        <Search size={16} className="shrink-0 text-muted" />
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("disk.searchPlaceholder")}
          className="min-w-0 flex-1 select-text bg-transparent text-[14px] outline-none placeholder:text-muted/60"
          data-testid="disk-search"
        />
      </label>
      {!found ? (
        <p className="px-1 text-[12px] text-muted">{t("disk.searchHint")}</p>
      ) : (
        <>
          <p className="px-1 text-[12px] text-muted" data-testid="disk-search-total">
            {found.total === 0 ? t("disk.noResults") : t("disk.searchTotal", { value: fmt.int(found.total) })}
            {found.total > SEARCH_LIMIT && ` · ${t("disk.searchShown", { value: SEARCH_LIMIT })}`}
          </p>
          {found.items.length > 0 && (
            <ul className="overflow-hidden rounded-card border border-line bg-surface">
              {found.items.map((item) => (
                <ItemRow key={item.id} item={item} showPath />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function DupeGroupCard({ group }: { group: DupeGroup }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const picked = useDisk((s) => s.picked);
  return (
    <section data-testid="dupe-group">
      <h3 className="mb-1.5 flex items-baseline justify-between px-1 text-[12px] text-muted">
        <span>
          {t("disk.dupesCopies", { n: group.items.length, size: fmt.bytes(group.size) })}
        </span>
        <span className="num">{t("disk.dupesSpare", { value: fmt.bytes(group.size * (group.items.length - 1)) })}</span>
      </h3>
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {group.items.map((item) => (
          <ItemRow key={item.id} item={item} showPath lastCopy={isLastCopy(group, item, picked)} />
        ))}
      </ul>
    </section>
  );
}

function DupesTab() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { dupes, dupesRunning, dupesProgress, dupesMinSize } = useDisk();

  if (dupesRunning) {
    const hashing = dupesProgress?.stage === "hashing";
    const percent = dupesProgress && dupesProgress.total > 0 ? (dupesProgress.done / dupesProgress.total) * 100 : 0;
    return (
      <div className="rounded-card border border-line bg-surface px-5 py-5" data-testid="dupes-running">
        <div className="mb-3 flex items-baseline justify-between text-[13px]">
          <span>{t(hashing ? "disk.dupesHashing" : "disk.dupesSampling")}</span>
          <span className="num text-[12px] text-muted">
            {dupesProgress &&
              (hashing
                ? `${fmt.bytes(dupesProgress.done)} / ${fmt.bytes(dupesProgress.total)}`
                : `${fmt.int(dupesProgress.done)} / ${fmt.int(dupesProgress.total)}`)}
          </span>
        </div>
        <Bar value={percent} color="var(--color-accent)" />
        <Button variant="quiet" className="mt-4" onClick={cancelWork}>
          {t("cleanup.cancel")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface px-5 py-4">
        <div className="min-w-0 flex-1">
          {dupes ? (
            <>
              <div className="text-[14px] font-medium" data-testid="dupes-summary">
                {dupes.totalGroups === 0
                  ? t("disk.dupesNone")
                  : t("disk.dupesFound", { groups: fmt.int(dupes.totalGroups), size: fmt.bytes(dupes.wastedBytes) })}
              </div>
              <div className="text-[12px] text-muted">
                {t("disk.dupesTook", { value: fmt.duration(dupes.durationMs) })}
                {dupes.totalGroups > dupes.groups.length && ` · ${t("disk.dupesShown", { value: fmt.int(dupes.groups.length) })}`}
              </div>
            </>
          ) : (
            <p className="max-w-[70ch] text-[12px] leading-relaxed text-muted">{t("disk.dupesIntro")}</p>
          )}
        </div>
        <div className="flex rounded-lg border border-line p-0.5 text-[12px]" role="radiogroup" aria-label={t("disk.dupesMinSize")}>
          {DUPES_SIZES.map((size) => (
            <button
              key={size}
              role="radio"
              aria-checked={dupesMinSize === size}
              onClick={() => useDisk.setState({ dupesMinSize: size })}
              className={`h-7 rounded-md px-2.5 transition-colors duration-150 ${dupesMinSize === size ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
            >
              ≥ {fmt.bytes(size)}
            </button>
          ))}
        </div>
        {dupes && dupes.groups.length > 0 && (
          <Button onClick={pickSpareCopies} data-testid="dupes-pick-spare">
            {t("disk.dupesPickSpare")}
          </Button>
        )}
        <Button variant="primary" icon={<Copy size={15} />} onClick={findDuplicates} data-testid="dupes-find">
          {t(dupes ? "disk.dupesAgain" : "disk.dupesFind")}
        </Button>
      </div>
      {dupes?.groups.map((group) => (
        <DupeGroupCard key={group.items[0].id} group={group} />
      ))}
    </div>
  );
}

/** Appears once something is ticked, and stays in view while the lists scroll. */
function SelectionBar() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { picked, trashing } = useDisk();
  const [confirming, setConfirming] = useState(false);
  const items = [...picked.values()];
  const bytes = items.reduce((sum, item) => sum + item.size, 0);

  return (
    <>
      <AnimatePresence>
        {items.length > 0 && (
          <motion.div
            initial={{ y: 24, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 24, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 32 }}
            className="sticky bottom-0 z-10 flex items-center gap-4 rounded-card border border-line bg-raised px-5 py-3 shadow-2xl"
            data-testid="selection-bar"
          >
            <span className="text-[13px]">
              {t("disk.pickedCount", { value: fmt.int(items.length) })} · <span className="num">{fmt.bytes(bytes)}</span>
            </span>
            <Button variant="quiet" className="ml-auto" onClick={clearPicked}>
              {t("disk.pickedClear")}
            </Button>
            <Button variant="danger" icon={<Trash2 size={15} />} disabled={trashing} onClick={() => setConfirming(true)} data-testid="trash-open">
              {t("disk.toBin")}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
      <Modal open={confirming} onClose={() => setConfirming(false)}>
        <h2 className="font-display text-[18px] font-semibold">{t("disk.binTitle")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("disk.binText", { size: fmt.bytes(bytes) })}</p>
        <ul className="mt-4 max-h-[220px] space-y-1.5 overflow-y-auto rounded-lg border border-line bg-bg/50 px-3.5 py-2.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-center gap-3 text-[12px]">
              <span className="num min-w-0 flex-1 truncate" title={item.path}>
                {shortenPath(item.path, 60)}
              </span>
              <span className="num shrink-0 text-muted">{fmt.bytes(item.size)}</span>
            </li>
          ))}
        </ul>
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirming(false)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="danger"
            data-testid="trash-confirm"
            onClick={() => {
              setConfirming(false);
              trashPicked();
            }}
          >
            {t("disk.toBin")}
          </Button>
        </div>
      </Modal>
    </>
  );
}

function TrashResult() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const report = useDisk((s) => s.lastTrash);
  if (!report) return null;
  return (
    <div
      className={`rounded-card border px-5 py-3 text-[12px] leading-relaxed ${report.failed.length ? "border-warn/25 bg-warn/[0.06]" : "border-safe/25 bg-safe/[0.06]"}`}
      data-testid="trash-result"
    >
      <div className="flex items-center gap-3">
        <span className="flex-1 text-[13px]">
          {t("disk.binDone", { count: fmt.int(report.trashed.length), size: fmt.bytes(report.freedBytes) })}
        </span>
        <button className="text-muted hover:text-fg" onClick={() => useDisk.setState({ lastTrash: null })}>
          {t("disk.dismiss")}
        </button>
      </div>
      {report.failed.map((failure) => (
        <div key={failure.path} className="mt-1 flex gap-2 text-muted">
          <span className="shrink-0 text-warn">{t(`disk.binFail.${failure.reason}`)}</span>
          <span className="num min-w-0 truncate" title={failure.path}>
            {shortenPath(failure.path, 90)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function Disk() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const { phase, summary, tab, folder, largest, error, drives } = useDisk();
  const [declined, setDeclined] = useState(false);

  if (phase === "indexing") return <Indexing />;
  if (phase !== "ready" || !summary) return <Intro />;
  const fast = summary.method === "mft";

  return (
    <div className="flex min-h-full flex-col gap-4 pb-2">
      <div className="flex items-center gap-6 rounded-card border border-line bg-surface px-5 py-4">
        <div className="min-w-0">
          <div className="font-display text-[30px] font-semibold leading-none" data-testid="disk-total">
            {fmt.bytes(summary.bytes)}
          </div>
          <div className="mt-1.5 truncate text-[12px] text-muted" data-testid="disk-summary">
            <span className="num">{summary.root}</span> · {t("disk.used")} ·{" "}
            {t("disk.summary", { files: fmt.int(summary.files), folders: fmt.int(summary.folders), time: fmt.duration(summary.durationMs) })}
          </div>
        </div>
        <span
          className={`ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] ${fast ? "bg-accent/10 text-accent" : "bg-raised text-muted"}`}
          data-testid="disk-method"
          data-method={summary.method}
        >
          {fast && <Zap size={12} />}
          {t(`disk.method.${summary.method}`)}
        </span>
        {drives.length > 1 && (
          <div className="flex shrink-0 rounded-lg border border-line p-0.5 text-[12px]" role="tablist" aria-label={t("disk.otherDrive")}>
            {drives.map((d) => {
              const current = d.mount.toLowerCase() === summary.root.toLowerCase();
              return (
                <button
                  key={d.mount}
                  role="tab"
                  aria-selected={current}
                  title={current ? undefined : t("disk.indexOther", { drive: d.mount.replace(/\$/, "") })}
                  onClick={() => {
                    if (!current) openDrive(d.mount);
                  }}
                  data-testid={`disk-switch-${d.mount.replace(/[^A-Za-z]/g, "")}`}
                  className={`num h-7 rounded-md px-2.5 transition-colors ${current ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
                >
                  {d.mount.replace(/\$/, "")}
                </button>
              );
            })}
          </div>
        )}
        <Button icon={<RefreshCw size={15} />} onClick={() => { useDisk.setState({ drive: summary.root }); startIndex(); }} data-testid="disk-reindex">
          {t("disk.reindex")}
        </Button>
      </div>

      {!summary.elevated && (
        <div className="flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-3">
          <ShieldAlert size={18} className="shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">
            {declined ? t("cleanup.adminDeclined") : t("disk.adminHint", { value: fmt.int(summary.unreadable) })}
          </p>
          <Button onClick={async () => setDeclined(!(await relaunchElevated()))}>{t("cleanup.adminAction")}</Button>
        </div>
      )}
      {summary.elevated && summary.unreadable > 0 && (
        <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-muted">
          <TriangleAlert size={14} className="mt-[3px] shrink-0 text-warn" />
          {t("disk.unreadable", { value: fmt.int(summary.unreadable) })}
        </p>
      )}

      <TrashResult />
      <ErrorLine error={error} />

      <div className="flex gap-1 rounded-lg border border-line p-0.5 text-[13px]" role="tablist">
        {TABS.map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => showTab(id)}
            data-testid={`disk-tab-${id}`}
            className={`relative h-8 flex-1 rounded-md transition-colors duration-150 ${tab === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            {tab === id && (
              <motion.span layoutId="disk-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />
            )}
            <span className="relative">{t(`disk.tab.${id}`)}</span>
          </button>
        ))}
      </div>

      {tab === "map" && folder && <MapTab folder={folder} />}
      {tab === "largest" && largest && (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {largest.map((item) => (
            <ItemRow key={item.id} item={item} showPath />
          ))}
        </ul>
      )}
      {tab === "search" && <SearchTab />}
      {tab === "dupes" && <DupesTab />}

      <p className="flex items-start gap-2 px-1 text-[11px] text-muted/80">
        <Info size={13} className="mt-0.5 shrink-0" />
        {t("disk.sizeNote")}
      </p>
      <div className="mt-auto" />
      <SelectionBar />
    </div>
  );
}
