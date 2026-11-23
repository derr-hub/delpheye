import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { Compass, Footprints, Smartphone, Unplug, Wifi } from "lucide-react";
import { Button } from "../../components/ui";
import { live, refreshPairing, routerBearing, startPairing, stopPairing, usePhone } from "../../lib/phone";

function Qr({ text }: { text: string }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    QRCode.toString(text, { type: "svg", margin: 1, color: { dark: "#0f1216", light: "#ffffff" } }).then(setSvg);
  }, [text]);
  return <div className="h-[12.5rem] w-[12.5rem] overflow-hidden rounded-xl bg-white p-2 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} data-testid="phone-qr" />;
}

/** The arrow points where the router is, turning as the phone turns. */
function LiveCompass() {
  const { t } = useTranslation();
  const frame = usePhone((s) => s.frame);
  const bearings = usePhone((s) => s.bearings);
  const est = useMemo(() => routerBearing(bearings), [bearings]);
  const heading = frame?.heading ?? null;
  const ready = est && Number.isFinite(est.angle);
  const rel = ready && heading !== null ? (((est!.angle - heading) % 360) + 360) % 360 : null;
  return (
    <div className="rounded-card border border-line bg-surface p-5" data-testid="phone-compass">
      <h3 className="flex items-center gap-2 text-[0.875rem] font-medium">
        <Compass size={16} className="text-accent" />
        {t("phone.compass.title")}
      </h3>
      <div className="mt-4 grid items-center gap-5 md:grid-cols-[240px_1fr]">
        <svg viewBox="-120 -120 240 240" className="mx-auto w-full max-w-[15rem]">
          <circle r={104} fill="none" stroke="var(--color-line)" strokeWidth={2} />
          {/* coverage of the turn so far */}
          <circle r={112} fill="none" stroke="var(--color-accent)" strokeWidth={4} strokeDasharray={`${(est?.coverage ?? 0) * 2 * Math.PI * 112} 9999`} transform="rotate(-90)" opacity={0.6} />
          {rel !== null ? (
            <motion.g animate={{ rotate: rel }} transition={{ type: "spring", stiffness: 70, damping: 14 }}>
              <path d="M 0 -92 L 18 -40 L 6 -44 L 6 30 L -6 30 L -6 -44 L -18 -40 Z" fill="var(--color-safe)" />
            </motion.g>
          ) : (
            <text textAnchor="middle" y={5} fontSize={13} fill="var(--color-muted)">
              {t("phone.compass.turning")}
            </text>
          )}
          <circle r={5} fill="var(--color-fg)" />
        </svg>
        <div>
          {rel !== null ? (
            <>
              <div className="font-display text-[1.25rem] font-semibold">{t("phone.compass.towards")}</div>
              <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">{t("phone.compass.how", { spread: est!.spread.toFixed(1) })}</p>
            </>
          ) : (
            <p className="text-[0.8125rem] leading-relaxed text-muted">{t("phone.compass.start", { pct: Math.round((est?.coverage ?? 0) * 100) })}</p>
          )}
          <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted">{t("phone.compass.note")}</p>
        </div>
      </div>
    </div>
  );
}

export function Phone() {
  const { t } = useTranslation();
  const { pairing, frame, error } = usePhone();
  const isLive = usePhone(live);
  const [, tick] = useState(0);
  const timer = useRef(0);

  useEffect(() => {
    refreshPairing().catch(() => {});
    timer.current = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer.current);
  }, []);

  if (!pairing || !pairing.code) {
    return (
      <div className="mx-auto grid max-w-[45rem] gap-4" data-testid="phone-intro">
        <div className="rounded-card border border-line bg-surface p-6">
          <Smartphone size={30} className="text-accent" />
          <h2 className="mt-3 font-display text-[1.1875rem] font-semibold">{t("phone.introTitle")}</h2>
          <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{t("phone.introText")}</p>
          <Button variant="primary" className="mt-5" onClick={startPairing} data-testid="phone-start">
            {t("phone.start")}
          </Button>
          {error && <p className="mt-3 text-[0.75rem] text-risk">{t("phone.error", { error })}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-4" data-testid="phone-page">
      <div className="grid gap-4 lg:grid-cols-[auto_1fr]">
        <div className="rounded-card border border-line bg-surface p-5">
          {pairing.paired ? (
            <div className="flex items-center gap-3">
              <span className={`flex h-12 w-12 items-center justify-center rounded-xl ${isLive ? "bg-safe/15 text-safe" : "bg-warn/15 text-warn"}`}>
                <Smartphone size={22} />
              </span>
              <div>
                <div className="font-display text-[1.0625rem] font-semibold">{pairing.device ?? t("phone.phone")}</div>
                <div className={`text-[0.75rem] ${isLive ? "text-safe" : "text-warn"}`}>{isLive ? t("phone.live") : t("phone.waiting")}</div>
              </div>
            </div>
          ) : (
            <div className="grid justify-items-center gap-3 text-center">
              <Qr text={pairing.link} />
              <div className="num font-display text-[1.75rem] font-semibold tracking-[0.25em]" data-testid="phone-code">
                {pairing.code}
              </div>
              <div className="num text-[0.75rem] text-muted">
                {pairing.addresses.join(" · ")} : {pairing.port}
              </div>
            </div>
          )}
          <Button variant="quiet" className="mt-4 w-full" icon={<Unplug size={14} />} onClick={stopPairing}>
            {t("phone.stop")}
          </Button>
        </div>
        <div className="rounded-card border border-line bg-surface p-5 text-[0.8125rem] leading-relaxed">
          {!pairing.paired ? (
            <>
              <h3 className="text-[0.875rem] font-medium">{t("phone.howTitle")}</h3>
              <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
                <li>{t("phone.how1")}</li>
                <li>{t("phone.how2")}</li>
                <li>{t("phone.how3")}</li>
                <li>{t("phone.how4")}</li>
              </ol>
              <p className="mt-3 text-[0.75rem] text-muted">{t("phone.firewall")}</p>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-3 text-center">
              {(
                [
                  [Compass, frame?.heading !== null && frame?.heading !== undefined ? `${Math.round(frame.heading)}°` : "—", t("phone.heading")],
                  [Footprints, frame ? String(frame.steps) : "—", t("phone.steps")],
                  [Wifi, frame?.linkRssi !== null && frame?.linkRssi !== undefined ? `${frame.linkRssi} dBm` : "—", t("phone.signal")],
                ] as const
              ).map(([Icon, v, l]) => (
                <div key={l} className="rounded-xl bg-raised/50 p-3">
                  <Icon size={16} className="mx-auto text-accent" />
                  <div className="num mt-1 font-display text-[1.25rem] font-semibold">{v}</div>
                  <div className="text-[0.6875rem] text-muted">{l}</div>
                </div>
              ))}
              <p className="col-span-3 text-left text-[0.75rem] text-muted">
                {t("phone.heard", { count: frame?.scan.length ?? 0, age: frame?.scanAt ? Math.max(0, Math.round((Date.now() - frame.scanAt) / 1000)) : "—" })}
              </p>
            </div>
          )}
        </div>
      </div>
      {pairing.paired && <LiveCompass />}
    </div>
  );
}
