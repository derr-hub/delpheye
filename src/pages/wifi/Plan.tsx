import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { BrickWall, Crosshair, ImagePlus, LocateFixed, MapPinned, MousePointer2, Router as RouterIcon, Square, Trash2, Undo2 } from "lucide-react";
import { Button } from "../../components/ui";
import { isLive, measure, nameOf, useWifi } from "../../lib/wifi";
import { useRouter } from "../../lib/router";
import { Whereami } from "./Whereami";

export interface Point {
  x: number;
  y: number;
  rssi: number;
}
export interface Wall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Saved {
  w: number;
  d: number;
  points: Point[];
  walls?: Wall[];
  image?: string;
  imageOpacity?: number;
  /** Set by hand when the user knows where the router stands. */
  router?: { x: number; y: number };
}

const KEY = "wifi.plan";
export const loadPlans = (): Record<string, Saved> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
const savePlans = (all: Record<string, Saved>) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* too big for the store (a huge photo): kept for this session only */
  }
};

const CELL = 0.25;
const snap = (v: number) => Math.round(v * 4) / 4;

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

/** Whether segment a–b crosses segment c–d. */
function crosses(ax: number, ay: number, bx: number, by: number, w: Wall) {
  const o = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
  return o(ax, ay, bx, by, w.x1, w.y1) * o(ax, ay, bx, by, w.x2, w.y2) < 0 && o(w.x1, w.y1, w.x2, w.y2, ax, ay) * o(w.x1, w.y1, w.x2, w.y2, bx, by) < 0;
}

/**
 * Where the router most likely is: the spot whose distances to the measurement points best explain
 * the signals under rssi = P0 − 10·n·log10(d) − W·(walls crossed). P0 is solved exactly for each spot;
 * n and the loss per wall W are tried over typical indoor values.
 */
export function locate(points: Point[], w: number, d: number, walls: Wall[] = []) {
  if (points.length < 3) return null;
  let best = { x: 0, y: 0, err: Infinity, n: 3, wall: 0, p0: -40 };
  const errs: { x: number; y: number; err: number }[] = [];
  const wallLosses = walls.length ? [0, 3, 6, 10] : [0];
  for (let x = CELL / 2; x < w; x += CELL)
    for (let y = CELL / 2; y < d; y += CELL) {
      let cellBest = Infinity;
      const counts = points.map((p) => walls.filter((wl) => crosses(p.x, p.y, x, y, wl)).length);
      for (const n of [2, 2.5, 3, 3.5])
        for (const wl of wallLosses) {
          const model = points.map((p, i) => 10 * n * Math.log10(Math.max(0.5, Math.hypot(p.x - x, p.y - y))) + wl * counts[i]);
          const p0 = points.reduce((a, p, i) => a + p.rssi + model[i], 0) / points.length;
          const err = points.reduce((a, p, i) => a + (p.rssi - (p0 - model[i])) ** 2, 0);
          if (err < cellBest) cellBest = err;
          if (err < best.err) best = { x, y, err, n, wall: wl, p0 };
        }
      errs.push({ x, y, err: cellBest });
    }
  const near = errs.filter((e) => e.err <= best.err * 1.6 + 4);
  return { ...best, near };
}

export const colour = (rssi: number) => {
  const k = Math.max(0, Math.min(1, (rssi + 88) / 40));
  return k > 0.5
    ? `color-mix(in oklab, var(--color-safe) ${Math.round((k - 0.5) * 200)}%, var(--color-warn))`
    : `color-mix(in oklab, var(--color-warn) ${Math.round(k * 200)}%, var(--color-risk))`;
};

/** Shrinks a photo so it fits the local store, as a JPEG data URL, with its aspect ratio. */
function shrink(file: File): Promise<{ url: string; aspect: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 1400 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d")!.drawImage(img, 0, 0, c.width, c.height);
      resolve({ url: c.toDataURL("image/jpeg", 0.8), aspect: img.height / img.width });
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

type Tool = "measure" | "wall" | "room" | "router";

export function Plan() {
  const { t } = useTranslation();
  const snapW = useWifi((s) => s.snap)!;
  const own = snapW.networks.find((n) => n.connected);
  const [target, setTarget] = useState<string | null>(own?.bssid ?? snapW.networks[0]?.bssid ?? null);
  const net = snapW.networks.find((n) => n.bssid === target);
  const key = net ? (net.hidden ? net.bssid : net.ssid) : "";
  const [all, setAll] = useState<Record<string, Saved>>(loadPlans);
  const plan: Saved = all[key] ?? { w: 10, d: 8, points: [] };
  const walls = plan.walls ?? [];
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [tool, setTool] = useState<Tool>("measure");
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const routerOverview = useRouter((s) => s.overview);

  const update = (next: Saved) => {
    const merged = { ...all, [key]: next };
    setAll(merged);
    savePlans(merged);
  };

  const scale = Math.min(860 / plan.w, 520 / plan.d);
  const W = plan.w * scale;
  const H = plan.d * scale;
  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: snap(Math.max(0, Math.min(plan.w, ((e.clientX - r.left) / r.width) * plan.w))), y: snap(Math.max(0, Math.min(plan.d, ((e.clientY - r.top) / r.height) * plan.d))) };
  };

  const heatCells = useMemo(() => {
    if (plan.points.length < 2) return [];
    const cells: { x: number; y: number; v: number }[] = [];
    for (let x = 0; x < plan.w; x += CELL) for (let y = 0; y < plan.d; y += CELL) cells.push({ x, y, v: idw(plan.points, x + CELL / 2, y + CELL / 2) });
    return cells;
  }, [plan.points, plan.w, plan.d]);
  const fit = useMemo(() => locate(plan.points, plan.w, plan.d, walls), [plan.points, plan.w, plan.d, walls]);
  const routerAt = plan.router ?? (fit ? { x: fit.x, y: fit.y } : null);
  const spread = plan.points.length ? Math.max(...plan.points.map((p) => p.x)) - Math.min(...plan.points.map((p) => p.x)) + Math.max(...plan.points.map((p) => p.y)) - Math.min(...plan.points.map((p) => p.y)) : 0;
  const weakest = plan.points.length >= 2 ? plan.points.reduce((a, b) => (b.rssi < a.rssi ? b : a)) : null;

  // Devices the router hears, as rings round the router: distance from the fitted path loss.
  const rings = useMemo(() => {
    if (!routerAt || !routerOverview) return [];
    const n = fit?.n ?? 3;
    const p0 = fit?.p0 ?? -40;
    return routerOverview.clients
      .filter((c) => c.online && c.rssi !== null)
      .map((c) => ({ name: c.name || c.vendor || c.mac, r: Math.min(30, Math.max(0.5, 10 ** ((p0 - (c.rssi as number)) / (10 * n)))) }));
  }, [routerAt, routerOverview, fit]);

  const take = async () => {
    if (!cursor || !target) return;
    setBusy(true);
    const v = await measure(target, isLive(target) ? 5000 : 9500);
    setBusy(false);
    if (v === null) return;
    update({ ...plan, points: [...plan.points, { x: cursor.x, y: cursor.y, rssi: v }] });
    setCursor(null);
  };

  const finishDrag = () => {
    if (!drag) return;
    const { x, y } = drag;
    let { x2, y2 } = drag;
    if (tool === "wall") {
      // Nearly level or upright lines are made exactly so.
      if (Math.abs(y2 - y) < Math.abs(x2 - x) * 0.18) y2 = y;
      else if (Math.abs(x2 - x) < Math.abs(y2 - y) * 0.18) x2 = x;
      if (Math.hypot(x2 - x, y2 - y) >= 0.25) update({ ...plan, walls: [...walls, { x1: x, y1: y, x2, y2 }] });
    } else if (tool === "room" && Math.abs(x2 - x) >= 0.5 && Math.abs(y2 - y) >= 0.5) {
      update({
        ...plan,
        walls: [...walls, { x1: x, y1: y, x2, y2: y }, { x1: x2, y1: y, x2, y2 }, { x1: x2, y1: y2, x2: x, y2 }, { x1: x, y1: y2, x2: x, y2: y }],
      });
    }
    setDrag(null);
  };

  useEffect(() => setCursor(null), [tool]);

  const tools: [Tool, typeof MousePointer2][] = [
    ["measure", LocateFixed],
    ["wall", BrickWall],
    ["room", Square],
    ["router", RouterIcon],
  ];

  return (
    <div className="grid gap-4" data-testid="wifi-plan">
      <div className="rounded-card border border-line bg-surface p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-[200px] flex-1 gap-1 text-[11px] text-muted">
            {t("wifi.plan.network")}
            <select value={target ?? ""} onChange={(e) => setTarget(e.target.value)} className="h-9 rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none">
              {[...snapW.networks]
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
                onChange={(e) => {
                  const v = Math.max(3, Math.min(40, Number(e.target.value) || plan[k]));
                  // With a photo underneath, the other side follows its proportions.
                  const aspect = plan.image ? plan.d / plan.w : null;
                  update(aspect && k === "w" ? { ...plan, w: v, d: Math.round(v * aspect * 4) / 4 } : { ...plan, [k]: v });
                }}
                className="num h-9 w-24 rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none"
              />
            </label>
          ))}
          <input
            ref={file}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              const { url, aspect } = await shrink(f);
              update({ ...plan, image: url, imageOpacity: plan.imageOpacity ?? 0.6, d: Math.round(plan.w * aspect * 4) / 4 });
              e.target.value = "";
            }}
          />
          <Button icon={<ImagePlus size={14} />} onClick={() => file.current?.click()} data-testid="plan-image">
            {plan.image ? t("wifi.plan.imageChange") : t("wifi.plan.image")}
          </Button>
          {plan.image && (
            <label className="grid gap-1 text-[11px] text-muted">
              {t("wifi.plan.imageOpacity")}
              <input type="range" min={0.15} max={1} step={0.05} value={plan.imageOpacity ?? 0.6} onChange={(e) => update({ ...plan, imageOpacity: Number(e.target.value) })} className="h-9 w-28 accent-[var(--color-accent)]" />
            </label>
          )}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-line bg-raised/40 p-0.5">
            {tools.map(([id, Icon]) => (
              <button
                key={id}
                onClick={() => setTool(id)}
                className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] ${tool === id ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}
                data-testid={`plan-tool-${id}`}
              >
                <Icon size={13} />
                {t(`wifi.plan.tool.${id}`)}
              </button>
            ))}
          </div>
          <Button variant="quiet" icon={<Undo2 size={14} />} disabled={tool === "measure" ? !plan.points.length : !walls.length} onClick={() => update(tool === "measure" ? { ...plan, points: plan.points.slice(0, -1) } : { ...plan, walls: walls.slice(0, -1) })}>
            {t("wifi.plan.undo")}
          </Button>
          <Button variant="quiet" icon={<Trash2 size={14} />} disabled={!plan.points.length && !walls.length && !plan.image} onClick={() => update({ w: plan.w, d: plan.d, points: [] })}>
            {t("wifi.plan.clear")}
          </Button>
          <span className="text-[12px] text-muted">{t(`wifi.plan.toolHint.${tool}`)}</span>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[auto_1fr]">
        <div className="rounded-card border border-line bg-surface p-4">
          <svg
            ref={svg}
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            className="max-w-full cursor-crosshair touch-none select-none rounded-md bg-bg"
            onPointerDown={(e) => {
              const p = at(e);
              if (tool === "wall" || tool === "room") setDrag({ x: p.x, y: p.y, x2: p.x, y2: p.y });
            }}
            onPointerMove={(e) => drag && setDrag({ ...drag, ...((p) => ({ x2: p.x, y2: p.y }))(at(e)) })}
            onPointerUp={finishDrag}
            onPointerLeave={finishDrag}
            onClick={(e) => {
              const p = at(e);
              if (tool === "measure") setCursor(p);
              if (tool === "router") update({ ...plan, router: p });
            }}
            data-testid="plan-canvas"
          >
            {plan.image && <image href={plan.image} x={0} y={0} width={W} height={H} preserveAspectRatio="none" opacity={plan.imageOpacity ?? 0.6} />}
            {heatCells.map((c) => (
              <rect key={`${c.x}-${c.y}`} x={c.x * scale} y={c.y * scale} width={CELL * scale + 0.5} height={CELL * scale + 0.5} fill={colour(c.v)} opacity={plan.image ? 0.3 : 0.42} />
            ))}
            {!plan.image &&
              Array.from({ length: Math.floor(plan.w) + 1 }, (_, i) => <line key={`x${i}`} x1={i * scale} x2={i * scale} y1={0} y2={H} stroke="var(--color-line)" strokeWidth={i % 5 === 0 ? 1.2 : 0.5} />)}
            {!plan.image &&
              Array.from({ length: Math.floor(plan.d) + 1 }, (_, i) => <line key={`y${i}`} y1={i * scale} y2={i * scale} x1={0} x2={W} stroke="var(--color-line)" strokeWidth={i % 5 === 0 ? 1.2 : 0.5} />)}
            <rect x={0.5} y={0.5} width={W - 1} height={H - 1} fill="none" stroke="var(--color-muted)" strokeWidth={1.5} />
            {walls.map((w, i) => (
              <line
                key={i}
                x1={w.x1 * scale}
                y1={w.y1 * scale}
                x2={w.x2 * scale}
                y2={w.y2 * scale}
                stroke="#c9d3de"
                strokeWidth={5}
                strokeLinecap="round"
                className={tool === "wall" || tool === "room" ? "cursor-pointer hover:stroke-[var(--color-risk)]" : ""}
                onClick={(e) => {
                  if (tool !== "wall" && tool !== "room") return;
                  e.stopPropagation();
                  update({ ...plan, walls: walls.filter((_, k) => k !== i) });
                }}
                onPointerDown={(e) => (tool === "wall" || tool === "room") && e.stopPropagation()}
              />
            ))}
            {drag && tool === "wall" && <line x1={drag.x * scale} y1={drag.y * scale} x2={drag.x2 * scale} y2={drag.y2 * scale} stroke="var(--color-accent)" strokeWidth={5} strokeDasharray="6 5" />}
            {drag && tool === "room" && (
              <rect x={Math.min(drag.x, drag.x2) * scale} y={Math.min(drag.y, drag.y2) * scale} width={Math.abs(drag.x2 - drag.x) * scale} height={Math.abs(drag.y2 - drag.y) * scale} fill="var(--color-accent)" fillOpacity={0.08} stroke="var(--color-accent)" strokeWidth={4} strokeDasharray="6 5" />
            )}
            {fit &&
              !plan.router &&
              fit.near.map((c) => <rect key={`n${c.x}-${c.y}`} x={(c.x - CELL / 2) * scale} y={(c.y - CELL / 2) * scale} width={CELL * scale} height={CELL * scale} fill="var(--color-accent)" opacity={0.18} />)}
            {routerAt &&
              rings.map((r, i) => (
                <g key={i}>
                  <circle cx={routerAt.x * scale} cy={routerAt.y * scale} r={r.r * scale} fill="none" stroke="var(--color-accent)" strokeOpacity={0.45} strokeDasharray="4 5" />
                  <text x={routerAt.x * scale} y={(routerAt.y - r.r) * scale - 4} textAnchor="middle" fontSize={10} fill="var(--color-fg)" opacity={0.85}>
                    {r.name}
                  </text>
                </g>
              ))}
            {routerAt && (
              <motion.g initial={{ scale: 0 }} animate={{ scale: 1 }} style={{ originX: `${routerAt.x * scale}px`, originY: `${routerAt.y * scale}px` }}>
                <circle cx={routerAt.x * scale} cy={routerAt.y * scale} r={13} fill="var(--color-accent)" opacity={0.25} />
                <circle cx={routerAt.x * scale} cy={routerAt.y * scale} r={6} fill="var(--color-accent)" />
                <text x={routerAt.x * scale} y={routerAt.y * scale - 17} textAnchor="middle" fontSize={11} fontWeight={600} fill="var(--color-fg)">
                  {plan.router ? t("wifi.plan.routerSet") : t("wifi.plan.router")}
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
            <Whereami.Marker scale={scale} planKey={key} />
            {cursor && (
              <g>
                <circle cx={cursor.x * scale} cy={cursor.y * scale} r={busy ? 16 : 12} fill="none" stroke="var(--color-fg)" strokeWidth={2} strokeDasharray={busy ? "4 4" : undefined} />
                <circle cx={cursor.x * scale} cy={cursor.y * scale} r={3} fill="var(--color-fg)" />
              </g>
            )}
          </svg>
          {tool === "measure" && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button variant="primary" icon={<LocateFixed size={15} />} disabled={!cursor || busy || !target} onClick={take} data-testid="plan-measure">
                {busy ? t("wifi.plan.measuring") : t("wifi.plan.measure")}
              </Button>
              <span className="text-[12px] text-muted">{cursor ? t("wifi.plan.here", { x: cursor.x, y: cursor.y }) : t("wifi.plan.pick")}</span>
            </div>
          )}
          {tool === "router" && plan.router && (
            <Button variant="quiet" className="mt-3" onClick={() => update({ ...plan, router: undefined })}>
              {t("wifi.plan.routerUnset")}
            </Button>
          )}
        </div>

        <div className="grid content-start gap-3">
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <Crosshair size={15} className="text-accent" />
              {t("wifi.plan.whereTitle")}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">
              {plan.router
                ? t("wifi.plan.routerManual", { x: plan.router.x, y: plan.router.y })
                : plan.points.length < 3
                  ? t("wifi.plan.needMore", { count: 3 - plan.points.length })
                  : spread < 3
                    ? t("wifi.plan.spreadOut")
                    : t("wifi.plan.found", { x: fit!.x.toFixed(1), y: fit!.y.toFixed(1), n: fit!.n, area: (fit!.near.length * CELL * CELL).toFixed(1) })}
              {fit && walls.length > 0 && !plan.router && ` ${t("wifi.plan.wallLoss", { db: fit.wall })}`}
            </p>
            {rings.length > 0 ? (
              <p className="mt-2 text-[11px] leading-relaxed text-muted">{t("wifi.plan.rings", { count: rings.length })}</p>
            ) : (
              routerAt && <p className="mt-2 text-[11px] leading-relaxed text-muted">{t("wifi.plan.ringsHint")}</p>
            )}
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
          <Whereami planKey={key} cursor={cursor} />
          <p className="text-[11px] leading-relaxed text-muted">{t("wifi.plan.honest")}</p>
        </div>
      </div>
    </div>
  );
}
