import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { CircleAlert, CircleCheck, Info, Lock, LockOpen, ShieldAlert, Wifi as WifiIcon } from "lucide-react";
import { Ring } from "../../components/ui";
import { BAND_COLORS, LEVEL_COLOR, nameOf, percent, signalLevel, useWifi, type Analysis, type Bss } from "../../lib/wifi";

/** Four bars, filled by signal level. */
export function Bars({ rssi, size = 16 }: { rssi: number; size?: number }) {
  const level = signalLevel(rssi);
  const filled = { excellent: 4, good: 3, fair: 2, weak: 1, bad: 1 }[level];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={1 + i * 4} y={12 - i * 3.3} width={2.6} height={3 + i * 3.3} rx={1} fill={i < filled ? LEVEL_COLOR[level] : "var(--color-line)"} />
      ))}
    </svg>
  );
}

const CONGESTION_STEPS = ["free", "moderate", "busy", "crowded"] as const;

function Hero() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const link = useWifi((s) => s.link) ?? snap.link;
  const own = snap.analysis?.own;
  const bss = snap.networks.find((b) => b.connected);
  if (!link || !own || !bss)
    return (
      <div className="rounded-card border border-line bg-surface p-6 text-center" data-testid="wifi-not-connected">
        <WifiIcon size={28} className="mx-auto text-muted" />
        <h2 className="mt-3 font-display text-[1.0625rem] font-semibold">{t("wifi.simple.notConnected")}</h2>
        <p className="mt-1 text-[0.8125rem] text-muted">{t("wifi.simple.notConnectedText", { count: snap.networks.length })}</p>
      </div>
    );
  const rssi = link.rssi || own.rssi;
  const level = signalLevel(rssi);
  const congestion = CONGESTION_STEPS.indexOf(own.congestion);
  return (
    <div className="grid gap-4 rounded-card border border-line bg-surface p-5 md:grid-cols-[auto_1fr]" data-testid="wifi-hero">
      <Ring value={percent(rssi)} color={LEVEL_COLOR[level]} size={164} stroke={11}>
        <span className="num font-display text-[2.125rem] font-semibold leading-none">{percent(rssi)}%</span>
        <span className="num mt-1 text-[0.6875rem] text-muted">{rssi} dBm</span>
      </Ring>
      <div className="min-w-0">
        <div className="text-[0.6875rem] uppercase tracking-wide text-muted">{t("wifi.simple.connectedTo")}</div>
        <h2 className="truncate font-display text-[1.375rem] font-semibold">{link.ssid}</h2>
        <p className="mt-1 text-[0.875rem]" style={{ color: LEVEL_COLOR[level] }}>
          {t(`wifi.signal.${level}`)}
        </p>
        <p className="mt-0.5 text-[0.75rem] leading-relaxed text-muted">{t(`wifi.signalText.${level}`)}</p>
        <div className="mt-3 flex flex-wrap gap-1.5 text-[0.6875rem]">
          <span className="rounded-md px-2 py-1" style={{ background: `${BAND_COLORS[bss.band]}22`, color: BAND_COLORS[bss.band] }}>
            {bss.band} {t("wifi.ghz")}
          </span>
          <span className="rounded-md bg-raised px-2 py-1">{t("wifi.channelN", { n: bss.channel })} · {bss.width} {t("wifi.mhz")}</span>
          {bss.generation > 0 && <span className="rounded-md bg-raised px-2 py-1">Wi-Fi {bss.generation}</span>}
          <span className="num rounded-md bg-raised px-2 py-1">
            ↓ {link.rxMbps} · ↑ {link.txMbps} {t("wifi.mbps")}
          </span>
          <span className="rounded-md bg-raised px-2 py-1">{t(`wifi.security.${bss.security}`)}</span>
        </div>
        <div className="mt-4">
          <div className="flex items-baseline justify-between text-[0.75rem]">
            <span className="text-muted">{t("wifi.simple.neighbours")}</span>
            <span>{t(`wifi.congestion.${own.congestion}`)}</span>
          </div>
          <div className="mt-1.5 grid grid-cols-4 gap-1">
            {CONGESTION_STEPS.map((step, i) => (
              <motion.span
                key={step}
                className="h-1.5 rounded-full"
                initial={false}
                animate={{ backgroundColor: i <= congestion ? ["var(--color-safe)", "var(--color-safe)", "var(--color-warn)", "var(--color-risk)"][congestion] : "var(--color-raised)" }}
              />
            ))}
          </div>
          <p className="mt-1.5 text-[0.6875rem] text-muted">{own.overlapping ? t("wifi.simple.overlapping", { count: own.overlapping }) : t("wifi.simple.overlappingNone")}</p>
        </div>
      </div>
    </div>
  );
}

const ADVICE_ICON = { ok: CircleCheck, info: Info, warn: CircleAlert, risk: ShieldAlert } as const;
const ADVICE_TONE = { ok: "text-safe", info: "text-accent", warn: "text-warn", risk: "text-risk" } as const;

export function AdviceList({ analysis }: { analysis: Analysis }) {
  const { t } = useTranslation();
  const order = { risk: 0, warn: 1, info: 2, ok: 3 };
  const items = [...analysis.advice].sort((a, b) => order[a.level] - order[b.level]);
  return (
    <div className="grid gap-2" data-testid="wifi-advice">
      {items.map((a) => {
        const Icon = ADVICE_ICON[a.level];
        return (
          <div key={a.id} className="flex gap-3 rounded-card border border-line bg-surface px-4 py-3">
            <Icon size={18} className={`mt-0.5 shrink-0 ${ADVICE_TONE[a.level]}`} />
            <div className="min-w-0">
              <div className="text-[0.8125rem] font-medium">{t(`wifi.advice.${a.id}.title`, a.values)}</div>
              <div className="mt-0.5 text-[0.75rem] leading-relaxed text-muted">{t(`wifi.advice.${a.id}.text`, a.values)}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Around() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const a = snap.analysis!;
  // One row per network name: its loudest access point.
  const byName = new Map<string, Bss>();
  for (const b of snap.networks) {
    const key = b.hidden ? b.bssid : b.ssid;
    const cur = byName.get(key);
    if (!cur || cur.rssi < b.rssi || b.connected) byName.set(key, b);
  }
  const rows = [...byName.values()].sort((x, y) => Number(y.connected) - Number(x.connected) || y.rssi - x.rssi).slice(0, 12);
  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
        <h3 className="text-[0.8125rem] font-medium">{t("wifi.simple.around")}</h3>
        <span className="text-[0.6875rem] text-muted">{t("wifi.simple.aroundStats", { names: a.names, total: a.total })}</span>
      </div>
      <ul>
        {rows.map((b) => (
          <li key={b.bssid} className="flex items-center gap-3 border-b border-line/60 px-4 py-2 last:border-b-0" data-testid="wifi-around-row">
            <Bars rssi={b.rssi} />
            <span className={`min-w-0 flex-1 truncate text-[0.8125rem] ${b.hidden ? "italic text-muted" : ""}`}>{nameOf(b, t("wifi.hidden"))}</span>
            {b.connected && <span className="rounded bg-accent/15 px-1.5 text-[0.625rem] text-accent">{t("wifi.yours")}</span>}
            {!b.connected && a.mine.includes(b.bssid) && <span className="rounded bg-raised px-1.5 text-[0.625rem] text-muted">{t("wifi.yourRouter")}</span>}
            <span className="w-12 text-right text-[0.6875rem]" style={{ color: BAND_COLORS[b.band] }}>
              {b.band}
            </span>
            {b.security === "open" ? <LockOpen size={13} className="text-warn" /> : <Lock size={13} className="text-muted" />}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Simple() {
  const snap = useWifi((s) => s.snap)!;
  return (
    <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
      <div className="grid content-start gap-4">
        <Hero />
        {snap.analysis && <AdviceList analysis={snap.analysis} />}
      </div>
      <Around />
    </div>
  );
}
