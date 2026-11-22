import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Crosshair, LocateFixed, MapPinned, Trash2, Undo2 } from "lucide-react";
import { Button } from "../../components/ui";
import { isLive, measure, nameOf, useWifi } from "../../lib/wifi";

interface Point {
  x: number;
  y: number;
  rssi: number;
}
interface Saved {
  w: number;
  d: number;
  points: Point[];
}

const KEY = "wifi.plan";
const loadAll = (): Record<string, Saved> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
const saveAll = (all: Record<string, Saved>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* this session only */
  }
};

const CELL = 0.25;

/** Inverse-distance-weighted signal at (x, y) from the measured points. */
export function idw(points: Point[], x: number, y: number): number {
  let num = 0;
  let den = 0;
  for (const p of points) {
    const d2 = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d2 < 1e-6) return p.rssi;
    const w = 1 / d2;
    num += w * p.rssi;
    den += w;
  }
  return num / den;
}

/**
 * Where the router most likely is: the spot whose distances to the measurement points best explain
 * the signals under the log-distance model rssi = P0 − 10·n·log10(d). P0 is solved exactly for each
 * spot; n is tried over typical indoor values. Returns the best spot and the spots almost as good.
 */
export function locate(points: Point[], w: number, d: number) {
  if (points.length < 3) return null;
  let best = { x: 0, y: 0, err: Infinity, n: 3 };
  const errs: { x: number; y: number; err: number }[] = [];
  for (let x = CELL / 2; x < w; x += CELL)
    for (let y = CELL / 2; y < d; y += CELL) {
      let cellBest = Infinity;
      for (const n of [2, 2.5, 3, 3.5]) {
        const logs = points.map((p) => 10 * n * Math.log10(Math.max(0.5, Math.hypot(p.x - x, p.y - y))));
        const p0 = points.reduce((a, p, i) => a + p.rssi + logs[i], 0) / points.length;
        const err = points.reduce((a, p, i) => a + (p.rssi - (p0 - logs[i])) ** 2, 0);
        if (err < cellBest) cellBest = err;
        if (err < best.err) best = { x, y, err, n };
      }
      errs.push({ x, y, err: cellBest });
    }
  const near = errs.filter((e) => e.err <= best.err * 1.6 + 4);
  return { ...best, near };
}

const colour = (rssi: number) => {
  const k = Math.max(0, Math.min(1, (rssi + 88) / 40));
  return k > 0.5
    ? `color-mix(in oklab, var(--color-safe) ${Math.round((k - 0.5) * 200)}%, var(--color-warn))`
    : `color-mix(in oklab, var(--color-warn) ${Math.round(k * 200)}%, var(--color-risk))`;
};

export function Plan() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const own = snap.networks.find((n) => n.connected);
  const [target, setTarget] = useState<string | null>(own?.bssid ?? snap.networks[0]?.bssid ?? null);
  const net = snap.networks.find((n) => n.bssid === target);
  const key = net ? (net.hidden ? net.bssid : net.ssid) : "";
  const [all, setAll] = useState<Record<string, Saved>>(loadAll);
  const plan = all[key] ?? { w: 10, d: 8, points: [] };
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const update = (next: Saved) => {
    const merged = { ...all, [key]: next };
    setAll(merged);
    saveAll(merged);
  };

  const scale = Math.min(860 / plan.w, 480 / plan.d);
  const W = plan.w * scale;
  const H = plan.d * scale;

  const heatCells = useMemo(() => {
    if (plan.points.length < 2) return [];
    const cells: { x: number; y: number; v: number }[] = [];
    for (let x = 0; x < plan.w; x += CELL) for (let y = 0; y < plan.d; y += CELL) cells.push({ x, y, v: idw(plan.points, x + CELL / 2, y + CELL / 2) });
    return cells;
  }, [plan]);
  const router = useMemo(() => locate(plan.points, plan.w, plan.d), [plan]);
  const spread = plan.points.length ? Math.max(...plan.points.map((p) => p.x)) - Math.min(...plan.points.map((p) => p.x)) + Math.max(...plan.points.map((p) => p.y)) - Math.min(...plan.points.map((p) => p.y)) : 0;
  const weakest = plan.points.length >= 2 ? plan.points.reduce((a, b) => (b.rssi < a.rssi ? b : a)) : null;

  const take = async () => {
    if (!cursor || !target) return;
    setBusy(true);
    const v = await measure(target, isLive(target) ? 5000 : 9500);
    setBusy(false);
    if (v === null) return;
    update({ ...plan, points: [...plan.points, { x: cursor.x, y: cursor.y, rssi: v }] });
    setCursor(null);
  };

  return (
    <div className="grid gap-4" data-testid="wifi-plan">
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-[220px] flex-1 gap-1 text-[11px] text-muted">
            {t("wifi.plan.network")}
            <select value={target ?? ""} onChange={(e) => setTarget(e.target.value)} className="h-9 rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none">
              {[...snap.networks]
                .sort((a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi)
                .map((n) => (
                  <option key={n.bssid} value={n.bssid}>
                    {nameOf(n, t("wifi.hidden"))} · {n.band} {t("wifi.ghz")}
                    {n.connected ? ` · ${t("wifi.yours")}` : ""}
                  </option>
                ))}
            </select>
          </label>
          {(["w", "d"] as const).map((k) => (
            <label key={k} className="grid gap-1 text-[11px] text-muted">
              {t(`wifi.plan.${k}`)}
              <input
                type="number"
                min={3}
                max={40}
                step={0.5}
                value={plan[k]}
                onChange={(e) => update({ ...plan, [k]: Math.max(3, Math.min(40, Number(e.target.value) || plan[k])) })}
                className="num h-9 w-24 rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none"
              />
            </label>
          ))}
          <Button icon={<Undo2 size={14} />} disabled={!plan.points.length} onClick={() => update({ ...plan, points: plan.points.slice(0, -1) })}>
            {t("wifi.plan.undo")}
          </Button>
          <Button variant="quiet" icon={<Trash2 size={14} />} disabled={!plan.points.length} onClick={() => update({ ...plan, points: [] })}>
            {t("wifi.plan.clear")}
          </Button>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-muted">{t("wifi.plan.how")}</p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[auto_1fr]">
        <div className="rounded-card border border-line bg-surface p-4">
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="max-w-full cursor-crosshair rounded-md bg-bg"
            onClick={(e) => {
              const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              setCursor({ x: Math.round((((e.clientX - r.left) / r.width) * plan.w) * 4) / 4, y: Math.round((((e.clientY - r.top) / r.height) * plan.d) * 4) / 4 });
            }}
            data-testid="plan-canvas"
          >
            {heatCells.map((c) => (
              <rect key={`${c.x}-${c.y}`} x={c.x * scale} y={c.y * scale} width={CELL * scale + 0.5} height={CELL * scale + 0.5} fill={colour(c.v)} opacity={0.42} />
            ))}
            {Array.from({ length: Math.floor(plan.w) + 1 }, (_, i) => (
              <line key={`x${i}`} x1={i * scale} x2={i * scale} y1={0} y2={H} stroke="var(--color-line)" strokeWidth={i % 5 === 0 ? 1.2 : 0.5} />
            ))}
            {Array.from({ length: Math.floor(plan.d) + 1 }, (_, i) => (
              <line key={`y${i}`} y1={i * scale} y2={i * scale} x1={0} x2={W} stroke="var(--color-line)" strokeWidth={i % 5 === 0 ? 1.2 : 0.5} />
            ))}
            <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="var(--color-muted)" strokeWidth={1.5} />
            {router &&
              router.near.map((c) => (
                <rect key={`n${c.x}-${c.y}`} x={(c.x - CELL / 2) * scale} y={(c.y - CELL / 2) * scale} width={CELL * scale} height={CELL * scale} fill="var(--color-accent)" opacity={0.18} />
              ))}
            {router && (
              <motion.g initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ originX: `${router.x * scale}px`, originY: `${router.y * scale}px` }}>
                <circle cx={router.x * scale} cy={router.y * scale} r={13} fill="var(--color-accent)" opacity={0.25} />
                <circle cx={router.x * scale} cy={router.y * scale} r={6} fill="var(--color-accent)" />
                <text x={router.x * scale} y={router.y * scale - 17} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-fg)">
                  {t("wifi.plan.router")}
                </text>
              </motion.g>
            )}
            {plan.points.map((p, i) => (
              <g key={i}>
                <circle cx={p.x * scale} cy={p.y * scale} r={10} fill={colour(p.rssi)} stroke="var(--color-bg)" strokeWidth={2} />
                <text x={p.x * scale} y={p.y * scale + 22} textAnchor="middle" fontSize={10} className="num" fill="var(--color-fg)">
                  {Math.round(p.rssi)}
                </text>
              </g>
            ))}
            {cursor && (
              <g>
                <circle cx={cursor.x * scale} cy={cursor.y * scale} r={busy ? 16 : 12} fill="none" stroke="var(--color-fg)" strokeWidth={2} strokeDasharray={busy ? "4 4" : undefined}>
                  {busy && <animateTransform attributeName="transform" type="rotate" from={`0 ${cursor.x * scale} ${cursor.y * scale}`} to={`360 ${cursor.x * scale} ${cursor.y * scale}`} dur="2s" repeatCount="indefinite" />}
                </circle>
                <circle cx={cursor.x * scale} cy={cursor.y * scale} r={3} fill="var(--color-fg)" />
              </g>
            )}
          </svg>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" icon={<LocateFixed size={15} />} disabled={!cursor || busy || !target} onClick={take} data-testid="plan-measure">
              {busy ? t("wifi.plan.measuring") : t("wifi.plan.measure")}
            </Button>
            <span className="text-[12px] text-muted">{cursor ? t("wifi.plan.here", { x: cursor.x, y: cursor.y }) : t("wifi.plan.pick")}</span>
          </div>
        </div>

        <div className="grid content-start gap-3">
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <Crosshair size={15} className="text-accent" />
              {t("wifi.plan.whereTitle")}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              {plan.points.length < 3
                ? t("wifi.plan.needMore", { count: 3 - plan.points.length })
                : spread < 3
                  ? t("wifi.plan.spreadOut")
                  : t("wifi.plan.found", { x: router!.x.toFixed(1), y: router!.y.toFixed(1), n: router!.n, area: (router!.near.length * CELL * CELL).toFixed(1) })}
            </p>
          </div>
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <MapPinned size={15} className="text-accent" />
              {t("wifi.plan.heatTitle")}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              {weakest ? t("wifi.plan.weakest", { x: weakest.x, y: weakest.y, rssi: Math.round(weakest.rssi) }) : t("wifi.plan.heatHint")}
            </p>
            <div className="mt-3 flex items-center gap-2 text-[10px] text-muted">
              −88
              <span className="h-2 flex-1 rounded-full" style={{ background: `linear-gradient(90deg, ${colour(-88)}, ${colour(-68)}, ${colour(-48)})` }} />
              −48 dBm
            </div>
          </div>
          <p className="text-[11px] leading-relaxed text-muted">{t("wifi.plan.honest")}</p>
        </div>
      </div>
    </div>
  );
}
