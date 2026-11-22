import { useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Compass, RotateCw, Square } from "lucide-react";
import { Button } from "../../components/ui";
import { isLive, measure } from "../../lib/wifi";

const STEPS = 8;
const TURN_MS = 3500;

/**
 * Where the router is, from the user's own body. A laptop's antenna cannot tell direction, but a
 * human body absorbs Wi-Fi well: standing still and facing eight directions in turn, the signal is
 * lowest with the back to the router and highest facing it.
 */
export function estimate(readings: number[]): { angle: number; spread: number } | null {
  if (readings.length < STEPS || readings.some((r) => !Number.isFinite(r))) return null;
  const power = readings.map((r) => 10 ** (r / 10));
  const floor = Math.min(...power);
  let x = 0;
  let y = 0;
  power.forEach((p, k) => {
    const a = (k / STEPS) * Math.PI * 2;
    x += (p - floor) * Math.sin(a);
    y += (p - floor) * Math.cos(a);
  });
  const angle = ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
  return { angle, spread: Math.max(...readings) - Math.min(...readings) };
}

const SIDES = ["front", "frontRight", "right", "backRight", "back", "backLeft", "left", "frontLeft"] as const;
export const side = (deg: number) => SIDES[Math.round(deg / 45) % 8];

export function Direction({ target }: { target: string | null }) {
  const { t } = useTranslation();
  const [step, setStep] = useState(-1);
  const [phase, setPhase] = useState<"idle" | "turn" | "measure" | "done">("idle");
  const [readings, setReadings] = useState<number[]>([]);
  const stop = useRef(false);

  const run = async () => {
    if (!target) return;
    stop.current = false;
    setReadings([]);
    const got: number[] = [];
    const measureMs = isLive(target) ? 5000 : 9500;
    for (let k = 0; k < STEPS; k++) {
      setStep(k);
      if (k > 0) {
        setPhase("turn");
        await new Promise((r) => setTimeout(r, TURN_MS));
      }
      if (stop.current) break;
      setPhase("measure");
      const v = await measure(target, measureMs);
      if (stop.current) break;
      got.push(v ?? -100);
      setReadings([...got]);
    }
    setPhase(stop.current ? "idle" : "done");
    setStep(-1);
  };

  const result = phase === "done" ? estimate(readings) : null;
  const confidence = result ? (result.spread >= 6 ? "good" : result.spread >= 3 ? "rough" : "weak") : null;
  const lo = readings.length ? Math.min(...readings) : 0;
  const hi = readings.length ? Math.max(...readings) : 1;
  const R = 110;

  return (
    <div className="rounded-card border border-line bg-surface p-5" data-testid="wifi-direction">
      <h3 className="flex items-center gap-2 text-[14px] font-medium">
        <Compass size={16} className="text-accent" />
        {t("wifi.direction.title")}
      </h3>
      <p className="mt-1 max-w-[80ch] text-[12px] leading-relaxed text-muted">{t("wifi.direction.text")}</p>
      <div className="mt-4 grid items-center gap-6 md:grid-cols-[280px_1fr]">
        <svg viewBox="-140 -140 280 280" className="mx-auto w-full max-w-[280px]">
          <circle r={R} fill="none" stroke="var(--color-line)" />
          <circle r={R * 0.5} fill="none" stroke="var(--color-line)" strokeDasharray="3 4" />
          {Array.from({ length: STEPS }, (_, k) => {
            const a0 = ((k - 0.5) / STEPS) * Math.PI * 2;
            const a1 = ((k + 0.5) / STEPS) * Math.PI * 2;
            const v = readings[k];
            const r = v === undefined ? 0 : 22 + ((v - lo) / Math.max(1, hi - lo)) * (R - 22);
            const p = (a: number, rr: number) => `${Math.sin(a) * rr} ${-Math.cos(a) * rr}`;
            return (
              <g key={k}>
                {v !== undefined && (
                  <motion.path
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    d={`M 0 0 L ${p(a0, r)} A ${r} ${r} 0 0 1 ${p(a1, r)} Z`}
                    fill="var(--color-accent)"
                    fillOpacity={0.18 + (0.5 * (v - lo)) / Math.max(1, hi - lo)}
                    stroke="var(--color-accent)"
                    strokeOpacity={0.5}
                  />
                )}
                <text x={Math.sin((k / STEPS) * Math.PI * 2) * (R + 16)} y={-Math.cos((k / STEPS) * Math.PI * 2) * (R + 16) + 4} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
                  {k * 45}°
                </text>
              </g>
            );
          })}
          {step >= 0 && (
            <motion.g animate={{ rotate: step * 45 }} transition={{ type: "spring", stiffness: 80, damping: 14 }}>
              <path d={`M 0 ${-R + 6} L -9 ${-R + 24} L 9 ${-R + 24} Z`} fill={phase === "measure" ? "var(--color-safe)" : "var(--color-warn)"} />
            </motion.g>
          )}
          {result && (
            <motion.g initial={{ scale: 0 }} animate={{ scale: 1, rotate: result.angle }} transition={{ type: "spring", stiffness: 120, damping: 14 }}>
              <line x1={0} y1={0} x2={0} y2={-R + 4} stroke="var(--color-safe)" strokeWidth={4} strokeLinecap="round" />
              <circle cy={-R + 4} r={7} fill="var(--color-safe)" />
            </motion.g>
          )}
          <circle r={9} fill="var(--color-fg)" />
          <text y={4} textAnchor="middle" fontSize={9} fill="var(--color-bg)">
            {t("wifi.direction.you")}
          </text>
        </svg>

        <div>
          {phase === "idle" && (
            <>
              <ol className="list-decimal space-y-1 pl-5 text-[12px] leading-relaxed text-muted">
                <li>{t("wifi.direction.how1")}</li>
                <li>{t("wifi.direction.how2")}</li>
                <li>{t("wifi.direction.how3")}</li>
              </ol>
              <Button variant="primary" className="mt-4" icon={<RotateCw size={15} />} onClick={run} disabled={!target} data-testid="direction-start">
                {t("wifi.direction.start")}
              </Button>
            </>
          )}
          {(phase === "turn" || phase === "measure") && (
            <div data-testid="direction-running">
              <div className="font-display text-[22px] font-semibold">{t("wifi.direction.step", { n: step + 1, total: STEPS })}</div>
              <div className={`mt-1 text-[14px] ${phase === "measure" ? "text-safe" : "text-warn"}`}>
                {phase === "turn" ? t("wifi.direction.turn", { deg: step * 45 }) : t("wifi.direction.hold")}
              </div>
              <div className="num mt-3 text-[12px] text-muted">{readings.map((r) => `${Math.round(r)}`).join(" · ")}</div>
              <Button
                className="mt-4"
                icon={<Square size={13} />}
                onClick={() => {
                  stop.current = true;
                }}
              >
                {t("wifi.direction.stop")}
              </Button>
            </div>
          )}
          {phase === "done" && result && (
            <div data-testid="direction-result">
              <div className="font-display text-[20px] font-semibold">{t(`wifi.direction.side.${side(result.angle)}`)}</div>
              <div className="num mt-1 text-[12px] text-muted">
                ~{Math.round(result.angle)}° · {t("wifi.direction.spread", { db: result.spread.toFixed(1) })}
              </div>
              <p className={`mt-2 text-[12px] leading-relaxed ${confidence === "good" ? "text-safe" : confidence === "rough" ? "text-warn" : "text-risk"}`}>
                {t(`wifi.direction.confidence.${confidence}`)}
              </p>
              <Button className="mt-4" icon={<RotateCw size={15} />} onClick={run}>
                {t("wifi.direction.again")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
