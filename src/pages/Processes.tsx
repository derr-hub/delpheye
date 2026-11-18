import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AppWindow,
  Box,
  ChevronRight,
  Cog,
  Cpu,
  FolderOpen,
  Globe,
  HardDrive,
  ListTree,
  List as ListIcon,
  MemoryStick,
  Network,
  Search,
  ShieldAlert,
  Square,
  X,
} from "lucide-react";
import { Button, Modal, Sparkline } from "../components/ui";
import { go } from "../lib/app";
import { useFmt } from "../lib/format";
import { useMetrics } from "../lib/metrics";
import {
  buildTree,
  endProcess,
  keyOf,
  loadDetails,
  matches,
  startPolling,
  useProcesses,
  type Filter,
  type Level,
  type Node,
  type Proc,
  type SortKey,
} from "../lib/processes";

const LEVEL_TONE: Record<Level, string> = {
  critical: "bg-risk/10 text-risk",
  windows: "bg-accent/10 text-accent",
  app: "bg-raised text-muted",
  own: "bg-safe/10 text-safe",
};

function WindowsGlyph({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      <path fill="currentColor" d="M1 2.6 6.6 1.8v5.4H1zM7.4 1.7 15 .6v6.6H7.4zM1 8h5.6v5.4L1 12.6zm6.4 0H15v6.6l-7.6-1.1z" opacity="0.85" />
    </svg>
  );
}

/** The program's own icon, or a symbol for what kind of process it is. */
export function ProcIcon({ proc, size = 18, layoutId }: { proc: Proc; size?: number; layoutId?: string }) {
  const icon = useProcesses((s) => (proc.exe ? s.icons[proc.exe] : undefined));
  const inner = icon ? (
    <img src={icon} width={size} height={size} alt="" draggable={false} style={{ imageRendering: size > 24 ? "auto" : "-webkit-optimize-contrast" }} />
  ) : proc.level === "windows" || proc.level === "critical" ? (
    <span className="text-accent">
      <WindowsGlyph size={size * 0.85} />
    </span>
  ) : proc.kind === "service" ? (
    <Cog size={size * 0.9} className="text-muted" />
  ) : proc.kind === "app" ? (
    <AppWindow size={size * 0.9} className="text-muted" />
  ) : (
    <Box size={size * 0.9} className="text-muted" />
  );
  return (
    <motion.span layoutId={layoutId} className="flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {inner}
    </motion.span>
  );
}

/** The name people know a program by: its description, unless that is missing or generic. */
export function displayName(p: Proc) {
  const d = p.description?.trim();
  if (!d || d.length > 48 || /^(host process|windows host|application|app)$/i.test(d)) return p.name.replace(/\.exe$/i, "");
  return d;
}

/** Background tint that grows with how much a process uses, like Task Manager's heat map. */
function heat(share: number) {
  const a = Math.min(1, Math.max(0, share));
  return a < 0.02 ? undefined : { background: `rgba(76, 194, 255, ${(0.05 + a * 0.28).toFixed(3)})` };
}

const COLUMNS = "grid-cols-[minmax(0,1fr)_72px_88px_84px_64px]";

function Row({ node, open, onToggle, tree }: { node: Node; open: boolean; onToggle: () => void; tree: boolean }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const p = node.proc;
  const key = keyOf(p);
  const selected = useProcesses((s) => s.selected === key);
  const totalMemory = useMetrics((s) => s.current?.memTotal ?? 16 * 1024 ** 3);
  const [hover, setHover] = useState(false);
  const grouped = tree && !open && node.children.length > 0;
  const v = grouped ? node.total : { cpu: p.cpu, memory: p.memory, disk: p.disk, net: p.connections, count: 1 };
  const secondary = p.window ?? (p.services.length ? p.services.slice(0, 2).join(", ") + (p.services.length > 2 ? ` +${p.services.length - 2}` : "") : displayName(p) !== p.name.replace(/\.exe$/i, "") ? p.name : null);
  return (
    <motion.div
      layout="position"
      transition={{ type: "spring", stiffness: 520, damping: 44 }}
      role="row"
      aria-selected={selected}
      data-testid={`proc-${p.pid}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => useProcesses.setState({ selected: selected ? null : key })}
      className={`grid ${COLUMNS} h-[40px] items-stretch border-b border-line/40 text-[13px] transition-colors duration-100 ${selected ? "bg-accent/[0.09]" : "hover:bg-raised/50"}`}
    >
      <div className="flex min-w-0 items-center gap-2 pr-2" style={{ paddingLeft: 12 + (tree ? node.depth * 18 : 0) }}>
        {tree && (
          <span className="flex w-4 shrink-0 justify-center">
            {node.children.length > 0 && (
              <button
                aria-label={open ? t("processes.collapse") : t("processes.expand")}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-raised hover:text-fg"
              >
                <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ type: "spring", stiffness: 500, damping: 30 }}>
                  <ChevronRight size={14} />
                </motion.span>
              </button>
            )}
          </span>
        )}
        <ProcIcon proc={p} layoutId={hover || selected ? `proc-icon-${key}` : undefined} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="truncate">{displayName(p)}</span>
            {grouped && <span className="num shrink-0 rounded-full bg-raised px-1.5 text-[10px] text-muted" title={t("processes.groupHint")}>{node.total.count}</span>}
            {p.impostor && <ShieldAlert size={13} className="shrink-0 text-risk" />}
          </div>
          {secondary && <div className="truncate text-[11px] text-muted">{secondary}</div>}
        </div>
      </div>
      <div className="num flex items-center justify-end pr-3 text-[12px]" style={heat(v.cpu / 25)}>
        {v.cpu >= 0.1 ? `${v.cpu.toFixed(1)}%` : <span className="text-muted/60">0%</span>}
      </div>
      <div className="num flex items-center justify-end pr-3 text-[12px]" style={heat(v.memory / (totalMemory * 0.1))}>
        {v.memory > 0 ? fmt.bytes(v.memory) : <span className="text-muted/60" title={t("processes.hiddenMemory")}>—</span>}
      </div>
      <div className="num flex items-center justify-end pr-3 text-[12px]" style={heat(v.disk / (20 * 1024 * 1024))}>
        {v.disk >= 1024 ? `${fmt.bytes(v.disk)}/${t("processes.perSecond")}` : <span className="text-muted/60">0</span>}
      </div>
      <div className="num flex items-center justify-end pr-3 text-[12px]">{v.net > 0 ? v.net : <span className="text-muted/60">—</span>}</div>
    </motion.div>
  );
}

function compare(key: SortKey, desc: boolean, grouped: boolean) {
  return (a: Node, b: Node) => {
    const va = grouped ? a.total : { cpu: a.proc.cpu, memory: a.proc.memory, disk: a.proc.disk, net: a.proc.connections };
    const vb = grouped ? b.total : { cpu: b.proc.cpu, memory: b.proc.memory, disk: b.proc.disk, net: b.proc.connections };
    const r = key === "name" ? displayName(a.proc).localeCompare(displayName(b.proc)) : (va[key] as number) - (vb[key] as number);
    return desc ? -r : r;
  };
}

function Table() {
  const { t } = useTranslation();
  const { listing, view, filter, query, sort, toggled } = useProcesses();
  const tree = view === "tree";

  const rows = useMemo(() => {
    if (!listing) return [] as { node: Node; open: boolean }[];
    const forest = buildTree(listing.rows);
    const out: { node: Node; open: boolean }[] = [];
    if (!tree) {
      const flat: Node[] = [];
      const walk = (n: Node) => {
        if (matches(n.proc, filter, query)) flat.push({ ...n, depth: 0 });
        n.children.forEach(walk);
      };
      forest.forEach(walk);
      flat.sort(compare(sort.key, sort.desc, false));
      return flat.map((node) => ({ node, open: false }));
    }
    // In the tree a node shows if it, or anything below it, matches; searching opens the way to matches.
    const visible = new Map<Node, boolean>();
    const check = (n: Node): boolean => {
      const own = matches(n.proc, filter, query);
      const below = n.children.map(check).some(Boolean);
      visible.set(n, own || below);
      return own || below;
    };
    forest.forEach(check);
    const searching = query.length > 0 || filter !== "all";
    const emit = (n: Node) => {
      if (!visible.get(n)) return;
      const k = keyOf(n.proc);
      const open = toggled[k] ?? (searching ? n.children.some((c) => visible.get(c)) : n.depth === 0);
      out.push({ node: n, open });
      if (open) [...n.children].sort(compare(sort.key, sort.desc, true)).forEach(emit);
    };
    [...forest].sort(compare(sort.key, sort.desc, true)).forEach(emit);
    return out;
  }, [listing, tree, filter, query, sort, toggled]);

  const header = (key: SortKey, label: string, icon: ReactNode, align = "justify-end") => (
    <button
      onClick={() => useProcesses.setState({ sort: { key, desc: sort.key === key ? !sort.desc : key !== "name" } })}
      className={`flex items-center gap-1.5 px-3 ${align} text-[11px] uppercase tracking-wider transition-colors ${sort.key === key ? "text-fg" : "text-muted hover:text-fg"}`}
      aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      {icon}
      {label}
      {sort.key === key && <span className="text-accent">{sort.desc ? "↓" : "↑"}</span>}
    </button>
  );

  return (
    <div className="overflow-clip rounded-card border border-line bg-surface" role="table">
      <div className={`sticky top-[52px] z-10 grid ${COLUMNS} h-9 items-stretch border-b border-line bg-surface/95 backdrop-blur`} role="row">
        {header("name", t("processes.col.name"), null, "justify-start")}
        {header("cpu", t("processes.col.cpu"), <Cpu size={12} />)}
        {header("memory", t("processes.col.memory"), <MemoryStick size={12} />)}
        {header("disk", t("processes.col.disk"), <HardDrive size={12} />)}
        {header("net", t("processes.col.net"), <Network size={12} />)}
      </div>
      {rows.length === 0 ? (
        <p className="px-5 py-10 text-center text-[13px] text-muted">{listing ? t("processes.empty") : t("processes.loading")}</p>
      ) : (
        rows.map(({ node, open }) => (
          <Row
            key={keyOf(node.proc)}
            node={node}
            open={open}
            tree={tree}
            onToggle={() => useProcesses.setState((s) => ({ toggled: { ...s.toggled, [keyOf(node.proc)]: !open } }))}
          />
        ))
      )}
    </div>
  );
}

/** Programs grouped by their file, as people think of them: "Chrome", not 23 chrome.exe. */
function useGroups() {
  const listing = useProcesses((s) => s.listing);
  // Readings jump from one refresh to the next; the summary follows a smoothed value so bars
  // glide and the ranking does not reshuffle on every blip.
  const smooth = useRef(new Map<string, { cpu: number; memory: number }>());
  return useMemo(() => {
    const groups = new Map<string, { id: string; main: Proc; count: number; cpu: number; memory: number }>();
    for (const p of listing?.rows ?? []) {
      if (p.level === "own") continue;
      const id = (p.exe ?? p.name).toLowerCase();
      const g = groups.get(id);
      if (g) {
        g.count += 1;
        g.cpu += p.cpu;
        g.memory += p.memory;
        if ((p.window && !g.main.window) || (!g.main.window && p.memory > g.main.memory)) g.main = p;
      } else groups.set(id, { id, main: p, count: 1, cpu: p.cpu, memory: p.memory });
    }
    const next = new Map<string, { cpu: number; memory: number }>();
    for (const g of groups.values()) {
      const old = smooth.current.get(g.id);
      g.cpu = old ? old.cpu * 0.65 + g.cpu * 0.35 : g.cpu;
      g.memory = old ? old.memory * 0.5 + g.memory * 0.5 : g.memory;
      next.set(g.id, { cpu: g.cpu, memory: g.memory });
    }
    smooth.current = next;
    return [...groups.values()];
  }, [listing]);
}

function Consumers() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const groups = useGroups();
  const byCpu = [...groups].sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  const byMemory = [...groups].sort((a, b) => b.memory - a.memory).slice(0, 5);
  const top = byMemory[0];
  const busiest = byCpu[0];
  const list = (items: typeof groups, metric: "cpu" | "memory") => {
    // CPU bars share a fixed 0–25 % scale so a quiet moment does not stretch tiny values to full width.
    const max = metric === "cpu" ? Math.max(25, ...items.map((g) => g.cpu)) : Math.max(...items.map((g) => g.memory), 1);
    return (
      <ul className="space-y-1.5">
        {items.map((g) => (
          <motion.li key={g.id} layout="position" transition={{ type: "spring", stiffness: 160, damping: 26 }}>
            <button className="group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-raised/60" onClick={() => useProcesses.setState({ selected: keyOf(g.main) })}>
              <ProcIcon proc={g.main} size={16} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5 text-[12px]">
                  <span className="truncate">{displayName(g.main)}</span>
                  {g.count > 1 && <span className="shrink-0 text-[10px] text-muted">{t("overview.procCount", { count: g.count })}</span>}
                </span>
                <span className="mt-0.5 block h-1 overflow-hidden rounded-full bg-raised">
                  <motion.span className={`block h-full rounded-full ${metric === "cpu" ? "bg-accent" : "bg-[#3987e5]"}`} initial={false} animate={{ width: `${Math.max(1, (g[metric] / max) * 100)}%` }} transition={{ type: "spring", stiffness: 45, damping: 16, mass: 1.2 }} />
                </span>
              </span>
              <span className="num w-16 shrink-0 text-right text-[12px]">{metric === "cpu" ? `${g.cpu.toFixed(1)}%` : fmt.bytes(g.memory)}</span>
            </button>
          </motion.li>
        ))}
      </ul>
    );
  };
  if (!top) return null;
  return (
    <section className="rounded-card border border-line bg-surface p-5" data-testid="consumers">
      <p className="mb-4 max-w-[95ch] text-[14px] leading-relaxed">
        {t(top.count > 1 ? "processes.headlineMany" : "processes.headline", { name: displayName(top.main), value: fmt.bytes(top.memory), count: top.count })}{" "}
        <span className="text-muted">
          {busiest && busiest.cpu >= 5 ? t("processes.headlineCpu", { name: displayName(busiest.main), value: busiest.cpu.toFixed(0) }) : t("processes.headlineIdle")}
        </span>
      </p>
      <div className="grid grid-cols-2 gap-6">
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
            <Cpu size={12} />
            {t("processes.topCpu")}
          </h3>
          {list(byCpu, "cpu")}
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted">
            <MemoryStick size={12} />
            {t("processes.topMemory")}
          </h3>
          {list(byMemory, "memory")}
        </div>
      </div>
    </section>
  );
}

function Toolbar() {
  const { t } = useTranslation();
  const { view, filter, query, listing } = useProcesses();
  const counts = useMemo(() => {
    const rows = listing?.rows ?? [];
    return {
      all: rows.length,
      apps: rows.filter((p) => matches(p, "apps", "")).length,
      background: rows.filter((p) => matches(p, "background", "")).length,
      windows: rows.filter((p) => matches(p, "windows", "")).length,
    } satisfies Record<Filter, number>;
  }, [listing]);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex rounded-lg border border-line p-0.5 text-[12px]" role="tablist">
        {(["tree", "list"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={view === id}
            onClick={() => useProcesses.setState({ view: id })}
            data-testid={`proc-view-${id}`}
            className={`relative flex h-7 items-center gap-1.5 rounded-md px-3 ${view === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            {view === id && <motion.span layoutId="proc-view" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
            <span className="relative">{id === "tree" ? <ListTree size={14} /> : <ListIcon size={14} />}</span>
            <span className="relative">{t(`processes.view.${id}`)}</span>
          </button>
        ))}
      </div>
      <div className="flex gap-1">
        {(["all", "apps", "background", "windows"] as const).map((id) => (
          <button
            key={id}
            onClick={() => useProcesses.setState({ filter: id })}
            data-testid={`proc-filter-${id}`}
            className={`h-8 rounded-full px-3 text-[12px] transition-colors ${filter === id ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg"}`}
          >
            {t(`processes.filter.${id}`)} <span className="num opacity-70">{counts[id]}</span>
          </button>
        ))}
      </div>
      <label className="ml-auto flex h-8 w-64 items-center gap-2 rounded-lg border border-line bg-bg/40 px-2.5 text-[12px] focus-within:border-accent/60">
        <Search size={14} className="text-muted" />
        <input
          value={query}
          onChange={(e) => useProcesses.setState({ query: e.target.value })}
          placeholder={t("processes.search")}
          className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted/70"
          data-testid="proc-search"
        />
        {query && (
          <button onClick={() => useProcesses.setState({ query: "" })} className="text-muted hover:text-fg" aria-label={t("processes.clear")}>
            <X size={13} />
          </button>
        )}
      </label>
    </div>
  );
}

/** Plain-language "what is this" for any process: a written explanation when DelphEye knows it, else one assembled from the facts. */
function useExplanation(p: Proc) {
  const { t, i18n } = useTranslation();
  if (p.known && i18n.exists(`processes.known.${p.known}.what`)) {
    return {
      what: t(`processes.known.${p.known}.what`),
      end: i18n.exists(`processes.known.${p.known}.end`) ? t(`processes.known.${p.known}.end`) : t(`processes.endText.${p.level}`),
    };
  }
  const parts: string[] = [];
  if (p.description) parts.push(t("processes.generic.described", { description: p.description, company: p.company ? t("processes.generic.by", { company: p.company }) : "" }));
  else parts.push(t("processes.generic.noInfo"));
  const category = i18n.exists(`processes.category.${p.category}`) ? t(`processes.category.${p.category}`) : "";
  if (category) parts.push(category);
  const path = p.exe?.toLowerCase() ?? "";
  parts.push(
    !p.exe
      ? t("processes.generic.where.unknown")
      : path.includes("\\temp\\") || path.includes("\\downloads\\")
        ? t("processes.generic.where.temp")
        : path.includes("\\program files")
          ? t("processes.generic.where.programFiles")
          : path.includes("\\appdata\\")
            ? t("processes.generic.where.appdata")
            : path.startsWith("c:\\windows\\")
              ? t("processes.generic.where.windows")
              : t("processes.generic.where.other"),
  );
  if (p.window) parts.push(t("processes.generic.window", { window: p.window }));
  else if (p.services.length) parts.push(t("processes.generic.services", { list: p.services.slice(0, 4).join(", ") + (p.services.length > 4 ? "…" : "") }));
  else parts.push(t(p.kind === "service" ? "processes.generic.service" : "processes.generic.background"));
  return { what: parts.join(" "), end: t(`processes.endText.${p.level}`) };
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

function Drawer({ proc }: { proc: Proc }) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const key = keyOf(proc);
  const { listing, spark, details, ending, endResult } = useProcesses();
  const detail = details[key];
  const [confirm, setConfirm] = useState<null | "one" | "tree">(null);
  const [showCmd, setShowCmd] = useState(false);
  const { what, end } = useExplanation(proc);
  useEffect(() => {
    loadDetails(proc);
    const timer = window.setInterval(() => loadDetails(proc), 5000);
    return () => window.clearInterval(timer);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = listing?.rows ?? [];
  const parent = proc.parent !== null ? rows.find((r) => r.pid === proc.parent) : undefined;
  const children = rows.filter((r) => r.parent === proc.pid);
  const descendants = useMemo(() => {
    const all = buildTree(rows);
    const find = (nodes: Node[]): Node | undefined => {
      for (const n of nodes) {
        if (n.proc.pid === proc.pid) return n;
        const hit = find(n.children);
        if (hit) return hit;
      }
    };
    return (find(all)?.total.count ?? 1) - 1;
  }, [rows, proc.pid]);
  const rel = new Intl.RelativeTimeFormat(i18n.language.startsWith("uk") ? "uk" : "en", { numeric: "auto" });
  const age = Math.max(0, Date.now() / 1000 - proc.start);
  const ago = age < 3600 ? rel.format(-Math.round(age / 60), "minute") : age < 86400 ? rel.format(-Math.round(age / 3600), "hour") : rel.format(-Math.round(age / 86400), "day");
  const canEnd = proc.level !== "critical" && proc.level !== "own";
  const result = endResult?.key === key ? endResult : null;
  const signature =
    proc.level === "windows" || proc.level === "critical" ? t("processes.signature.windows") : detail ? (detail.signed === true ? t("processes.signature.yes") : detail.signed === false ? t("processes.signature.no") : t("processes.signature.unknown")) : "…";
  const established = detail?.connections.filter((c) => c.state === "established") ?? [];
  const listen = detail?.connections.filter((c) => c.state === "listen") ?? [];

  return (
    <motion.aside
      initial={{ x: 460, opacity: 0.4 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 460, opacity: 0 }}
      transition={{ type: "spring", stiffness: 340, damping: 34 }}
      className="fixed bottom-3 right-3 top-[48px] z-30 flex w-[430px] flex-col overflow-hidden rounded-2xl border border-line bg-surface/[0.97] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl"
      data-testid="proc-drawer"
    >
      <header className="flex items-start gap-3.5 border-b border-line px-5 pb-4 pt-5">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-raised">
          <ProcIcon proc={proc} size={32} layoutId={`proc-icon-${key}`} />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-[18px] font-semibold leading-tight">{displayName(proc)}</h2>
          <p className="truncate text-[12px] text-muted">{proc.window ?? proc.name}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-[11px] ${LEVEL_TONE[proc.level]}`}>{t(`processes.level.${proc.level}`)}</span>
            <span className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-muted">{t(`processes.kind.${proc.kind}`)}</span>
            {proc.impostor && <span className="rounded-full bg-risk/10 px-2 py-0.5 text-[11px] text-risk">{t("processes.impostor")}</span>}
          </div>
        </div>
        <button onClick={() => useProcesses.setState({ selected: null })} className="rounded-lg p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label={t("processes.close")}>
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-[13px]">
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              ["cpu", `${proc.cpu.toFixed(1)}%`, spark[key]?.cpu ?? [], 25, "var(--color-accent)"],
              ["memory", fmt.bytes(proc.memory), spark[key]?.memory ?? [], Math.max(1, ...(spark[key]?.memory ?? [1])) * 1.4, "#3987e5"],
              ["disk", `${fmt.bytes(proc.disk)}/${t("processes.perSecond")}`, null, undefined, ""],
            ] as const
          ).map(([id, value, data, max, color]) => (
            <div key={id} className="rounded-xl bg-raised/50 px-3 pb-1.5 pt-2.5">
              <div className="text-[11px] text-muted">{t(`processes.col.${id}`)}</div>
              <div className="num text-[15px]">{value}</div>
              {data ? <Sparkline data={[...data]} color={color} max={max} height={24} points={40} /> : <div className="h-6" />}
            </div>
          ))}
        </div>

        {proc.impostor && (
          <div className="flex gap-2.5 rounded-xl border border-risk/25 bg-risk/[0.06] px-3.5 py-3 text-[12px] leading-relaxed">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-risk" />
            <span>
              {t("processes.impostorText")}{" "}
              <button className="text-accent hover:underline" onClick={() => go("security")}>
                {t("processes.openSecurity")}
              </button>
            </span>
          </div>
        )}

        <section>
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-muted">{t("processes.what")}</h3>
          <p className="leading-relaxed" data-testid="proc-what">{what}</p>
        </section>
        <section>
          <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-muted">{t("processes.ifEnded")}</h3>
          <p className={`leading-relaxed ${proc.level === "critical" ? "text-risk" : proc.level === "windows" ? "text-warn" : "text-muted"}`}>{end}</p>
        </section>

        <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2 text-[12px]">
          <Fact label={t("processes.fact.publisher")}>{proc.company ?? "—"}</Fact>
          <Fact label={t("processes.fact.signature")}>{signature}</Fact>
          <Fact label={t("processes.fact.file")}>
            {proc.exe ? (
              <span className="num select-text text-[11px]">{proc.exe}</span>
            ) : (
              <span className="text-muted">{t("processes.fact.noPath")}</span>
            )}
          </Fact>
          <Fact label={t("processes.fact.started")}>
            {ago} <span className="text-muted">· {fmt.dateTime(proc.start)}</span>
          </Fact>
          <Fact label="PID">
            <span className="num">{proc.pid}</span>
          </Fact>
          <Fact label={t("processes.fact.parent")}>
            {parent ? (
              <button className="flex items-center gap-1.5 text-accent hover:underline" onClick={() => useProcesses.setState({ selected: keyOf(parent) })}>
                <ProcIcon proc={parent} size={14} />
                {displayName(parent)}
              </button>
            ) : (
              <span className="text-muted">{t("processes.fact.noParent")}</span>
            )}
          </Fact>
          {children.length > 0 && (
            <Fact label={t("processes.fact.children")}>
              <div className="flex flex-wrap gap-1">
                {children.slice(0, 8).map((c) => (
                  <button key={keyOf(c)} className="flex items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[11px] hover:bg-line" onClick={() => useProcesses.setState({ selected: keyOf(c) })}>
                    <ProcIcon proc={c} size={12} />
                    {displayName(c)}
                  </button>
                ))}
                {children.length > 8 && <span className="px-1 text-[11px] text-muted">{t("processes.more", { count: children.length - 8 })}</span>}
              </div>
            </Fact>
          )}
          {proc.services.length > 0 && (
            <Fact label={t("processes.fact.services")}>
              <ul className="space-y-0.5">
                {proc.services.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Fact>
          )}
          <Fact label={t("processes.fact.network")}>
            {!detail ? (
              "…"
            ) : established.length + listen.length === 0 ? (
              <span className="text-muted">{t("processes.fact.noNetwork")}</span>
            ) : (
              <ul className="num space-y-0.5 text-[11px]">
                {established.slice(0, 8).map((c, i) => (
                  <li key={`e${i}`} className="flex gap-1.5">
                    <span className="text-safe">↔</span>
                    {c.remote}
                  </li>
                ))}
                {established.length > 8 && <li className="text-muted">{t("processes.more", { count: established.length - 8 })}</li>}
                {listen.slice(0, 4).map((c, i) => (
                  <li key={`l${i}`} className="text-muted">
                    {t("processes.fact.listens", { local: c.local })}
                  </li>
                ))}
              </ul>
            )}
          </Fact>
          {detail?.cmd && (
            <Fact label={t("processes.fact.cmd")}>
              <button className="text-left" onClick={() => setShowCmd(!showCmd)}>
                <span className={`num select-text text-[11px] ${showCmd ? "" : "line-clamp-2"}`}>{detail.cmd}</span>
              </button>
            </Fact>
          )}
        </dl>
      </div>

      <footer className="space-y-2 border-t border-line px-5 py-3.5">
        {result && <p className={`text-[12px] ${result.ok ? "text-safe" : "text-risk"}`}>{resultText(result.message, t)}</p>}
        <div className="flex flex-wrap gap-2">
          <Button variant="danger" icon={<Square size={13} />} disabled={!canEnd || ending !== null} onClick={() => setConfirm("one")} data-testid="proc-end">
            {t("processes.end")}
          </Button>
          {descendants > 0 && (
            <Button icon={<ListTree size={14} />} disabled={!canEnd || ending !== null} onClick={() => setConfirm("tree")} data-testid="proc-end-tree">
              {t("processes.endTree", { count: descendants + 1 })}
            </Button>
          )}
          {proc.exe && (
            <Button variant="quiet" icon={<FolderOpen size={14} />} onClick={() => revealItemInDir(proc.exe!).catch(console.error)}>
              {t("processes.reveal")}
            </Button>
          )}
          <Button variant="quiet" icon={<Globe size={14} />} onClick={() => openUrl(`https://www.google.com/search?q=${encodeURIComponent(`${proc.name} ${t("processes.searchSuffix")}`)}`).catch(console.error)}>
            {t("processes.searchWeb")}
          </Button>
        </div>
        {!canEnd && <p className="text-[11px] text-muted">{t(`processes.cannotEnd.${proc.level}`)}</p>}
      </footer>

      <Modal open={confirm !== null} onClose={() => setConfirm(null)}>
        <h2 className="font-display text-[18px] font-semibold">{t(confirm === "tree" ? "processes.confirmTreeTitle" : "processes.confirmTitle", { name: displayName(proc), count: descendants + 1 })}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{end}</p>
        {confirm === "tree" && <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("processes.confirmTreeText", { count: descendants })}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirm(null)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="danger"
            data-testid="proc-end-confirm"
            onClick={() => {
              const tree = confirm === "tree";
              setConfirm(null);
              endProcess(proc, tree);
            }}
          >
            {t("processes.end")}
          </Button>
        </div>
      </Modal>
    </motion.aside>
  );
}

function resultText(message: string, t: TFunction) {
  const [kind, a, b] = message.split(":");
  if (kind === "ended") return Number(b) > 0 ? t("processes.result.partly", { count: Number(a), failed: Number(b) }) : t("processes.result.ended", { count: Number(a) });
  return t(`processes.result.${a}`, { defaultValue: t("processes.result.failed") });
}

export function Processes() {
  const { listing, selected, error } = useProcesses();
  const { t } = useTranslation();
  useEffect(() => startPolling(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && useProcesses.setState({ selected: null });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const proc = selected ? listing?.rows.find((r) => keyOf(r) === selected) : undefined;
  return (
    <div className="flex flex-col gap-4 pb-2">
      <Consumers />
      {listing && !listing.elevated && <p className="px-1 text-[12px] text-muted">{t("processes.adminHint")}</p>}
      {error && <p className="px-1 text-[12px] text-risk">{error}</p>}
      <Toolbar />
      <Table />
      <AnimatePresence>{proc && <Drawer key="drawer" proc={proc} />}</AnimatePresence>
    </div>
  );
}
