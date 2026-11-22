import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Box, Crosshair, Loader2, LineChart as LineIcon, Rows3, Waves } from "lucide-react";
import { BAND_COLORS, nameOf, useWifi, type Band, type Bss } from "../../lib/wifi";
import { AdviceList, Bars } from "./Simple";
import { Hunt } from "./Hunt";

const Echo3D = lazy(() => import("./Echo3D"));

type Tab = "spectrum" | "timeline" | "table" | "echo" | "hunt";
const TABS: [Tab, typeof Waves][] = [
  ["spectrum", Waves],
  ["timeline", LineIcon],
  ["table", Rows3],
  ["echo", Box],
  ["hunt", Crosshair],
];

/** Stable colours per access point for the time chart: the colour follows the network. */
const SERIES = ["#4CC2FF", "#F5A35C", "#B48CFF", "#6CCB5F", "#FF8FA3", "#E6E9EE", "#5ED6D0", "#D6C25A"];
const assigned = new Map<string, string>();
function colourOf(bssid: string, own: boolean) {
  if (own) return "#4CC2FF";
  if (!assigned.has(bssid)) assigned.set(bssid, SERIES[1 + (assigned.size % (SERIES.length - 1))]);
  return assigned.get(bssid)!;
}

// ───────────────────────── spectrum ─────────────────────────

const RANGE: Record<Band, [number, number]> = { "2.4": [2397, 2492], "5": [5160, 5895], "6": [5925, 7125] };
const TICKS: Record<Band, number[]> = {
  "2.4": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  "5": [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
  "6": [1, 17, 33, 49, 65, 81, 97, 113, 129, 145, 161, 177, 193, 209, 225],
};
const chMhz = (band: Band, ch: number) => (band === "2.4" ? 2407 + 5 * ch : band === "5" ? 5000 + 5 * ch : 5950 + 5 * ch);

const W = 1000;
const H = 340;
const M = { l: 46, r: 14, t: 26, b: 36 };
const DBM: [number, number] = [-100, -20];

function Spectrum() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const present = (["2.4", "5", "6"] as Band[]).filter((b) => snap.networks.some((n) => n.band === b));
  const ownBand = snap.networks.find((n) => n.connected)?.band;
  const [band, setBand] = useState<Band>(ownBand ?? present[0] ?? "2.4");
  const [hover, setHover] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);

  const [lo, hi] = RANGE[band];
  const x = (mhz: number) => M.l + ((mhz - lo) / (hi - lo)) * (W - M.l - M.r);
  const y = (dbm: number) => M.t + ((DBM[1] - Math.max(DBM[0], Math.min(DBM[1], dbm))) / (DBM[1] - DBM[0])) * (H - M.t - M.b);
  const floor = y(DBM[0]);

  const nets = snap.networks.filter((n) => n.band === band).sort((a, b) => Number(a.connected) - Number(b.connected) || a.rssi - b.rssi);
  const best = snap.analysis?.bands.find((b) => b.band === band)?.candidates[0];
  const hump = (n: Bss) => {
    const x0 = x(n.lowMhz);
    const x1 = x(n.highMhz);
    const top = y(n.rssi);
    const dw = x1 - x0;
    return `M ${x0} ${floor} C ${x0 + dw * 0.18} ${top}, ${x0 + dw * 0.3} ${top}, ${(x0 + x1) / 2} ${top} C ${x1 - dw * 0.3} ${top}, ${x1 - dw * 0.18} ${top}, ${x1} ${floor} Z`;
  };

  // Labels for the loudest networks and the user's own, skipping any that would overlap.
  const placed: { x0: number; x1: number; y: number }[] = [];
  const labels = [...nets]
    .sort((a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi)
    .slice(0, 14)
    .flatMap((n) => {
      const text = nameOf(n, t("wifi.hidden"));
      const cx = x((n.lowMhz + n.highMhz) / 2);
      const w = Math.min(150, text.length * 6.2);
      const ly = y(n.rssi) - 6;
      const r = { x0: cx - w / 2, x1: cx + w / 2, y: ly };
      if (placed.some((p) => p.x0 < r.x1 && r.x0 < p.x1 && Math.abs(p.y - r.y) < 13)) return [];
      placed.push(r);
      return [{ n, text, cx, ly }];
    });
  const hovered = nets.find((n) => n.bssid === hover);

  return (
    <div className="rounded-card border border-line bg-surface p-4" data-testid="wifi-spectrum">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {present.map((b) => (
          <button
            key={b}
            onClick={() => setBand(b)}
            className={`rounded-md border px-2.5 py-1 text-[12px] transition-colors ${band === b ? "border-transparent text-bg" : "border-line text-muted hover:text-fg"}`}
            style={band === b ? { background: BAND_COLORS[b] } : undefined}
          >
            {b} {t("wifi.ghz")} · {snap.networks.filter((n) => n.band === b).length}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-muted">{t("wifi.adv.spectrumHint")}</span>
      </div>
      <div ref={box} className="relative" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={t("wifi.adv.tabs.spectrum")}>
          {/* grid */}
          {[-90, -80, -70, -60, -50, -40, -30].map((d) => (
            <g key={d}>
              <line x1={M.l} x2={W - M.r} y1={y(d)} y2={y(d)} stroke="var(--color-line)" strokeWidth={1} strokeDasharray={d === -70 ? "4 4" : undefined} opacity={0.6} />
              <text x={M.l - 8} y={y(d) + 3} textAnchor="end" className="num" fontSize={10} fill="var(--color-muted)">
                {d}
              </text>
            </g>
          ))}
          <text x={M.l - 8} y={M.t - 10} textAnchor="end" fontSize={10} fill="var(--color-muted)">
            dBm
          </text>
          {band === "5" && (
            <g>
              <rect x={x(5250)} y={M.t} width={x(5730) - x(5250)} height={floor - M.t} fill="var(--color-fg)" opacity={0.025} />
              <text x={(x(5250) + x(5730)) / 2} y={M.t - 8} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
                {t("wifi.adv.dfs")}
              </text>
            </g>
          )}
          {best && (
            <g>
              <rect x={x(best.lowMhz)} y={M.t} width={x(best.highMhz) - x(best.lowMhz)} height={floor - M.t} fill="var(--color-safe)" opacity={0.07} />
              <line x1={x(best.lowMhz)} x2={x(best.lowMhz)} y1={M.t} y2={floor} stroke="var(--color-safe)" strokeDasharray="3 4" opacity={0.6} />
              <line x1={x(best.highMhz)} x2={x(best.highMhz)} y1={M.t} y2={floor} stroke="var(--color-safe)" strokeDasharray="3 4" opacity={0.6} />
              <text x={(x(best.lowMhz) + x(best.highMhz)) / 2} y={M.t + 12} textAnchor="middle" fontSize={10} fill="var(--color-safe)">
                {t("wifi.adv.quietest", { n: best.channel })}
              </text>
            </g>
          )}
          {/* networks */}
          {nets.map((n) => {
            const own = n.connected;
            const colour = own ? "var(--color-accent)" : BAND_COLORS[band];
            const dim = hover && hover !== n.bssid;
            return (
              <path
                key={n.bssid}
                style={{ d: `path('${hump(n)}')`, transition: "d 0.9s cubic-bezier(.2,.8,.2,1), opacity .2s" } as React.CSSProperties}
                fill={colour}
                fillOpacity={own ? 0.22 : 0.07}
                stroke={colour}
                strokeOpacity={own ? 1 : 0.6}
                strokeWidth={own || hover === n.bssid ? 2.4 : 1.2}
                opacity={dim ? 0.25 : 1}
                onMouseMove={(e) => {
                  const r = box.current!.getBoundingClientRect();
                  setHover(n.bssid);
                  setTip({ x: e.clientX - r.left, y: e.clientY - r.top });
                }}
              />
            );
          })}
          {labels.map(({ n, text, cx, ly }) => (
            <text
              key={n.bssid}
              x={cx}
              y={ly}
              textAnchor="middle"
              fontSize={n.connected ? 12 : 10.5}
              fontWeight={n.connected ? 600 : 400}
              fill={n.connected ? "var(--color-fg)" : "var(--color-muted)"}
              style={{ transition: "all .9s", pointerEvents: "none" }}
            >
              {text}
            </text>
          ))}
          {/* axis */}
          <line x1={M.l} x2={W - M.r} y1={floor} y2={floor} stroke="var(--color-line)" />
          {TICKS[band].map((c) => (
            <g key={c}>
              <line x1={x(chMhz(band, c))} x2={x(chMhz(band, c))} y1={floor} y2={floor + 4} stroke="var(--color-muted)" />
              <text x={x(chMhz(band, c))} y={floor + 16} textAnchor="middle" fontSize={band === "5" ? 9 : 10} className="num" fill="var(--color-muted)">
                {c}
              </text>
            </g>
          ))}
          <text x={W - M.r} y={H - 4} textAnchor="end" fontSize={10} fill="var(--color-muted)">
            {t("wifi.adv.channel")}
          </text>
        </svg>
        {hovered && tip && <Tooltip n={hovered} x={tip.x} y={tip.y} />}
      </div>
    </div>
  );
}

function Tooltip({ n, x, y }: { n: Bss; x: number; y: number }) {
  const { t } = useTranslation();
  return (
    <div
      className="pointer-events-none absolute z-10 w-[230px] rounded-xl border border-line bg-bg/95 p-3 text-[11px] shadow-xl backdrop-blur"
      style={{ left: Math.min(x + 14, 9999), top: y + 14, transform: x > 600 ? "translateX(-110%)" : undefined }}
    >
      <div className="truncate text-[13px] font-medium text-fg">{nameOf(n, t("wifi.hidden"))}</div>
      <div className="num text-muted">{n.bssid}</div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-muted">{t("wifi.col.signal")}</dt>
        <dd className="num">{n.rssi} dBm</dd>
        <dt className="text-muted">{t("wifi.col.channel")}</dt>
        <dd className="num">
          {n.channel} · {n.width} {t("wifi.mhz")}
        </dd>
        <dt className="text-muted">{t("wifi.col.standard")}</dt>
        <dd>{n.generation ? `Wi-Fi ${n.generation}` : t("wifi.legacy")}</dd>
        <dt className="text-muted">{t("wifi.col.security")}</dt>
        <dd>{t(`wifi.security.${n.security}`)}</dd>
        {n.stations !== null && (
          <>
            <dt className="text-muted">{t("wifi.col.stations")}</dt>
            <dd className="num">{n.stations}</dd>
          </>
        )}
        {n.utilization !== null && (
          <>
            <dt className="text-muted">{t("wifi.col.load")}</dt>
            <dd className="num">{n.utilization}%</dd>
          </>
        )}
        <dt className="text-muted">{t("wifi.col.distance")}</dt>
        <dd className="num">~{n.distanceM < 10 ? n.distanceM.toFixed(1) : Math.round(n.distanceM)} {t("wifi.m")}</dd>
      </dl>
    </div>
  );
}

// ───────────────────────── signal over time ─────────────────────────

function Timeline() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const history = useWifi((s) => s.history);
  const linkHistory = useWifi((s) => s.linkHistory);
  const own = snap.networks.find((n) => n.connected);
  const ranked = useMemo(() => [...snap.networks].sort((a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi), [snap]);
  const [chosen, setChosen] = useState<string[] | null>(null);
  const shown = chosen ?? ranked.slice(0, 6).map((n) => n.bssid);
  const [hoverT, setHoverT] = useState<number | null>(null);

  const now = Date.now();
  const span = 5 * 60_000;
  const x = (t0: number) => M.l + ((t0 - (now - span)) / span) * (W - M.l - M.r);
  const y = (d: number) => M.t + ((DBM[1] - Math.max(DBM[0], Math.min(DBM[1], d))) / (DBM[1] - DBM[0])) * (H - M.t - M.b);
  const seriesOf = (bssid: string) => (own && bssid === own.bssid && linkHistory.length > 3 ? linkHistory : (history[bssid] ?? [])).filter((s) => s.t >= now - span);
  const line = (pts: { t: number; rssi: number }[]) => pts.map((p, i) => `${i ? "L" : "M"} ${x(p.t).toFixed(1)} ${y(p.rssi).toFixed(1)}`).join(" ");

  return (
    <div className="rounded-card border border-line bg-surface p-4" data-testid="wifi-timeline">
      <div className="mb-3 flex flex-wrap gap-1.5">
        {ranked.slice(0, 16).map((n) => {
          const on = shown.includes(n.bssid);
          const c = colourOf(n.bssid, n.connected);
          return (
            <button
              key={n.bssid}
              onClick={() => setChosen(on ? shown.filter((b) => b !== n.bssid) : [...shown, n.bssid].slice(-8))}
              className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${on ? "border-line text-fg" : "border-transparent text-muted hover:text-fg"}`}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: on ? c : "var(--color-line)" }} />
              {nameOf(n, t("wifi.hidden"))}
              <span className="text-muted">{n.band}</span>
            </button>
          );
        })}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHoverT(px < M.l ? null : now - span + ((px - M.l) / (W - M.l - M.r)) * span);
        }}
        onMouseLeave={() => setHoverT(null)}
      >
        {[-90, -80, -70, -60, -50, -40, -30].map((d) => (
          <g key={d}>
            <line x1={M.l} x2={W - M.r} y1={y(d)} y2={y(d)} stroke="var(--color-line)" opacity={0.6} />
            <text x={M.l - 8} y={y(d) + 3} textAnchor="end" fontSize={10} className="num" fill="var(--color-muted)">
              {d}
            </text>
          </g>
        ))}
        {[5, 4, 3, 2, 1, 0].map((m) => (
          <text key={m} x={x(now - m * 60_000)} y={H - 12} textAnchor="middle" fontSize={10} fill="var(--color-muted)">
            {m === 0 ? t("wifi.adv.now") : t("wifi.adv.minAgo", { n: m })}
          </text>
        ))}
        {shown.map((bssid) => {
          const pts = seriesOf(bssid);
          const n = snap.networks.find((x) => x.bssid === bssid);
          if (pts.length < 1) return null;
          const c = colourOf(bssid, !!n?.connected);
          return (
            <g key={bssid}>
              <path d={line(pts)} fill="none" stroke={c} strokeWidth={2} strokeLinejoin="round" />
              <circle cx={x(pts[pts.length - 1].t)} cy={y(pts[pts.length - 1].rssi)} r={4} fill={c} stroke="var(--color-surface)" strokeWidth={2} />
            </g>
          );
        })}
        {hoverT !== null && (
          <g>
            <line x1={x(hoverT)} x2={x(hoverT)} y1={M.t} y2={H - M.b} stroke="var(--color-muted)" strokeDasharray="3 3" />
            {shown.map((bssid, i) => {
              const pts = seriesOf(bssid);
              if (!pts.length) return null;
              const p = pts.reduce((a, b) => (Math.abs(b.t - hoverT) < Math.abs(a.t - hoverT) ? b : a));
              const n = snap.networks.find((x) => x.bssid === bssid);
              const c = colourOf(bssid, !!n?.connected);
              const tx = x(hoverT) + (x(hoverT) > W - 220 ? -12 : 12);
              return (
                <text key={bssid} x={tx} y={M.t + 14 + i * 15} textAnchor={x(hoverT) > W - 220 ? "end" : "start"} fontSize={11} fill="var(--color-fg)">
                  <tspan fill={c}>● </tspan>
                  {n ? nameOf(n, t("wifi.hidden")) : bssid}: <tspan className="num">{p.rssi} dBm</tspan>
                </text>
              );
            })}
          </g>
        )}
      </svg>
      <p className="mt-1 text-[11px] text-muted">{t("wifi.adv.timelineHint")}</p>
    </div>
  );
}

// ───────────────────────── table ─────────────────────────

type Col = "name" | "rssi" | "band" | "channel" | "width" | "generation" | "security" | "stations" | "utilization" | "distanceM";

function Table() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const firstSeen = useWifi((s) => s.firstSeen);
  const [sort, setSort] = useState<{ col: Col; desc: boolean }>({ col: "rssi", desc: true });
  // Networks that turned up after the page opened: someone switched on a hotspot nearby.
  const sessionStart = Math.min(...Object.values(firstSeen));
  const value = (n: Bss, c: Col): string | number => (c === "name" ? nameOf(n, "~").toLowerCase() : ((n[c] as number | string | null) ?? -1));
  const rows = [...snap.networks].sort((a, b) => {
    const [va, vb] = [value(a, sort.col), value(b, sort.col)];
    const r = va < vb ? -1 : va > vb ? 1 : 0;
    return sort.desc ? -r : r;
  });
  const cols: [Col, string][] = [
    ["name", t("wifi.col.network")],
    ["rssi", t("wifi.col.signal")],
    ["band", t("wifi.col.band")],
    ["channel", t("wifi.col.channel")],
    ["width", t("wifi.col.width")],
    ["generation", t("wifi.col.standard")],
    ["security", t("wifi.col.security")],
    ["stations", t("wifi.col.stations")],
    ["utilization", t("wifi.col.load")],
    ["distanceM", t("wifi.col.distance")],
  ];
  return (
    <div className="overflow-clip rounded-card border border-line bg-surface" data-testid="wifi-table">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[12px]">
          <thead className="text-[11px] text-muted">
            <tr className="border-b border-line">
              {cols.map(([c, label]) => (
                <th key={c} className="whitespace-nowrap px-3 py-2 font-normal">
                  <button onClick={() => setSort({ col: c, desc: sort.col === c ? !sort.desc : c !== "name" })} className="flex items-center gap-1 hover:text-fg">
                    {label}
                    {sort.col === c && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((n) => (
              <motion.tr layout="position" key={n.bssid} className={`border-b border-line/50 last:border-b-0 ${n.connected ? "bg-accent/[0.07]" : ""}`}>
                <td className="max-w-[260px] px-3 py-1.5">
                  <div className={`truncate ${n.hidden ? "italic text-muted" : ""}`}>
                    {nameOf(n, t("wifi.hidden"))}
                    {n.connected && <span className="ml-1.5 rounded bg-accent/15 px-1 text-[10px] text-accent">{t("wifi.yours")}</span>}
                    {!n.connected && snap.analysis?.mine.includes(n.bssid) && <span className="ml-1.5 rounded bg-raised px-1 text-[10px] text-muted">{t("wifi.yourRouter")}</span>}
                    {firstSeen[n.bssid] - sessionStart > 20_000 && Date.now() - firstSeen[n.bssid] < 120_000 && (
                      <span className="ml-1.5 rounded bg-safe/15 px-1 text-[10px] text-safe">{t("wifi.adv.new")}</span>
                    )}
                  </div>
                  <div className="num text-[10px] text-muted">
                    {n.bssid}
                    {n.randomMac && <span title={t("wifi.adv.virtualHint")}> · {t("wifi.adv.virtual")}</span>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3">
                  <span className="flex items-center gap-1.5">
                    <Bars rssi={n.rssi} size={14} />
                    <span className="num">{n.rssi}</span>
                  </span>
                </td>
                <td className="px-3" style={{ color: BAND_COLORS[n.band] }}>
                  {n.band}
                </td>
                <td className="num px-3">{n.channel}</td>
                <td className="num px-3">{n.width}</td>
                <td className="whitespace-nowrap px-3">{n.generation ? `Wi-Fi ${n.generation}` : t("wifi.legacy")}</td>
                <td className={`whitespace-nowrap px-3 ${["open", "wep", "wpa"].includes(n.security) || n.tkip ? "text-warn" : ""}`}>
                  {t(`wifi.security.${n.security}`)}
                  {n.tkip && !["wep", "wpa"].includes(n.security) && (
                    <span className="ml-1 text-[10px] text-warn" title={t("wifi.adv.tkip")}>
                      TKIP
                    </span>
                  )}
                  {n.wps && <span className="ml-1 text-[10px] text-muted">WPS</span>}
                </td>
                <td className="num px-3 text-muted">{n.stations ?? "—"}</td>
                <td className="num px-3 text-muted">{n.utilization !== null ? `${n.utilization}%` : "—"}</td>
                <td className="num whitespace-nowrap px-3 text-muted">~{n.distanceM < 10 ? n.distanceM.toFixed(1) : Math.round(n.distanceM)} {t("wifi.m")}</td>
              </motion.tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ───────────────────────── shell ─────────────────────────

export function Advanced() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const [tab, setTab] = useState<Tab>("spectrum");
  const [huntTarget, setHuntTarget] = useState<string | null>(null);
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-1 border-b border-line">
        {TABS.map(([id, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            data-testid={`wifi-tab-${id}`}
            className={`relative flex items-center gap-1.5 px-3 pb-2.5 pt-1 text-[13px] transition-colors ${tab === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            <Icon size={14} />
            {t(`wifi.adv.tabs.${id}`)}
            {tab === id && <motion.span layoutId="wifi-tab" className="absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-accent" />}
          </button>
        ))}
      </div>
      {tab === "spectrum" && (
        <>
          <Spectrum />
          {snap.analysis && <AdviceList analysis={snap.analysis} />}
        </>
      )}
      {tab === "timeline" && <Timeline />}
      {tab === "table" && <Table />}
      {tab === "echo" && (
        <Suspense
          fallback={
            <div className="flex h-[560px] items-center justify-center rounded-card border border-line bg-surface">
              <Loader2 className="animate-spin text-accent" />
            </div>
          }
        >
          <Echo3D
            onHunt={(bssid) => {
              setHuntTarget(bssid);
              setTab("hunt");
            }}
          />
        </Suspense>
      )}
      {tab === "hunt" && <Hunt key={huntTarget ?? "own"} initial={huntTarget} />}
    </div>
  );
}
