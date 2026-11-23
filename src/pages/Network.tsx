import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowUp,
  Cable,
  CheckCircle2,
  ChevronDown,
  DoorOpen,
  Gauge,
  Globe,
  Lock,
  LockOpen,
  Network as NetworkIcon,
  Router,
  ShieldAlert,
  ShieldCheck,
  Wifi as WifiIcon,
} from "lucide-react";
import { Button, Card } from "../components/ui";
import { LineChart, SERIES_COLORS } from "../components/LineChart";
import { go, relaunchElevated } from "../lib/app";
import { useFmt } from "../lib/format";
import { useMetrics } from "../lib/metrics";
import { KNOWN_DNS, runCheck, startNetworkPolling, useNetwork, type Adapter, type NetApp, type Probe } from "../lib/network";
import { ensureIcons, keyOf, useProcesses, type Proc } from "../lib/processes";
import { ProcIcon, displayName } from "./Processes";

const asProc = (a: { pid: number; start: number; name: string; exe: string | null; description: string | null; level: Proc["level"] }) =>
  ({ ...a, kind: "background", company: null, window: null, services: [] }) as unknown as Proc;

function useRate() {
  const fmt = useFmt();
  const { t } = useTranslation();
  return (bytes: number | null | undefined) => (bytes === null || bytes === undefined ? "—" : `${fmt.bytes(bytes)}/${t("processes.perSecond")}`);
}

function bits(bitsPerSecond: number, t: (k: string) => string) {
  if (!bitsPerSecond) return "—";
  return bitsPerSecond >= 1e9 ? `${(bitsPerSecond / 1e9).toFixed(1)} ${t("network.gbit")}` : `${Math.round(bitsPerSecond / 1e6)} ${t("network.mbit")}`;
}

function SignalBars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-end gap-[2px]" aria-hidden>
      {[25, 50, 75, 100].map((step, i) => (
        <span key={step} className={`w-[3px] rounded-sm ${value >= step - 12 ? "bg-safe" : "bg-raised"}`} style={{ height: 4 + i * 3 }} />
      ))}
    </span>
  );
}

function Chip({ children, tone = "bg-raised text-muted" }: { children: ReactNode; tone?: string }) {
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[0.6875rem] ${tone}`}>{children}</span>;
}

function Connection() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const snap = useNetwork((s) => s.snapshot);
  const current = useMetrics((s) => s.current);
  const history = useMetrics((s) => s.history);
  const active = snap?.adapters.find((a) => a.up && a.kind !== "vpn" && a.gateways.length > 0) ?? snap?.adapters.find((a) => a.up && a.kind !== "vpn");
  const vpn = snap?.adapters.find((a) => a.up && a.kind === "vpn");
  const wifi = snap?.wifi[0];
  const Icon = active?.kind === "wifi" ? WifiIcon : active ? Cable : NetworkIcon;
  return (
    <section className="reveal rounded-card border border-line bg-surface p-5" data-testid="net-connection">
      <div className="flex items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-raised text-accent">
          <Icon size={24} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[1.25rem] font-semibold leading-tight">
            {!snap ? t("network.loading") : !active ? t("network.offline") : wifi ? t("network.viaWifi", { ssid: wifi.ssid }) : t("network.viaCable", { name: active.name })}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {wifi && (
              <Chip>
                <SignalBars value={wifi.signal} />
                {t("network.signal", { value: wifi.signal })}
              </Chip>
            )}
            {wifi?.generation && <Chip>Wi-Fi {wifi.generation}</Chip>}
            {active && <Chip>{wifi ? t("network.linkWifi", { rx: wifi.rxMbps, tx: wifi.txMbps }) : bits(active.speed, t)}</Chip>}
            {wifi && (
              <Chip tone={wifi.security === "open" || wifi.security === "wep" ? "bg-risk/10 text-risk" : "bg-raised text-muted"}>
                {wifi.security === "open" || wifi.security === "wep" ? <LockOpen size={11} /> : <Lock size={11} />}
                {t(`network.security.${wifi.security}`)}
              </Chip>
            )}
            {vpn && (
              <Chip tone="bg-accent/10 text-accent">
                <ShieldCheck size={11} />
                {t("network.vpnOn", { name: vpn.name })}
              </Chip>
            )}
          </div>
          {wifi && wifi.signal < 40 && <p className="mt-2 text-[0.75rem] text-warn">{t("network.weakSignal")}</p>}
          {wifi && (wifi.security === "open" || wifi.security === "wep") && <p className="mt-2 text-[0.75rem] text-risk">{t("network.openWifi")}</p>}
        </div>
        <div className="grid shrink-0 grid-cols-2 gap-5 text-right">
          <div>
            <div className="flex items-center justify-end gap-1 text-[0.6875rem] text-muted">
              <ArrowDown size={12} className="text-accent" />
              {t("overview.download")}
            </div>
            <div className="num text-[1.125rem]">{fmt.bytes(current?.netRx ?? 0)}/s</div>
          </div>
          <div>
            <div className="flex items-center justify-end gap-1 text-[0.6875rem] text-muted">
              <ArrowUp size={12} className="text-safe" />
              {t("overview.upload")}
            </div>
            <div className="num text-[1.125rem]">{fmt.bytes(current?.netTx ?? 0)}/s</div>
          </div>
        </div>
      </div>
      <div className="mt-4">
        <LineChart
          series={[
            { id: "rx", name: t("overview.download"), color: SERIES_COLORS[0], values: history.rx },
            { id: "tx", name: t("overview.upload"), color: SERIES_COLORS[2], values: history.tx },
          ]}
          format={(v) => (v < 1024 ? `${Math.round(v)} B` : v < 1024 * 1024 ? `${Math.round(v / 1024)} K` : `${(v / 1048576).toFixed(1)} M`)}
          points={60}
          minRange={64 * 1024}
          floor={0}
          height={200}
          label={t("network.traffic")}
        />
        <p className="mt-1 text-right text-[0.6875rem] text-muted">{t("network.lastMinute")}</p>
      </div>
    </section>
  );
}

function ProbeRow({ label, probe, hint }: { label: string; probe: Probe | null | undefined; hint: string }) {
  const { t } = useTranslation();
  const ms = probe?.avgMs;
  const tone = ms === null || ms === undefined ? "text-risk" : ms > 100 || (probe?.loss ?? 0) > 0 ? "text-warn" : "text-safe";
  return (
    <div className="rounded-xl bg-raised/50 px-3.5 py-3">
      <div className="text-[0.6875rem] text-muted">{label}</div>
      <div className={`num text-[1.125rem] ${probe ? tone : "text-muted"}`}>{!probe ? "—" : ms === null ? t("network.noAnswer") : `${ms} ${t("network.ms")}`}</div>
      <div className="text-[0.6875rem] text-muted/80">{probe && probe.loss > 0 ? t("network.loss", { value: probe.loss }) : hint}</div>
    </div>
  );
}

function CheckCard() {
  const { t } = useTranslation();
  const { check, checking } = useNetwork();
  return (
    <Card title={t("network.checkTitle")} icon={<Gauge size={15} />}>
      <p className="mb-3 max-w-[90ch] text-[0.75rem] leading-relaxed text-muted">{t("network.checkIntro")}</p>
      {check && (
        <div className="mb-3 space-y-3" data-testid="net-check">
          <div className="grid grid-cols-4 gap-3">
            <ProbeRow label={t("network.router")} probe={check.gateway} hint={check.gateway?.target ?? ""} />
            <ProbeRow label="Cloudflare" probe={check.internet[0]} hint="1.1.1.1" />
            <ProbeRow label="Google" probe={check.internet[1]} hint="8.8.8.8" />
            <ProbeRow label={t("network.dns")} probe={check.dnsMs !== null ? { target: "", avgMs: check.dnsMs, loss: 0 } : { target: "", avgMs: null, loss: 0 }} hint={t("network.dnsHint")} />
          </div>
          <p className={`flex gap-2 text-[0.8125rem] leading-relaxed ${check.verdict === "good" ? "text-safe" : "text-warn"}`}>
            {check.verdict === "good" ? <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> : <ShieldAlert size={16} className="mt-0.5 shrink-0" />}
            {t(`network.verdict.${check.verdict}`)}
          </p>
        </div>
      )}
      <Button variant={check ? "ghost" : "primary"} onClick={runCheck} disabled={checking} data-testid="net-check-run">
        {checking ? t("network.checking") : check ? t("network.checkAgain") : t("network.checkRun")}
      </Button>
    </Card>
  );
}

function ConnectionList({ app }: { app: NetApp }) {
  const { t } = useTranslation();
  const rate = useRate();
  return (
    <ul className="space-y-1 border-t border-line/60 bg-bg/40 px-5 py-3 text-[0.75rem]">
      {app.connections.map((c, i) => (
        <li key={`${c.remote}-${i}`} className="grid grid-cols-[minmax(0,1fr)_120px_90px_90px] items-center gap-3">
          <span className="min-w-0 truncate">
            <span className={c.host ? "" : "num text-[0.6875rem]"}>{c.host ?? c.ip}</span>
            {c.host && <span className="num ml-2 text-[0.6875rem] text-muted">{c.ip}</span>}
          </span>
          <span className="text-muted">
            <span className="num">{c.port}</span>
            {c.service && ` · ${t(`network.service.${c.service}`)}`}
          </span>
          <span className={`text-[0.6875rem] ${c.public ? "text-muted" : "text-accent"}`}>{c.public ? t("network.internet") : t("network.local")}</span>
          <span className="num text-right text-muted">{c.rx !== null ? `↓ ${rate(c.rx)}` : ""}</span>
        </li>
      ))}
    </ul>
  );
}

function AppRow({ app }: { app: NetApp }) {
  const { t } = useTranslation();
  const rate = useRate();
  const open = useNetwork((s) => !!s.open[app.pid]);
  const proc = asProc(app);
  const hosts = [...new Set(app.connections.filter((c) => c.public).map((c) => c.host?.split(".").slice(-2).join(".") ?? c.ip))].slice(0, 3);
  const publicCount = app.connections.filter((c) => c.public).length;
  return (
    <div className="border-b border-line/50 last:border-b-0" data-testid={`net-app-${app.pid}`}>
      <button
        className="grid w-full grid-cols-[minmax(0,1fr)_80px_96px_96px_20px] items-center gap-3 px-5 py-2.5 text-left hover:bg-raised/40"
        onClick={() => useNetwork.setState((s) => ({ open: { ...s.open, [app.pid]: !open } }))}
        aria-expanded={open}
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <ProcIcon proc={proc} size={18} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-[0.8125rem]">
              <span className="truncate">{displayName(proc)}</span>
              {app.concerns.length > 0 && <ShieldAlert size={13} className="shrink-0 text-warn" />}
            </span>
            <span className="block truncate text-[0.6875rem] text-muted">{hosts.length ? hosts.join(", ") : t("network.onlyLocal")}</span>
          </span>
        </span>
        <span className="num text-right text-[0.75rem]" title={t("network.connectionsHint")}>
          {publicCount}
          <span className="text-muted">/{app.connections.length}</span>
        </span>
        <span className="num text-right text-[0.75rem]">{app.rx !== null ? rate(app.rx) : "—"}</span>
        <span className="num text-right text-[0.75rem]">{app.tx !== null ? rate(app.tx) : "—"}</span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="text-muted">
          <ChevronDown size={14} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} transition={{ type: "spring", stiffness: 400, damping: 38 }} className="overflow-hidden">
            <ConnectionList app={app} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Concerns({ apps }: { apps: NetApp[] }) {
  const { t } = useTranslation();
  const flagged = apps.filter((a) => a.concerns.length > 0);
  if (!flagged.length) {
    return (
      <div className="flex items-start gap-3 rounded-card border border-safe/20 bg-safe/[0.05] px-5 py-3.5 text-[0.8125rem]" data-testid="net-concerns-none">
        <ShieldCheck size={18} className="mt-0.5 shrink-0 text-safe" />
        <span className="leading-relaxed">{t("network.noConcerns")}</span>
      </div>
    );
  }
  return (
    <section className="rounded-card border border-warn/25 bg-warn/[0.05] p-5" data-testid="net-concerns">
      <h2 className="mb-1 flex items-center gap-2 font-display text-[1rem] font-semibold">
        <ShieldAlert size={17} className="text-warn" />
        {t("network.concernsTitle")}
      </h2>
      <p className="mb-3 text-[0.75rem] leading-relaxed text-muted">{t("network.concernsIntro")}</p>
      <ul className="space-y-3">
        {flagged.map((app) => {
          const proc = asProc(app);
          return (
            <li key={app.pid} className="rounded-xl bg-surface/70 px-4 py-3">
              <div className="flex items-center gap-2.5">
                <ProcIcon proc={proc} size={18} />
                <span className="flex-1 text-[0.8125rem] font-medium">{displayName(proc)}</span>
                <Button
                  variant="quiet"
                  onClick={() => {
                    useProcesses.setState({ selected: keyOf(app) });
                    go("processes");
                  }}
                >
                  {t("network.openProcess")}
                </Button>
              </div>
              <ul className="mt-1.5 space-y-1 pl-7 text-[0.75rem] leading-relaxed text-muted">
                {app.concerns.map((c) => (
                  <li key={c}>{t(`network.concern.${c}`)}</li>
                ))}
                <li className="num text-[0.6875rem]">{app.connections.filter((c) => c.public).slice(0, 4).map((c) => c.host ?? c.remote).join(" · ")}</li>
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Programs come and go every few seconds; keep the list calm: rows keep their place, a program
 * that vanished lingers briefly, and the order by activity is refreshed only every ten seconds. */
function useCalmApps(apps: NetApp[] | undefined): NetApp[] {
  const seen = useRef(new Map<number, { app: NetApp; first: number; last: number }>());
  const [order, setOrder] = useState<number[]>([]);
  const sortedAt = useRef(0);
  const now = Date.now();
  for (const app of apps ?? []) {
    const old = seen.current.get(app.pid);
    seen.current.set(app.pid, { app, first: old?.first ?? now, last: now });
  }
  for (const [pid, entry] of seen.current) if (now - entry.last > 15_000) seen.current.delete(pid);
  const activity = (a: NetApp) => (a.rx ?? 0) + (a.tx ?? 0) + a.connections.filter((c) => c.public).length * 64;
  useEffect(() => {
    if (Date.now() - sortedAt.current < 10_000 && order.length) {
      // Between re-sorts only new programs are added, at the end.
      const missing = [...seen.current.keys()].filter((pid) => !order.includes(pid));
      const kept = order.filter((pid) => seen.current.has(pid));
      if (missing.length || kept.length !== order.length) setOrder([...kept, ...missing]);
      return;
    }
    sortedAt.current = Date.now();
    setOrder([...seen.current.values()].sort((a, b) => activity(b.app) - activity(a.app) || a.first - b.first).map((e) => e.app.pid));
  }, [apps]); // eslint-disable-line react-hooks/exhaustive-deps
  return order.map((pid) => seen.current.get(pid)).filter((e): e is NonNullable<typeof e> => !!e).map((e) => (now - e.last > 2500 ? { ...e.app, connections: [], rx: e.app.rx === null ? null : 0, tx: e.app.tx === null ? null : 0 } : e.app));
}

function Apps() {
  const { t } = useTranslation();
  const snap = useNetwork((s) => s.snapshot);
  const apps = useCalmApps(snap?.apps);
  if (!snap) return null;
  return (
    <section>
      <h2 className="mb-2 flex items-baseline justify-between px-1 text-[0.6875rem] uppercase tracking-wider text-muted">
        {t("network.appsTitle")}
        <span className="normal-case tracking-normal">{t("network.appsCount", { count: apps.length })}</span>
      </h2>
      {!snap.elevated && (
        <div className="mb-2 flex items-center gap-3 rounded-card border border-line bg-surface px-5 py-3 text-[0.75rem] text-muted">
          <span className="flex-1 leading-relaxed">{t("network.trafficNeedsAdmin")}</span>
          <Button onClick={() => relaunchElevated()}>{t("cleanup.adminAction")}</Button>
        </div>
      )}
      <div className="overflow-clip rounded-card border border-line bg-surface">
        <div className="grid grid-cols-[minmax(0,1fr)_80px_96px_96px_20px] gap-3 border-b border-line px-5 py-2 text-[0.6875rem] uppercase tracking-wider text-muted">
          <span>{t("network.program")}</span>
          <span className="text-right" title={t("network.connectionsHint")}>
            {t("network.connections")}
          </span>
          <span className="text-right">↓ {t("network.receives")}</span>
          <span className="text-right">↑ {t("network.sends")}</span>
          <span />
        </div>
        <div className="max-h-[28.75rem] overflow-y-auto">
          {apps.map((app) => (
            <motion.div key={app.pid} layout="position" transition={{ type: "spring", stiffness: 260, damping: 32 }}>
              <AppRow app={app} />
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Ports() {
  const { t } = useTranslation();
  const snap = useNetwork((s) => s.snapshot);
  const exposed = useMemo(() => {
    const seen = new Map<string, { name: string; exe: string | null; level: Proc["level"]; ports: number[]; pid: number }>();
    for (const l of snap?.listeners.filter((l) => l.exposed) ?? []) {
      const key = `${l.pid}`;
      const entry = seen.get(key) ?? { name: l.name, exe: l.exe, level: l.level, ports: [], pid: l.pid };
      if (!entry.ports.includes(l.port)) entry.ports.push(l.port);
      seen.set(key, entry);
    }
    return [...seen.values()].sort((a, b) => Number(a.level !== "app") - Number(b.level !== "app"));
  }, [snap]);
  const localOnly = new Set(snap?.listeners.filter((l) => !l.exposed).map((l) => l.pid)).size;
  if (!snap) return null;
  return (
    <Card title={t("network.portsTitle")} icon={<DoorOpen size={15} />}>
      <p className="mb-3 max-w-[95ch] text-[0.75rem] leading-relaxed text-muted">{t("network.portsIntro")}</p>
      <ul className="space-y-1.5 text-[0.75rem]">
        {exposed.map((e) => {
          const proc = asProc({ pid: e.pid, start: 0, name: e.name, exe: e.exe, description: null, level: e.level });
          return (
            <li key={e.pid} className="flex items-center gap-2.5">
              <ProcIcon proc={proc} size={16} />
              <span className="min-w-0 flex-1 truncate">{displayName(proc)}</span>
              <span className={`rounded-full px-2 py-0.5 text-[0.6875rem] ${e.level === "app" ? "bg-warn/10 text-warn" : "bg-raised text-muted"}`}>{t(`processes.level.${e.level}`)}</span>
              <span className="num w-40 truncate text-right text-muted">{e.ports.sort((a, b) => a - b).slice(0, 6).join(", ")}</span>
            </li>
          );
        })}
      </ul>
      {localOnly > 0 && <p className="mt-3 text-[0.6875rem] text-muted">{t("network.localOnly", { count: localOnly })}</p>}
    </Card>
  );
}

function AdapterCard({ a }: { a: Adapter }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const Icon = a.kind === "wifi" ? WifiIcon : a.kind === "vpn" ? ShieldCheck : a.kind === "ethernet" ? Cable : Router;
  return (
    <div className={`reveal rounded-card border border-line bg-surface p-4 ${a.up ? "" : "opacity-60"}`}>
      <div className="mb-2 flex items-center gap-2">
        <Icon size={15} className={a.up ? "text-accent" : "text-muted"} />
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium">{a.name}</span>
        <span className={`text-[0.6875rem] ${a.up ? "text-safe" : "text-muted"}`}>{a.up ? t("network.up") : t("network.down")}</span>
      </div>
      <p className="mb-2 truncate text-[0.6875rem] text-muted" title={a.description}>
        {t(`network.kind.${a.kind}`)} · {a.description}
      </p>
      <dl className="grid grid-cols-[96px_1fr] gap-x-3 gap-y-1 text-[0.75rem]">
        {a.up && (
          <>
            <dt className="text-muted">{t("network.speed")}</dt>
            <dd className="num">{bits(a.speed, t)}</dd>
          </>
        )}
        {a.ipv4.length > 0 && (
          <>
            <dt className="text-muted">IPv4</dt>
            <dd className="num select-text">{a.ipv4.join(", ")}</dd>
          </>
        )}
        {a.gateways.length > 0 && (
          <>
            <dt className="text-muted">{t("network.router")}</dt>
            <dd className="num select-text">{a.gateways.filter((g) => !g.includes(":")).join(", ") || a.gateways[0]}</dd>
          </>
        )}
        {a.dns.length > 0 && (
          <>
            <dt className="text-muted">DNS</dt>
            <dd className="num select-text">
              {a.dns.slice(0, 3).map((d) => (KNOWN_DNS[d] ? `${d} (${KNOWN_DNS[d]})` : d)).join(", ")}
            </dd>
          </>
        )}
        {a.mac && (
          <>
            <dt className="text-muted">MAC</dt>
            <dd className="num select-text">{a.mac}</dd>
          </>
        )}
        {(a.received > 0 || a.sent > 0) && (
          <>
            <dt className="text-muted">{t("network.sinceBoot")}</dt>
            <dd className="num">
              ↓ {fmt.bytes(a.received)} · ↑ {fmt.bytes(a.sent)}
            </dd>
          </>
        )}
      </dl>
    </div>
  );
}

export function Network() {
  const { t } = useTranslation();
  const { snapshot, error } = useNetwork();
  useEffect(() => startNetworkPolling(), []);
  useEffect(() => {
    if (snapshot) ensureIcons([...snapshot.apps.map((a) => a.exe), ...snapshot.listeners.map((l) => l.exe)]);
  }, [snapshot]);
  const adapters = snapshot?.adapters.filter((a) => a.up || a.received > 0) ?? [];
  return (
    <div className="flex flex-col gap-4 pb-2">
      <Connection />
      {error && <p className="px-1 text-[0.75rem] text-risk">{error}</p>}
      {snapshot && <Concerns apps={snapshot.apps} />}
      <Apps />
      <CheckCard />
      <Ports />
      {adapters.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-1.5 px-1 text-[0.6875rem] uppercase tracking-wider text-muted">
            <Globe size={12} />
            {t("network.adaptersTitle")}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            {adapters.map((a) => (
              <AdapterCard key={a.index} a={a} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
