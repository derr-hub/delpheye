import { lazy, Suspense, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Compass, RotateCw, Square } from "lucide-react";
import { Button } from "../../components/ui";
import { isLive, measure } from "../../lib/wifi";

const Room3D = lazy(() => import("./Room3D"));

const STEPS = 8;
const ROUNDS = 2;
const TURN_MS = 3000;

/**
 * Where the router is, from the user's own body. A laptop's antenna cannot tell direction, but a
 * human body absorbs Wi-Fi well: facing eight directions in turn, the signal is lowest with the back
 * to the router and highest facing it. The power-weighted mean of the directions gives the side.
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

const gap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Two rounds must agree: one round can be fooled by a reflection or a step taken mid-measure. */
export function combine(rounds: number[][]) {
  const each = rounds.map(estimate).filter((x): x is NonNullable<typeof x> => !!x);
  const mean = Array.from({ length: STEPS }, (_, k) => rounds.reduce((a, r) => a + r[k], 0) / rounds.length);
  const all = estimate(mean);
  if (!all || each.length < rounds.length) return null;
  const disagreement = each.length > 1 ? gap(each[0].angle, each[1].angle) : 0;
  const confidence = all.spread >= 5 && disagreement <= 45 ? "good" : all.spread >= 3 && disagreement <= 90 ? "rough" : "weak";
  return { angle: all.angle, spread: all.spread, disagreement, confidence, mean } as const;
}

export function Direction({ target }: { target: string | null }) {
  const { t } = useTranslation();
  const [round, setRound] = useState(0);
  const [step, setStep] = useState(-1);
  const [phase, setPhase] = useState<"idle" | "turn" | "measure" | "done">("idle");
  const [rounds, setRounds] = useState<number[][]>([]);
  const stop = useRef(false);

  const run = async () => {
    if (!target) return;
    stop.current = false;
    const got: number[][] = [];
    setRounds([]);
    const measureMs = isLive(target) ? 4500 : 9500;
    outer: for (let r = 0; r < ROUNDS; r++) {
      setRound(r);
      got.push([]);
      for (let k = 0; k < STEPS; k++) {
        setStep(k);
        if (r > 0 || k > 0) {
          setPhase("turn");
          await new Promise((res) => setTimeout(res, TURN_MS));
        }
        if (stop.current) break outer;
        setPhase("measure");
        const v = await measure(target, measureMs);
        if (stop.current) break outer;
        got[r].push(v ?? -100);
        setRounds(got.map((x) => [...x]));
      }
    }
    setPhase(stop.current ? "idle" : "done");
    setStep(-1);
    // A confident answer is kept for the 3D view, which then places the router that way.
    const r = !stop.current ? combine(got) : null;
    if (r && r.confidence !== "weak") {
      try {
        localStorage.setItem("wifi.direction", JSON.stringify({ bssid: target, angle: r.angle, at: Date.now() }));
      } catch {
        /* optional */
      }
    }
  };

  const result = phase === "done" ? combine(rounds) : null;
  const shown = result?.mean ?? rounds[rounds.length - 1] ?? [];
  const lo = shown.length ? Math.min(...shown) : 0;
  const hi = shown.length ? Math.max(...shown) : 1;
  const R = 100;
  // 0, 90, 180, 270 are walls 1–4; the 45s are the corners between them.
  const placeOf = (deg: number) => {
    const k = Math.round(deg / 45) % 8;
    return k % 2 === 0 ? t("wifi.direction.wall", { n: k / 2 + 1 }) : t("wifi.direction.corner", { a: (k - 1) / 2 + 1, b: ((k + 1) / 2) % 4 + 1 });
  };
  const facing = phase === "done" && result ? result.angle : step >= 0 ? step * 45 : 0;
  const walls = [1, 2, 3, 4].map((n) => t("wifi.direction.wall", { n }));

  return (
    <div className="rounded-card border border-line bg-surface p-5" data-testid="wifi-direction">
      <h3 className="flex items-center gap-2 text-[0.875rem] font-medium">
        <Compass size={16} className="text-accent" />
        {t("wifi.direction.title")}
      </h3>
      <p className="mt-1 max-w-[90ch] text-[0.75rem] leading-relaxed text-muted">{t("wifi.direction.text")}</p>
      <div className="mt-4 grid gap-5 lg:grid-cols-[1.25fr_1fr]">
        <Suspense fallback={<div className="h-[18.75rem] rounded-xl bg-raised" />}>
          <Room3D facing={facing} highlight={phase === "turn" || phase === "measure" ? step * 45 : null} result={result && result.confidence !== "weak" ? result.angle : null} labels={walls} />
        </Suspense>

        <div className="grid content-start gap-4">
          {phase === "idle" && (
            <>
              <ol className="list-decimal space-y-1.5 pl-5 text-[0.75rem] leading-relaxed text-muted">
                <li>{t("wifi.direction.how1")}</li>
                <li>{t("wifi.direction.how2")}</li>
                <li>{t("wifi.direction.how3")}</li>
              </ol>
              <Button variant="primary" icon={<RotateCw size={15} />} onClick={run} disabled={!target} data-testid="direction-start">
                {t("wifi.direction.start")}
              </Button>
            </>
          )}
          {(phase === "turn" || phase === "measure") && (
            <div data-testid="direction-running">
              <div className="text-[0.75rem] text-muted">{t("wifi.direction.round", { n: round + 1, total: ROUNDS })}</div>
              <div className="font-display text-[1.375rem] font-semibold">{t("wifi.direction.step", { n: step + 1, total: STEPS })}</div>
              <div className={`mt-1 text-[0.9375rem] ${phase === "measure" ? "text-safe" : "text-warn"}`}>
                {phase === "turn" ? t("wifi.direction.face", { place: placeOf(step * 45) }) : t("wifi.direction.hold")}
              </div>
              <Button className="mt-4" icon={<Square size={13} />} onClick={() => (stop.current = true)}>
                {t("wifi.direction.stop")}
              </Button>
            </div>
          )}
          {phase === "done" && result && (
            <div data-testid="direction-result">
              <div className="font-display text-[1.1875rem] font-semibold">
                {result.confidence === "weak" ? t("wifi.direction.unsure") : t("wifi.direction.towards", { place: placeOf(result.angle) })}
              </div>
              <div className="num mt-1 text-[0.75rem] text-muted">{t("wifi.direction.numbers", { db: result.spread.toFixed(1), diff: Math.round(result.disagreement) })}</div>
              <p className={`mt-2 text-[0.75rem] leading-relaxed ${result.confidence === "good" ? "text-safe" : result.confidence === "rough" ? "text-warn" : "text-risk"}`}>
                {t(`wifi.direction.confidence.${result.confidence}`)}
              </p>
              <Button className="mt-4" icon={<RotateCw size={15} />} onClick={run}>
                {t("wifi.direction.again")}
              </Button>
            </div>
          )}

          {/* the readings themselves, as a small rose */}
          {shown.length > 0 && (
            <svg viewBox="-120 -120 240 240" className="mx-auto w-full max-w-[12.5rem]">
              <circle r={R} fill="none" stroke="var(--color-line)" />
              {shown.map((v, k) => {
                const a0 = ((k - 0.5) / STEPS) * Math.PI * 2;
                const a1 = ((k + 0.5) / STEPS) * Math.PI * 2;
                const r = 18 + ((v - lo) / Math.max(1, hi - lo)) * (R - 18);
                const p = (a: number) => `${Math.sin(a) * r} ${-Math.cos(a) * r}`;
                return <motion.path key={k} initial={{ opacity: 0 }} animate={{ opacity: 1 }} d={`M 0 0 L ${p(a0)} A ${r} ${r} 0 0 1 ${p(a1)} Z`} fill="var(--color-accent)" fillOpacity={0.2 + (0.5 * (v - lo)) / Math.max(1, hi - lo)} stroke="var(--color-accent)" strokeOpacity={0.5} />;
              })}
              {result && result.confidence !== "weak" && <line x1={0} y1={0} x2={Math.sin((result.angle * Math.PI) / 180) * R} y2={-Math.cos((result.angle * Math.PI) / 180) * R} stroke="var(--color-safe)" strokeWidth={4} strokeLinecap="round" />}
              <text y={-R - 6} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
                {walls[0]}
              </text>
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
