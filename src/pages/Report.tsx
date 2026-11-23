import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ArrowLeft, Cpu, FolderOpen, Laptop, MessageSquareQuote, Network as NetworkIcon, Rocket, ShieldHalf, Activity, ListTree, Flame } from "lucide-react";
import { Button, Card } from "../components/ui";
import { go } from "../lib/app";
import { useFmt } from "../lib/format";
import { openReport, useReport, type HelpReport } from "../lib/report";
import { CheckList } from "./Monitoring";
import { SeverityBadge } from "./Security";

type Tone = "good" | "warn" | "bad";
const DOT: Record<Tone, string> = { good: "bg-safe", warn: "bg-warn", bad: "bg-risk" };

/** The same kind of plain summary as the Overview, worked out from the report's data. */
function summary(r: HelpReport, t: TFunction): { tone: Tone; text: string }[] {
  const out: { tone: Tone; text: string }[] = [];
  const s = r.snapshot;
  if (s) {
    const disks = s.disks.filter((d) => !d.removable && d.total > 0).map((d) => ({ mount: d.mount.replace(/\\$/, ""), value: Math.round(((d.total - d.available) / d.total) * 100) }));
    const worst = disks.sort((a, b) => b.value - a.value)[0];
    if (worst) out.push(worst.value >= 90 ? { tone: "bad", text: t("overview.status.diskFull", worst) } : worst.value >= 85 ? { tone: "warn", text: t("overview.status.diskTight", worst) } : { tone: "good", text: t("overview.status.diskOk") });
    const mem = Math.round((s.memUsed / Math.max(1, s.memTotal)) * 100);
    out.push(mem >= 88 ? { tone: "bad", text: t("overview.status.memHigh", { value: mem }) } : mem >= 75 ? { tone: "warn", text: t("overview.status.memBusy", { value: mem }) } : { tone: "good", text: t("overview.status.memOk", { value: mem }) });
  }
  if (r.throttle?.state === "thermal") out.push({ tone: "warn", text: t("overview.status.cpuHot", { temp: Math.round(r.throttle.temp ?? 0) }) });
  if (r.quick) {
    const v = (id: string) => (r.quick!.checks.find((c) => c.id === id)?.values ?? {}) as Record<string, number>;
    const parts = [
      v("bluescreens").bluescreens && t("overview.status.bluescreens", { count: v("bluescreens").bluescreens }),
      v("shutdowns").unexpectedShutdowns && t("overview.status.shutdowns", { count: v("shutdowns").unexpectedShutdowns }),
      (v("hardware-errors").hardwareErrors || 0) + (v("hardware-errors").hardwareResets || 0) && t("overview.status.whea", { count: (v("hardware-errors").hardwareErrors || 0) + (v("hardware-errors").hardwareResets || 0) }),
    ].filter(Boolean);
    out.push(parts.length ? { tone: "bad", text: t("overview.status.crashes", { text: parts.join(", ") }) } : { tone: "good", text: t("overview.status.crashesOk") });
  }
  if (r.security) {
    const high = r.security.findings.filter((f) => f.severity === "high").length;
    const medium = r.security.findings.filter((f) => f.severity === "medium").length;
    out.push(high ? { tone: "bad", text: t("overview.status.security", { count: high }) } : medium ? { tone: "warn", text: t("overview.status.securityWarn", { count: medium }) } : { tone: "good", text: t("overview.status.securityOk", { score: r.security.hardening.score }) });
  }
  if (r.startup) {
    const heavy = r.startup.entries.filter((e) => e.advice === "disable").length;
    if (heavy) out.push({ tone: "warn", text: t("report.startupHeavy", { count: heavy }) });
  }
  const concerns = r.network?.apps.filter((a) => a.concerns.length).length ?? 0;
  if (concerns) out.push({ tone: "warn", text: t("report.netConcerns", { count: concerns }) });
  const order: Record<Tone, number> = { bad: 0, warn: 1, good: 2 };
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

function Section({ title, icon, children, empty }: { title: string; icon: ReactNode; children: ReactNode; empty?: boolean }) {
  const { t } = useTranslation();
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-1.5 px-1 text-[0.6875rem] uppercase tracking-wider text-muted">
        {icon}
        {title}
      </h2>
      {empty ? <p className="rounded-card border border-line bg-surface px-5 py-3.5 text-[0.75rem] text-muted">{t("report.notIncluded")}</p> : children}
    </section>
  );
}

export function Report() {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const { viewing: r, viewingFile } = useReport();
  if (!r) {
    return (
      <div className="flex flex-col items-center py-16 text-center text-[0.8125rem] text-muted">
        <p>{t("report.nothingOpen")}</p>
        <Button className="mt-4" icon={<FolderOpen size={14} />} onClick={openReport}>
          {t("report.open")}
        </Button>
      </div>
    );
  }
  const created = new Date(r.created).toLocaleString(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { dateStyle: "long", timeStyle: "short" });
  const notes = summary(r, t);
  const findings = r.security?.findings.filter((f) => f.severity !== "info") ?? [];
  const failedTests = r.security?.hardening.tests.filter((x) => x.outcome === "fail") ?? [];
  const lastCooling = r.cooling[r.cooling.length - 1];
  const wifi = r.network?.wifi[0];
  const adapter = r.network?.adapters.find((a) => a.kind !== "vpn") ?? r.network?.adapters[0];
  const avgBoot = r.startup?.boots.length ? r.startup.boots.reduce((s, b) => s + b.totalMs, 0) / r.startup.boots.length : null;

  return (
    <div className="flex flex-col gap-5 pb-4" data-testid="report-view">
      <div className="flex items-center gap-2">
        <Button variant="quiet" icon={<ArrowLeft size={14} />} onClick={() => go("overview")}>
          {t("report.back")}
        </Button>
        <span className="num min-w-0 flex-1 truncate text-[0.6875rem] text-muted">{viewingFile}</span>
        <Button icon={<FolderOpen size={14} />} onClick={openReport}>
          {t("report.openOther")}
        </Button>
      </div>

      <Card>
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-raised text-accent">
            <Laptop size={24} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[1.25rem] font-semibold">{r.system?.hostName || t("report.unknownPc")}</h2>
            <p className="text-[0.75rem] text-muted">
              {[r.system && `${r.system.osName} ${r.system.osVersion}`, r.system?.cpuBrand, r.system && fmt.bytes(r.system.totalMemory)].filter(Boolean).join(" · ")}
            </p>
            <p className="mt-1 text-[0.6875rem] text-muted/80">
              {t("report.madeAt", { date: created, version: r.version })}
              {!r.elevated && ` · ${t("report.noAdmin")}`}
            </p>
          </div>
        </div>
        {r.note && (
          <div className="mt-4 flex gap-2.5 rounded-xl bg-accent/[0.07] px-4 py-3 text-[0.8125rem] leading-relaxed" data-testid="report-note">
            <MessageSquareQuote size={16} className="mt-0.5 shrink-0 text-accent" />
            <span>
              <span className="text-muted">{t("report.theyWrote")} </span>«{r.note}»
            </span>
          </div>
        )}
        <ul className="mt-4 space-y-1" data-testid="report-summary">
          {notes.map((n) => (
            <li key={n.text} className="flex items-start gap-2 text-[0.8125rem] leading-relaxed">
              <span className={`mt-[8px] h-1.5 w-1.5 shrink-0 rounded-full ${DOT[n.tone]}`} />
              <span className={n.tone === "good" ? "text-muted" : ""}>{n.text}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Section title={t("report.stability")} icon={<Activity size={12} />} empty={!r.quick}>
        {r.quick && <CheckList checks={r.quick.checks} />}
      </Section>

      <Section title={t("report.security")} icon={<ShieldHalf size={12} />} empty={!r.security}>
        {r.security && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="flex items-baseline gap-3 border-b border-line px-5 py-3 text-[0.8125rem]">
              <span className="font-medium">{t("report.securityScore", { score: r.security.hardening.score })}</span>
              <span className="text-[0.75rem] text-muted">{findings.length ? t("report.findings", { count: findings.length }) : t("security.verdictGood")}</span>
            </div>
            {findings.map((f) => (
              <div key={f.id} className="flex items-start gap-3 border-b border-line/60 px-5 py-2.5 last:border-b-0">
                <SeverityBadge severity={f.severity} />
                <div className="min-w-0 text-[0.75rem]">
                  <div className="truncate text-[0.8125rem] font-medium">{f.title}</div>
                  <div className="text-muted">{t(`security.kind.${f.kind}.title`)}</div>
                  <div className="mt-0.5 leading-relaxed text-muted/90">{t(`security.kind.${f.kind}.why`)}</div>
                </div>
              </div>
            ))}
            {failedTests.map((x) => (
              <div key={x.id} className="border-t border-line/60 px-5 py-2.5 text-[0.75rem]">
                <span className="font-medium text-warn">{t(`security.test.${x.id}.name`)}</span>
                <span className="text-muted"> — {t(`security.test.${x.id}.fail`)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("report.startup")} icon={<Rocket size={12} />} empty={!r.startup}>
        {r.startup && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <div className="border-b border-line px-5 py-3 text-[0.8125rem]">
              {t("report.startupCount", { count: r.startup.total })}
              {avgBoot !== null && <span className="text-muted"> · {t("report.bootAvg", { value: fmt.duration(avgBoot) })}</span>}
            </div>
            {r.startup.entries.slice(0, 15).map((e) => (
              <div key={e.id} className="grid grid-cols-[minmax(0,1fr)_7.5rem_5.625rem_6.875rem] items-center gap-3 border-b border-line/50 px-5 py-2 text-[0.75rem] last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate text-[0.8125rem]">{e.name}</div>
                  <div className="truncate text-[0.6875rem] text-muted">{e.publisher ?? e.program ?? ""}</div>
                </div>
                <span className={e.advice === "disable" ? "text-accent" : e.advice === "review" || e.advice === "broken" ? "text-warn" : "text-muted"}>{t(`startup.advice.${e.advice}`)}</span>
                <span className="text-muted">{t(`startup.impact.${e.impact}`)}</span>
                <span className="num text-right text-muted">{e.bootDelayMs ? `+${fmt.duration(e.bootDelayMs)}` : fmt.bytes(e.footprint.memory)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("report.network")} icon={<NetworkIcon size={12} />} empty={!r.network}>
        {r.network && (
          <div className="overflow-hidden rounded-card border border-line bg-surface text-[0.75rem]">
            <div className="border-b border-line px-5 py-3 text-[0.8125rem]">
              {wifi ? t("network.viaWifi", { ssid: wifi.ssid }) : adapter ? t("network.viaCable", { name: adapter.name }) : t("network.offline")}
              {wifi && <span className="text-muted"> · {t("network.signal", { value: wifi.signal })} · {t(`network.security.${wifi.security}`)}</span>}
            </div>
            {r.network.apps.filter((a) => a.concerns.length).map((a) => (
              <div key={a.pid} className="border-b border-line/60 px-5 py-2.5">
                <span className="font-medium text-warn">{a.description ?? a.name}</span>
                <ul className="mt-0.5 text-muted">
                  {a.concerns.map((c) => (
                    <li key={c}>{t(`network.concern.${c}`)}</li>
                  ))}
                </ul>
              </div>
            ))}
            {r.network.listeners.filter((l) => l.level === "app").length > 0 && (
              <div className="px-5 py-2.5 text-muted">
                {t("report.openPorts")}{" "}
                {[...new Set(r.network.listeners.filter((l) => l.level === "app").map((l) => `${l.name} (${l.port})`))].slice(0, 8).join(", ")}
              </div>
            )}
          </div>
        )}
      </Section>

      <Section title={t("report.processes")} icon={<ListTree size={12} />} empty={!r.processes}>
        {r.processes && (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {r.processes.map((p) => (
              <div key={p.name} className="grid grid-cols-[minmax(0,1fr)_5.625rem_4.375rem_5.625rem] items-center gap-3 border-b border-line/50 px-5 py-2 text-[0.75rem] last:border-b-0">
                <span className="truncate text-[0.8125rem]">{p.description || p.name}</span>
                <span className="text-muted">{p.count > 1 ? t("overview.procCount", { count: p.count }) : ""}</span>
                <span className="num text-right">{p.cpu.toFixed(1)}%</span>
                <span className="num text-right">{fmt.bytes(p.memory)}</span>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title={t("report.cooling")} icon={<Flame size={12} />} empty={!r.throttle && !lastCooling}>
        <div className="rounded-card border border-line bg-surface px-5 py-3.5 text-[0.75rem] leading-relaxed">
          {r.throttle && (
            <p>
              <Cpu size={12} className="mr-1 inline text-muted" />
              {t(`monitor.throttle.${r.throttle.state}`)}
              {r.throttle.temp ? ` · ${Math.round(r.throttle.temp)} °C` : ""}
              {r.throttle.mhz ? ` · ${(r.throttle.mhz / 1000).toFixed(2)} ${t("monitor.ghz")}` : ""}
            </p>
          )}
          {lastCooling ? (
            <p className="text-muted">
              {t("report.coolingLast", {
                plateau: Math.round(lastCooling.plateau),
                sustained: lastCooling.sustained !== null ? Math.round(lastCooling.sustained) : "—",
                thermal: lastCooling.thermalSeconds,
                runs: r.cooling.length,
              })}
            </p>
          ) : (
            <p className="text-muted">{t("report.noCooling")}</p>
          )}
        </div>
      </Section>
    </div>
  );
}
