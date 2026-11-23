import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, BellRing, Cpu, Eye, EyeOff, Gauge, Info, MemoryStick, MonitorPlay, ShieldAlert, Thermometer, Wifi, WifiOff, X, Zap } from "lucide-react";
import type { OverlaySettings, Tick } from "../lib/overlay";
import { OPEN_KEY, TOGGLE_KEY } from "../lib/overlay";

const SPRING = { type: "spring", stiffness: 380, damping: 30, mass: 0.9 } as const;
const GREEN = "#4ade80";
const AMBER = "#fbbf24";
const RED = "#f87171";
const BLUE = "#60a5fa";
const HISTORY = 60;

interface Alert {
  kind: string;
  level: "info" | "warn" | "risk";
  title: string;
  body: string;
  at: number;
}

const push = (a: number[], v: number) => [...a, v].slice(-HISTORY);
const tone = (v: number | null, warn: number, risk: number) => (v === null ? "rgba(255,255,255,0.5)" : v >= risk ? RED : v >= warn ? AMBER : "#fff");
const fpsTone = (fps: number) => (fps >= 55 ? GREEN : fps >= 30 ? AMBER : RED);
const pingTone = (ms: number | null) => (ms === null ? RED : ms >= 120 ? RED : ms >= 60 ? AMBER : GREEN);

/** Four little bars, filled by signal strength. */
function Bars({ rssi }: { rssi: number | null }) {
  const level = rssi === null ? 0 : rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <span className="flex h-[11px] items-end gap-[2px]">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} className="w-[3px] rounded-[1px]" style={{ height: 4 + i * 2.4, background: i < level ? "#fff" : "rgba(255,255,255,0.22)" }} />
      ))}
    </span>
  );
}

/** A small line chart for the panel. */
function Line({ data, color, max }: { data: number[]; color: string; max?: number }) {
  const h = 26;
  const top = Math.max(max ?? Math.max(...data, 1), 1);
  const step = 100 / (HISTORY - 1);
  const off = HISTORY - data.length;
  const pts = data.map((v, i) => `${((off + i) * step).toFixed(2)},${(h - 2 - (Math.min(v, top) / top) * (h - 4)).toFixed(2)}`);
  if (pts.length < 2) return <div style={{ height: h }} />;
  const line = `M${pts.join(" L")}`;
  return (
    <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="block w-full" style={{ height: h }}>
      <defs>
        <linearGradient id={`g${color.slice(1)}`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L100,${h} L${(off * step).toFixed(2)},${h} Z`} fill={`url(#g${color.slice(1)})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function Seg({ icon, children, title }: { icon: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" title={title}>
      <span className="text-white/45">{icon}</span>
      {children}
    </span>
  );
}

function Tile({ label, value, color, data, max, sub }: { label: string; value: string; color: string; data: number[]; max?: number; sub?: string }) {
  return (
    <div className="rounded-[18px] bg-white/[0.06] px-3 pb-1.5 pt-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[0.6875rem] text-white/50">{label}</span>
        <span className="tabular-nums text-[0.9375rem] font-semibold" style={{ color: color === BLUE ? "#fff" : color }}>
          {value}
        </span>
      </div>
      {sub && <div className="tabular-nums -mt-0.5 text-right text-[0.625rem] text-white/40">{sub}</div>}
      <Line data={data} color={color} max={max} />
    </div>
  );
}

export function Overlay() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<OverlaySettings | null>(null);
  const [cpu, setCpu] = useState<number | null>(null);
  const [ram, setRam] = useState<number | null>(null);
  const [tick, setTick] = useState<Tick | null>(null);
  const [hist, setHist] = useState({ cpu: [] as number[], gpu: [] as number[], ram: [] as number[], ping: [] as number[], frame: [] as number[] });
  const [alert, setAlert] = useState<Alert | null>(null);
  const [open, setOpen] = useState(false);
  const island = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The window is transparent: only the island is drawn.
    for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
      if (el) el.style.background = "transparent";
    }
    invoke<OverlaySettings>("overlay_settings").then(setSettings);
    const offs = [
      listen<OverlaySettings>("overlay:settings", ({ payload }) => setSettings(payload)),
      listen<{ cpuUsage: number; memUsed: number; memTotal: number }>("metrics", ({ payload }) => {
        const c = Math.round(payload.cpuUsage);
        const r = Math.round((payload.memUsed / Math.max(1, payload.memTotal)) * 100);
        setCpu(c);
        setRam(r);
        setHist((h) => ({ ...h, cpu: push(h.cpu, c), ram: push(h.ram, r) }));
      }),
      listen<Tick>("overlay:tick", ({ payload }) => {
        setTick(payload);
        setHist((h) => ({
          ...h,
          gpu: payload.gpuLoad !== null ? push(h.gpu, payload.gpuLoad) : h.gpu,
          ping: push(h.ping, payload.internetMs ?? 0),
          frame: payload.fps ? push(h.frame, payload.fps.frameMs) : h.frame,
        }));
      }),
      listen<Omit<Alert, "at">>("overlay:alert", ({ payload }) => setAlert({ ...payload, at: Date.now() })),
      listen<boolean>("overlay:interactive", ({ payload }) => setOpen(payload)),
    ];
    return () => offs.forEach((p) => p.then((off) => off()));
  }, []);

  // An alert stays for eight seconds.
  useEffect(() => {
    if (!alert) return;
    const id = window.setTimeout(() => setAlert(null), 8000);
    return () => window.clearTimeout(id);
  }, [alert]);

  // The panel closes on Escape or a click beside it; clicks then pass through again.
  useEffect(() => {
    if (!open) return;
    const close = () => invoke("overlay_interactive", { on: false });
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    const down = (e: PointerEvent) => island.current && !island.current.contains(e.target as Node) && close();
    window.addEventListener("keydown", key);
    document.addEventListener("pointerdown", down);
    return () => {
      window.removeEventListener("keydown", key);
      document.removeEventListener("pointerdown", down);
    };
  }, [open]);

  if (!settings) return null;
  const fps = settings.fps ? tick?.fps ?? null : null;
  const temp = [tick?.cpuTemp, tick?.gpuTemp].filter((x): x is number => typeof x === "number");
  const hot = temp.length ? Math.max(...temp) : null;
  const ping = tick?.internetMs ?? null;
  const offline = !!tick && settings.net && ping === null && !tick.online && tick.loss !== null;
  // Online, yet not one ping comes back: this network drops pings, so "loss" would be made up.
  const loss = offline || (ping === null && tick?.loss === 100) ? 0 : (tick?.loss ?? 0);
  const mode = open ? "panel" : alert ? "alert" : "pill";
  const LevelIcon = alert?.level === "risk" ? ShieldAlert : alert?.level === "warn" ? AlertTriangle : alert?.kind === "test" ? BellRing : Info;
  const levelColor = alert?.level === "risk" ? RED : alert?.level === "warn" ? AMBER : BLUE;

  return (
    <div className="flex h-screen w-screen select-none justify-center pt-1.5 font-sans text-white" data-testid="overlay">
      <LayoutGroup>
        <motion.div
          ref={island}
          layout
          transition={SPRING}
          style={{ borderRadius: mode === "pill" ? 999 : mode === "alert" ? 30 : 32 }}
          className="relative h-fit overflow-hidden bg-black shadow-[0_10px_40px_-6px_rgba(0,0,0,0.7),inset_0_0_0_1px_rgba(255,255,255,0.09)]"
          data-testid="overlay-island"
          data-mode={mode}
        >
          <AnimatePresence mode="popLayout" initial={false}>
            {mode === "pill" && (
              <motion.div
                key="pill"
                layout="position"
                initial={{ opacity: 0, filter: "blur(6px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(6px)" }}
                className="tabular-nums flex h-[36px] items-center gap-3.5 px-4 text-[0.75rem] font-medium"
              >
                {fps ? (
                  <span className="flex items-baseline gap-1" data-testid="overlay-fps">
                    <motion.span className="mr-0.5 inline-block h-[7px] w-[7px] self-center rounded-full" style={{ background: fpsTone(fps.fps) }} animate={{ opacity: [1, 0.35, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />
                    <span className="text-[0.9375rem] font-semibold" style={{ color: fpsTone(fps.fps) }}>
                      {Math.round(fps.fps)}
                    </span>
                    <span className="text-[0.625rem] text-white/45">FPS</span>
                  </span>
                ) : (
                  <Eye size={14} className="text-white/70" />
                )}
                {settings.pc && (
                  <>
                    <Seg icon={<Cpu size={12} />} title={t("overlay.cpu")}>
                      <span style={{ color: tone(cpu, 75, 92) }}>{cpu ?? "—"}%</span>
                    </Seg>
                    {tick?.gpuLoad !== null && tick?.gpuLoad !== undefined && (
                      <Seg icon={<MonitorPlay size={12} />} title={t("overlay.gpu")}>
                        <span style={{ color: tone(tick.gpuLoad, 85, 98) }}>{tick.gpuLoad}%</span>
                      </Seg>
                    )}
                    <Seg icon={<MemoryStick size={12} />} title={t("overlay.ram")}>
                      <span style={{ color: tone(ram, 85, 93) }}>{ram ?? "—"}%</span>
                    </Seg>
                    {hot !== null && (
                      <Seg icon={<Thermometer size={12} />} title={t("overlay.temp")}>
                        <span style={{ color: tone(hot, 82, 92) }}>{hot}°</span>
                      </Seg>
                    )}
                  </>
                )}
                {settings.net && tick && (
                  <Seg icon={offline ? <WifiOff size={12} /> : tick.wifi ? <Bars rssi={tick.wifi.rssi} /> : <Zap size={12} />} title={t("overlay.ping")}>
                    <span style={{ color: pingTone(ping) }}>{ping !== null ? `${ping} ${t("overlay.ms")}` : offline ? t("overlay.offline") : "—"}</span>
                    {loss > 0 && <span className="text-[0.625rem]" style={{ color: RED }}>−{loss}%</span>}
                  </Seg>
                )}
              </motion.div>
            )}

            {mode === "alert" && alert && (
              <motion.div
                key={`alert${alert.at}`}
                layout="position"
                initial={{ opacity: 0, filter: "blur(8px)", scale: 0.96 }}
                animate={{ opacity: 1, filter: "blur(0px)", scale: 1 }}
                exit={{ opacity: 0, filter: "blur(8px)" }}
                className="relative flex w-[25rem] items-start gap-3 py-3.5 pl-3.5 pr-4"
                data-testid="overlay-alert"
              >
                <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full" style={{ background: `${levelColor}22`, color: levelColor }}>
                  <motion.span className="absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 1px ${levelColor}` }} animate={{ scale: [1, 1.35], opacity: [0.7, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
                  <LevelIcon size={19} />
                </span>
                <div className="min-w-0 flex-1 pt-0.5">
                  <div className="text-[0.8125rem] font-semibold leading-snug">{alert.title}</div>
                  <div className="mt-0.5 line-clamp-2 text-[0.75rem] leading-snug text-white/60">{alert.body}</div>
                </div>
                <motion.span className="absolute bottom-0 left-6 right-6 h-[2px] origin-left rounded-full" style={{ background: levelColor }} initial={{ scaleX: 1, opacity: 0.6 }} animate={{ scaleX: 0 }} transition={{ duration: 8, ease: "linear" }} />
              </motion.div>
            )}

            {mode === "panel" && (
              <motion.div
                key="panel"
                layout="position"
                initial={{ opacity: 0, filter: "blur(8px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                exit={{ opacity: 0, filter: "blur(8px)" }}
                className="w-[27.5rem] p-3.5"
                data-testid="overlay-panel"
              >
                <div className="mb-3 flex items-center gap-2 px-1">
                  <Eye size={15} className="text-white/70" />
                  <span className="text-[0.8125rem] font-semibold">DelphEye</span>
                  <span className="ml-auto text-[0.625rem] text-white/35">{t("overlay.keys", { open: OPEN_KEY, toggle: TOGGLE_KEY })}</span>
                  <button onClick={() => invoke("overlay_interactive", { on: false })} className="ml-1 rounded-full p-1 text-white/50 hover:bg-white/10 hover:text-white" aria-label={t("overlay.close")}>
                    <X size={14} />
                  </button>
                </div>

                {settings.fps && (
                  <div className="mb-2 rounded-[18px] bg-white/[0.06] px-3 pb-1.5 pt-2.5" data-testid="overlay-fps-tile">
                    {fps ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className="tabular-nums text-[1.625rem] font-semibold leading-none" style={{ color: fpsTone(fps.fps) }}>
                            {Math.round(fps.fps)}
                          </span>
                          <span className="text-[0.6875rem] text-white/50">FPS · {fps.app}</span>
                          <span className="tabular-nums ml-auto text-[0.6875rem] text-white/50">{t("overlay.frame", { avg: fps.frameMs, worst: fps.worstMs })}</span>
                        </div>
                        <Line data={hist.frame} color={fpsTone(fps.fps)} />
                      </>
                    ) : tick?.fpsStatus === "off" ? (
                      <div className="flex items-center gap-3 py-1">
                        <Gauge size={18} className="shrink-0 text-white/50" />
                        <div className="min-w-0 flex-1 text-[0.6875rem] leading-snug text-white/60">{t("overlay.fpsAdmin")}</div>
                        <button onClick={() => invoke("relaunch_elevated")} className="shrink-0 rounded-full bg-white px-3 py-1.5 text-[0.6875rem] font-semibold text-black hover:bg-white/85">
                          {t("overlay.asAdmin")}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 py-1.5 text-[0.6875rem] text-white/55">
                        <Gauge size={18} className="shrink-0 text-white/50" />
                        {tick?.fpsStatus === "failed" ? t("overlay.fpsFailed") : t("overlay.fpsWaiting")}
                      </div>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-2">
                  <Tile label={t("overlay.cpu")} value={`${cpu ?? "—"}%`} sub={tick?.cpuTemp ? `${tick.cpuTemp} °C` : undefined} color={cpu !== null && cpu >= 92 ? RED : BLUE} data={hist.cpu} max={100} />
                  <Tile
                    label={t("overlay.gpu")}
                    value={tick?.gpuLoad !== null && tick?.gpuLoad !== undefined ? `${tick.gpuLoad}%` : "—"}
                    sub={tick?.gpuTemp ? `${tick.gpuTemp} °C` : undefined}
                    color="#a78bfa"
                    data={hist.gpu}
                    max={100}
                  />
                  <Tile label={t("overlay.ram")} value={`${ram ?? "—"}%`} color={ram !== null && ram >= 93 ? RED : "#38bdf8"} data={hist.ram} max={100} />
                  <Tile
                    label={t("overlay.ping")}
                    value={ping !== null ? `${ping} ${t("overlay.ms")}` : "—"}
                    sub={loss ? t("overlay.loss", { pct: loss }) : tick?.routerMs !== null && tick?.routerMs !== undefined ? t("overlay.router", { ms: tick.routerMs }) : undefined}
                    color={pingTone(ping)}
                    data={hist.ping}
                  />
                </div>

                {tick?.wifi && (
                  <div className="mt-2 flex items-center gap-2 rounded-[14px] bg-white/[0.04] px-3 py-2 text-[0.6875rem] text-white/60">
                    <Wifi size={13} />
                    <span className="truncate text-white/85">{tick.wifi.ssid}</span>
                    <Bars rssi={tick.wifi.rssi} />
                    <span className="tabular-nums ml-auto">{tick.wifi.rssi} dBm</span>
                  </div>
                )}

                <div className="mt-3 flex gap-2">
                  <button onClick={() => invoke("overlay_open_main", { page: null })} className="flex-1 rounded-full bg-white py-2 text-[0.75rem] font-semibold text-black hover:bg-white/85" data-testid="overlay-open-main">
                    {t("overlay.openApp")}
                  </button>
                  <button
                    onClick={() => invoke("overlay_save", { settings: { ...settings, enabled: false } })}
                    className="flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-[0.75rem] text-white/80 hover:bg-white/15"
                  >
                    <EyeOff size={13} />
                    {t("overlay.hide")}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </LayoutGroup>
    </div>
  );
}
