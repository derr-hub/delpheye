import { useEffect } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowRight, ArrowUp, Brush, Cpu, HardDrive, ListTree, MemoryStick, Network } from "lucide-react";
import { AnimatedNumber, Bar, Card, Ring, Sparkline, loadColor } from "../components/ui";
import { go } from "../lib/app";
import { isVisible, useCleanup } from "../lib/cleanup";
import { formatUptime, useFmt } from "../lib/format";
import { healthScore, useMetrics, type HealthLevel } from "../lib/metrics";
import { runQuick, useMonitor } from "../lib/monitor";
import { HelpCard } from "../components/HelpCard";
import { checkSlowdown } from "../components/Slowdown";
import { Snail } from "lucide-react";
import { useSecurity } from "../lib/security";

const LEVEL_COLOR: Record<HealthLevel, string> = {
  good: "var(--color-safe)",
  warn: "var(--color-warn)",
  bad: "var(--color-risk)",
};
const LEVEL_KEY: Record<HealthLevel, string> = {
  good: "overview.healthGood",
  warn: "overview.healthWarn",
  bad: "overview.healthBad",
};

type Tone = "good" | "warn" | "bad";
const TONE_DOT: Record<Tone, string> = { good: "bg-safe", warn: "bg-warn", bad: "bg-risk" };

/** A few plain sentences on what is fine and what is not, worst first; each opens its page. */
function useStatusNotes() {
  const { t } = useTranslation();
  const m = useMetrics((s) => s.current);
  const cpuHistory = useMetrics((s) => s.history.cpu);
  const throttle = useMonitor((s) => s.frame?.throttle);
  const quick = useMonitor((s) => s.quick);
  const security = useSecurity((s) => s.report);
  useEffect(() => {
    if (!useMonitor.getState().quick && !useMonitor.getState().quickLoading) runQuick();
  }, []);
  const notes: { tone: Tone; text: string; open: () => void }[] = [];
  if (!m) return { notes, securityRun: !!security };
  const toStability = () => {
    useMonitor.setState({ tab: "stability" });
    go("monitoring");
  };

  const fixed = m.disks.filter((d) => !d.removable && d.total > 0).map((d) => ({ mount: d.mount.replace(/\\$/, ""), value: Math.round(((d.total - d.available) / d.total) * 100) }));
  const worstDisk = fixed.sort((a, b) => b.value - a.value)[0];
  if (worstDisk && worstDisk.value >= 90) notes.push({ tone: "bad", text: t("overview.status.diskFull", worstDisk), open: () => go("cleanup") });
  else if (worstDisk && worstDisk.value >= 85) notes.push({ tone: "warn", text: t("overview.status.diskTight", worstDisk), open: () => go("disk") });
  else notes.push({ tone: "good", text: t("overview.status.diskOk"), open: () => go("disk") });

  const mem = Math.round((m.memUsed / Math.max(1, m.memTotal)) * 100);
  notes.push(
    mem >= 88
      ? { tone: "bad", text: t("overview.status.memHigh", { value: mem }), open: () => go("processes") }
      : mem >= 75
        ? { tone: "warn", text: t("overview.status.memBusy", { value: mem }), open: () => go("processes") }
        : { tone: "good", text: t("overview.status.memOk", { value: mem }), open: () => go("processes") },
  );

  const cpuAvg = cpuHistory.length ? Math.round(cpuHistory.reduce((a, b) => a + b, 0) / cpuHistory.length) : Math.round(m.cpuUsage);
  const temp = throttle?.temp ? Math.round(throttle.temp) : null;
  if (throttle?.state === "thermal") notes.push({ tone: "warn", text: t("overview.status.cpuHot", { temp: temp ?? "—" }), open: () => go("monitoring") });
  else if (cpuAvg > 60) notes.push({ tone: "warn", text: t("overview.status.cpuBusy", { value: cpuAvg }), open: () => go("processes") });
  else notes.push({ tone: "good", text: t("overview.status.cpuOk", { temp: temp !== null ? t("overview.status.tempSuffix", { temp }) : "" }), open: () => go("monitoring") });

  if (quick) {
    const field: Record<string, string[]> = { bluescreens: ["bluescreens"], shutdowns: ["unexpectedShutdowns"], "hardware-errors": ["hardwareErrors", "hardwareWarnings"] };
    const count = (id: string) => {
      const v = (quick.checks.find((c) => c.id === id)?.values ?? {}) as Record<string, unknown>;
      return field[id].reduce((sum, k) => sum + (Number(v[k]) || 0), 0);
    };
    const parts = [
      count("bluescreens") && t("overview.status.bluescreens", { count: count("bluescreens") }),
      count("shutdowns") && t("overview.status.shutdowns", { count: count("shutdowns") }),
      count("hardware-errors") && t("overview.status.whea", { count: count("hardware-errors") }),
    ].filter(Boolean);
    const bad = quick.checks.some((c) => ["bluescreens", "shutdowns", "hardware-errors"].includes(c.id) && c.level === "bad");
    notes.push(parts.length ? { tone: bad ? "bad" : "warn", text: t("overview.status.crashes", { text: parts.join(", ") }), open: toStability } : { tone: "good", text: t("overview.status.crashesOk"), open: toStability });
  }

  if (security) {
    const high = security.findings.filter((f) => f.severity === "high").length;
    const medium = security.findings.filter((f) => f.severity === "medium").length;
    notes.push(
      high
        ? { tone: "bad", text: t("overview.status.security", { count: high }), open: () => go("security") }
        : medium
          ? { tone: "warn", text: t("overview.status.securityWarn", { count: medium }), open: () => go("security") }
          : { tone: "good", text: t("overview.status.securityOk", { score: security.hardening.score }), open: () => go("security") },
    );
  }

  const order: Record<Tone, number> = { bad: 0, warn: 1, good: 2 };
  notes.sort((a, b) => order[a.tone] - order[b.tone]);
  return { notes, securityRun: !!security };
}

function StatusNotes({ notes, securityRun }: ReturnType<typeof useStatusNotes>) {
  const { t } = useTranslation();
  return (
    <ul className="mt-2 space-y-0.5" data-testid="health-notes">
      {notes.map((n) => (
        <li key={n.text}>
          <button onClick={n.open} className="group flex w-full items-start gap-2 rounded-md py-0.5 text-left text-[0.75rem] leading-relaxed text-muted hover:text-fg">
            <span className={`mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[n.tone]}`} />
            <span className={n.tone === "good" ? "" : "text-fg/90"}>{n.text}</span>
          </button>
        </li>
      ))}
      {!securityRun && (
        <li>
          <button onClick={() => go("security")} className="flex items-start gap-2 py-0.5 text-left text-[0.75rem] text-muted/70 hover:text-fg">
            <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-muted/50" />
            {t("overview.status.securityNotRun")}
          </button>
        </li>
      )}
    </ul>
  );
}

export function Overview() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const report = useCleanup((s) => s.report);
  const info = useMetrics((s) => s.info);
  const m = useMetrics((s) => s.current);
  const history = useMetrics((s) => s.history);
  const clock = useMonitor((s) => s.frame?.throttle?.mhz ?? null);
  const status = useStatusNotes();

  if (!m) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <motion.span animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.6, repeat: Infinity }}>
          {t("overview.waiting")}
        </motion.span>
      </div>
    );
  }

  const { score, level: metricsLevel } = healthScore(m, history.cpu);
  // The headline never says "all good" while the notes below it show a problem.
  const level: HealthLevel = status.notes.some((n) => n.tone === "bad") ? (metricsLevel === "bad" ? "bad" : "warn") : status.notes.some((n) => n.tone === "warn") && metricsLevel === "good" ? "warn" : metricsLevel;
  const reclaimable = report?.categories.filter(isVisible).reduce((sum, c) => sum + c.bytes, 0) ?? 0;
  const memPct = (m.memUsed / Math.max(m.memTotal, 1)) * 100;
  const swapPct = m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0;
  const units = { d: t("units.d"), h: t("units.h"), m: t("units.m") };
  const netMax = Math.max(...history.rx, ...history.tx, 64 * 1024);

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={{ show: { transition: { staggerChildren: 0.05 } } }}
      className="grid grid-cols-6 gap-4"
    >
      {/* Health */}
      <Card className="col-span-6 flex items-center gap-7">
        <Ring value={score} color={LEVEL_COLOR[level]}>
          <span className="font-display text-[2.5rem] font-semibold leading-none">
            <AnimatedNumber value={score} />
          </span>
          <span className="mt-1 text-[0.6875rem] text-muted">/ 100</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="text-[0.8125rem] text-muted">{t("overview.health")}</div>
          <div className="font-display text-[1.625rem] font-semibold" style={{ color: LEVEL_COLOR[level] }}>
            {t(LEVEL_KEY[level])}
          </div>
          <StatusNotes {...status} />
          <button
            onClick={checkSlowdown}
            data-testid="slowdown-open"
            className="reveal mt-3 inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[0.75rem] text-fg transition-colors hover:bg-raised"
          >
            <Snail size={14} className="text-accent" />
            {t("slowdown.button")}
          </button>
        </div>
        <dl className="grid shrink-0 grid-cols-[auto_auto] gap-x-6 gap-y-2 text-[0.8125rem]">
          <dt className="text-muted">{info?.hostName || "—"}</dt>
          <dd className="text-right">
            {info ? `${info.osName} ${info.osVersion}` : "—"}
          </dd>
          <dt className="text-muted">{t("overview.uptime")}</dt>
          <dd className="num text-right">{formatUptime(m.uptime, units)}</dd>
          <dt className="text-muted">{t("overview.processes")}</dt>
          <dd className="num text-right">{m.processCount}</dd>
        </dl>
      </Card>

      {/* CPU */}
      <Card className="col-span-2" title={t("overview.cpu")} icon={<Cpu size={15} />} to="monitoring">
        <div className="flex items-baseline gap-1">
          <span className="font-display text-[2rem] font-semibold leading-none">
            <AnimatedNumber value={m.cpuUsage} />
          </span>
          <span className="text-muted">%</span>
          {clock ? (
            <span className="num ml-auto text-[0.75rem] text-muted" title={t("overview.realClock")}>
              {fmt.frequency(clock)}
            </span>
          ) : null}
        </div>
        <div className="mt-3">
          <Sparkline data={history.cpu} max={100} height={58} color={loadColor(m.cpuUsage, 80, 95)} />
        </div>
        <div className="mt-3 flex h-6 items-end gap-[3px]" aria-hidden>
          {m.perCore.map((v, i) => (
            <div key={i} className="flex h-full flex-1 items-end overflow-hidden rounded-sm bg-raised">
              <motion.div
                className="w-full rounded-sm bg-accent"
                animate={{ height: `${Math.max(v, 4)}%` }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>
          ))}
        </div>
        <div className="mt-3 truncate text-[0.75rem] text-muted" title={info?.cpuBrand}>
          {info?.cpuBrand}
        </div>
        {info && (
          <div className="text-[0.75rem] text-muted">
            {t("overview.cores", { physical: info.physicalCores, logical: info.logicalCores })}
          </div>
        )}
      </Card>

      {/* Memory */}
      <Card className="col-span-2" title={t("overview.memory")} icon={<MemoryStick size={15} />}>
        <div className="flex items-baseline gap-1">
          <span className="font-display text-[2rem] font-semibold leading-none">
            <AnimatedNumber value={memPct} />
          </span>
          <span className="text-muted">%</span>
          <span className="num ml-auto text-[0.75rem] text-muted">
            {fmt.bytes(m.memUsed)} {t("overview.of", { value: fmt.bytes(m.memTotal) })}
          </span>
        </div>
        <div className="mt-3">
          <Sparkline data={history.mem} max={100} height={58} color={loadColor(memPct)} />
        </div>
        <div className="mt-[18px] flex items-center justify-between text-[0.75rem] text-muted">
          <span>{t("overview.swap")}</span>
          <span className="num">
            {fmt.bytes(m.swapUsed)} {t("overview.of", { value: fmt.bytes(m.swapTotal) })}
          </span>
        </div>
        <div className="mt-2">
          <Bar value={swapPct} color={loadColor(swapPct)} />
        </div>
      </Card>

      {/* Network */}
      <Card className="col-span-2" title={t("overview.network")} icon={<Network size={15} />} to="network">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <div className="flex items-center gap-1 text-[0.75rem] text-muted">
              <ArrowDown size={13} className="text-accent" /> {t("overview.download")}
            </div>
            <div className="num mt-1 text-[1.125rem]">
              {fmt.bytes(m.netRx)}
              <span className="text-[0.75rem] text-muted">{t("units.perSec")}</span>
            </div>
          </div>
          <div>
            <div className="flex items-center gap-1 text-[0.75rem] text-muted">
              <ArrowUp size={13} className="text-safe" /> {t("overview.upload")}
            </div>
            <div className="num mt-1 text-[1.125rem]">
              {fmt.bytes(m.netTx)}
              <span className="text-[0.75rem] text-muted">{t("units.perSec")}</span>
            </div>
          </div>
        </div>
        <div className="mt-3 space-y-1">
          <Sparkline data={history.rx} max={netMax} height={36} color="var(--color-accent)" />
          <Sparkline data={history.tx} max={netMax} height={36} color="var(--color-safe)" />
        </div>
      </Card>

      {/* Disks */}
      <Card className="col-span-3 flex flex-col" title={t("overview.disks")} icon={<HardDrive size={15} />} to="disk">
        <ul className="mb-4 space-y-4">
          {m.disks.map((d) => {
            const usedPct = d.total ? ((d.total - d.available) / d.total) * 100 : 0;
            return (
              <li key={d.mount}>
                <div className="mb-1.5 flex items-baseline gap-2 text-[0.8125rem]">
                  <span className="num font-medium">{d.mount.replace(/\\$/, "")}</span>
                  <span className="truncate text-muted">{d.name}</span>
                  <span className="text-[0.6875rem] text-muted">
                    {[d.kind !== "Unknown" ? d.kind : null, d.fileSystem, d.removable ? t("overview.removable") : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  <span className="num ml-auto shrink-0 text-[0.75rem] text-muted">
                    {t("overview.free", { value: fmt.bytes(d.available) })} · {fmt.bytes(d.total)}
                  </span>
                </div>
                <Bar value={usedPct} color={loadColor(usedPct, 85, 95)} />
              </li>
            );
          })}
        </ul>
        <button
          className="group mt-auto flex items-center gap-2.5 border-t border-line/70 pt-3.5 text-left text-[0.8125rem] text-muted transition-colors duration-150 hover:text-fg"
          style={{ marginTop: "auto" }}
          onClick={() => go("cleanup")}
          data-testid="reclaim-cta"
        >
          <Brush size={15} className="text-accent" />
          <span className="flex-1">
            {reclaimable > 0 ? t("overview.reclaimFound", { value: fmt.bytes(reclaimable) }) : t("overview.reclaimCta")}
          </span>
          <ArrowRight size={15} className="transition-transform duration-150 group-hover:translate-x-0.5" />
        </button>
      </Card>

      {/* Top processes */}
      <Card className="col-span-3" title={t("overview.topProcesses")} icon={<ListTree size={15} />} to="processes">
        <ul className="space-y-2.5 text-[0.8125rem]">
          {m.topProcesses.map((p) => (
            <li key={p.name} className="flex items-center gap-3">
              <span className="min-w-0 flex-1 truncate">
                {p.name}
                {p.count > 1 && <span className="ml-2 text-[0.6875rem] text-muted">{t("overview.procCount", { count: p.count })}</span>}
              </span>
              <span className="num w-14 text-right text-[0.75rem] text-muted">{p.cpu.toFixed(1)}%</span>
              <span className="num w-20 text-right">{fmt.bytes(p.memory)}</span>
            </li>
          ))}
        </ul>
      </Card>
      <HelpCard />
    </motion.div>
  );
}
