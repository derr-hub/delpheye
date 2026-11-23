import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { CircleAlert, CircleCheck, Globe, Router, Wifi } from "lucide-react";
import { useWifi } from "../../lib/wifi";

interface Sample {
  t: number;
  router: number | null;
  internet: number | null;
}

const W = 1000;
const H = 260;
const M = { l: 46, r: 14, t: 16, b: 30 };
const SPAN = 5 * 60_000;
const MAX_MS = 300;

/** Latency, jitter (mean change between pings) and loss over a series. */
export function stats(xs: (number | null)[]) {
  const ok = xs.filter((x): x is number => x !== null);
  const loss = xs.length ? Math.round(((xs.length - ok.length) / xs.length) * 100) : 0;
  const avg = ok.length ? Math.round(ok.reduce((a, b) => a + b, 0) / ok.length) : null;
  const jitter = ok.length > 1 ? Math.round(ok.slice(1).reduce((a, b, i) => a + Math.abs(b - ok[i]), 0) / (ok.length - 1)) : null;
  const sorted = [...ok].sort((a, b) => a - b);
  const p95 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : null;
  return { avg, jitter, loss, p95, count: xs.length };
}

/** Which part of the path is the weak one. */
export function verdict(router: ReturnType<typeof stats>, internet: ReturnType<typeof stats>): "measuring" | "wifi" | "provider" | "good" {
  if (router.count < 8) return "measuring";
  // Packets to the internet cross Wi-Fi too: if they are fine, so is Wi-Fi — even when the router
  // itself answers pings slowly (routers reply to pings at low priority but forward at full speed).
  const internetBad = internet.loss > 3 || (internet.jitter ?? 0) > 40 || (internet.avg ?? 0) > 120;
  if (!internetBad) return "good";
  const routerBad = router.loss > 3 || (router.jitter ?? 0) > 40;
  return routerBad ? "wifi" : "provider";
}

export function Quality() {
  const { t } = useTranslation();
  const linkHistory = useWifi((s) => s.linkHistory);
  const [samples, setSamples] = useState<Sample[]>([]);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      while (alive) {
        const started = Date.now();
        try {
          const q = await invoke<{ routerMs: number | null; internetMs: number | null; connected: boolean }>("wifi_quality");
          setConnected(q.connected);
          if (q.connected) setSamples((s) => [...s.filter((x) => Date.now() - x.t < SPAN), { t: Date.now(), router: q.routerMs, internet: q.internetMs }]);
        } catch {
          /* next round */
        }
        await new Promise((r) => setTimeout(r, Math.max(300, 1500 - (Date.now() - started))));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const r = useMemo(() => stats(samples.map((s) => s.router)), [samples]);
  const i = useMemo(() => stats(samples.map((s) => s.internet)), [samples]);
  const v = verdict(r, i);
  const now = Date.now();
  const x = (t0: number) => M.l + ((t0 - (now - SPAN)) / SPAN) * (W - M.l - M.r);
  // A square-root scale: small delays stay readable next to the odd large spike.
  const y = (ms: number) => M.t + (1 - Math.sqrt(Math.min(ms, MAX_MS) / MAX_MS)) * (H - M.t - M.b);
  const line = (key: "router" | "internet") =>
    samples
      .map((s, k) => (s[key] === null ? null : `${k && samples[k - 1][key] !== null ? "L" : "M"} ${x(s.t).toFixed(1)} ${y(s[key]!).toFixed(1)}`))
      .filter(Boolean)
      .join(" ");

  if (!connected)
    return (
      <div className="rounded-card border border-line bg-surface p-6 text-center text-[0.8125rem] text-muted" data-testid="wifi-quality-off">
        {t("wifi.quality.notConnected")}
      </div>
    );

  const tone = v === "good" ? "text-safe" : v === "measuring" ? "text-muted" : "text-warn";
  const Icon = v === "good" ? CircleCheck : CircleAlert;
  return (
    <div className="grid gap-4" data-testid="wifi-quality">
      <div className="flex gap-3 rounded-card border border-line bg-surface px-5 py-4">
        <Icon size={20} className={`mt-0.5 shrink-0 ${tone}`} />
        <div>
          <div className="text-[0.875rem] font-medium">{t(`wifi.quality.verdict.${v}.title`)}</div>
          <div className="mt-0.5 text-[0.75rem] leading-relaxed text-muted">{t(`wifi.quality.verdict.${v}.text`)}</div>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {(
          [
            ["router", Router, r, "var(--color-accent)"],
            ["internet", Globe, i, "#F5A35C"],
          ] as const
        ).map(([key, Ico, st, colour]) => (
          <div key={key} className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-[0.75rem] text-muted">
              <Ico size={14} style={{ color: colour }} />
              {t(`wifi.quality.${key}`)}
            </div>
            <div className="num mt-2 font-display text-[1.625rem] font-semibold leading-none">
              {st.avg ?? "—"}
              <span className="ml-1 text-[0.75rem] text-muted">{t("wifi.quality.ms")}</span>
            </div>
            <div className="num mt-2 text-[0.6875rem] text-muted">
              {t("wifi.quality.jitter")} {st.jitter ?? "—"} {t("wifi.quality.ms")} · {t("wifi.quality.loss")} {st.loss}%
            </div>
          </div>
        ))}
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-[0.75rem] text-muted">
            <Wifi size={14} className="text-safe" />
            {t("wifi.quality.signal")}
          </div>
          <div className="num mt-2 font-display text-[1.625rem] font-semibold leading-none">
            {linkHistory.length ? linkHistory[linkHistory.length - 1].rssi : "—"}
            <span className="ml-1 text-[0.75rem] text-muted">dBm</span>
          </div>
          <div className="mt-2 text-[0.6875rem] text-muted">{t("wifi.quality.signalHint")}</div>
        </div>
      </div>
      <div className="rounded-card border border-line bg-surface p-4">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("wifi.quality.chart")}>
          {[5, 20, 50, 100, 200, 300].map((ms) => (
            <g key={ms}>
              <line x1={M.l} x2={W - M.r} y1={y(ms)} y2={y(ms)} stroke="var(--color-line)" opacity={0.6} />
              <text x={M.l - 8} y={y(ms) + 3} textAnchor="end" fontSize={10} className="num" fill="var(--color-muted)">
                {ms}
              </text>
            </g>
          ))}
          {[5, 4, 3, 2, 1, 0].map((m) => (
            <text key={m} x={x(now - m * 60_000)} y={H - 8} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
              {m === 0 ? t("wifi.adv.now") : t("wifi.adv.minAgo", { n: m })}
            </text>
          ))}
          {samples.map((s) =>
            s.router === null ? <line key={`l${s.t}`} x1={x(s.t)} x2={x(s.t)} y1={M.t} y2={H - M.b} stroke="var(--color-risk)" strokeWidth={2} opacity={0.6} /> : null,
          )}
          <path d={line("internet")} fill="none" stroke="#F5A35C" strokeWidth={2} strokeLinejoin="round" />
          <path d={line("router")} fill="none" stroke="var(--color-accent)" strokeWidth={2} strokeLinejoin="round" />
        </svg>
        <div className="mt-2 flex flex-wrap gap-4 text-[0.6875rem] text-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-accent" /> {t("wifi.quality.router")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-[#F5A35C]" /> {t("wifi.quality.internet")}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-3 w-0.5 rounded bg-risk" /> {t("wifi.quality.lost")}
          </span>
          <span className="ml-auto">{t("wifi.quality.hint")}</span>
        </div>
      </div>
    </div>
  );
}
