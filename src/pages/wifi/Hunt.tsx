import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useSpring, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";
import { Footprints, Minus, Trash2, TrendingDown, TrendingUp, Volume2, VolumeX } from "lucide-react";
import { Button, Sparkline } from "../../components/ui";
import { LEVEL_COLOR, nameOf, percent, signalLevel, useWifi, type Sample } from "../../lib/wifi";

interface Room {
  room: string;
  rssi: number;
  ssid: string;
  at: number;
}

const SURVEY_KEY = "wifi.survey";
const loadSurvey = (): Room[] => {
  try {
    return JSON.parse(localStorage.getItem(SURVEY_KEY) ?? "[]");
  } catch {
    return [];
  }
};
const saveSurvey = (rooms: Room[]) => {
  try {
    localStorage.setItem(SURVEY_KEY, JSON.stringify(rooms));
  } catch {
    /* kept for this session only */
  }
};

/** The signal of one access point over time: once a second for the connection, per scan otherwise. */
function useSeries(bssid: string | null): { samples: Sample[]; live: boolean } {
  const snap = useWifi((s) => s.snap);
  const history = useWifi((s) => s.history);
  const linkHistory = useWifi((s) => s.linkHistory);
  const link = useWifi((s) => s.link);
  const live = !!bssid && link?.bssid === bssid;
  return useMemo(
    () => ({ samples: live ? linkHistory.slice(-90) : bssid ? (history[bssid] ?? []).slice(-90) : [], live }),
    [live, linkHistory, history, bssid, snap],
  );
}

const GAUGE_MIN = -95;
const GAUGE_MAX = -30;

function Gauge({ rssi }: { rssi: number }) {
  const spring = useSpring(rssi, { stiffness: 90, damping: 16 });
  useEffect(() => spring.set(rssi), [rssi, spring]);
  const angle = useTransform(spring, (v) => -90 + ((Math.max(GAUGE_MIN, Math.min(GAUGE_MAX, v)) - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * 180);
  const r = 120;
  const arc = (from: number, to: number) => {
    const a = (v: number) => Math.PI + ((v - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * Math.PI;
    const p = (v: number) => [150 + r * Math.cos(a(v)), 150 + r * Math.sin(a(v))];
    const [x0, y0] = p(from);
    const [x1, y1] = p(to);
    return `M ${x0} ${y0} A ${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  const zones: [number, number, string][] = [
    [GAUGE_MIN, -82, "var(--color-risk)"],
    [-82, -75, "var(--color-warn)"],
    [-75, -67, "#c9d65a"],
    [-67, GAUGE_MAX, "var(--color-safe)"],
  ];
  return (
    <svg viewBox="0 0 300 170" className="w-full max-w-[360px]">
      {zones.map(([a, b, c]) => (
        <path key={a} d={arc(a, b)} stroke={c} strokeWidth={14} fill="none" opacity={0.85} />
      ))}
      {[-90, -80, -70, -60, -50, -40].map((v) => {
        const a = Math.PI + ((v - GAUGE_MIN) / (GAUGE_MAX - GAUGE_MIN)) * Math.PI;
        return (
          <text key={v} x={150 + 96 * Math.cos(a)} y={150 + 96 * Math.sin(a) + 3} textAnchor="middle" fontSize={9} className="num" fill="var(--color-muted)">
            {v}
          </text>
        );
      })}
      <motion.g style={{ rotate: angle, originX: "150px", originY: "150px" }}>
        <line x1={150} y1={150} x2={150} y2={44} stroke="var(--color-fg)" strokeWidth={3} strokeLinecap="round" />
      </motion.g>
      <circle cx={150} cy={150} r={8} fill="var(--color-fg)" />
    </svg>
  );
}

/** A sonar ping that repeats faster and higher the stronger the signal. */
function useSonar(on: boolean, rssi: number | null) {
  const ctx = useRef<AudioContext | null>(null);
  const latest = useRef(rssi);
  latest.current = rssi;
  useEffect(() => {
    if (!on) return;
    ctx.current ??= new AudioContext();
    let timer = 0;
    const ping = () => {
      const v = latest.current;
      const strength = v === null ? 0 : Math.max(0, Math.min(1, (v + 95) / 60));
      const ac = ctx.current!;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = "sine";
      osc.frequency.value = 420 + strength * 980;
      gain.gain.setValueAtTime(0.0001, ac.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, ac.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.22);
      osc.connect(gain).connect(ac.destination);
      osc.start();
      osc.stop(ac.currentTime + 0.25);
      timer = window.setTimeout(ping, 1500 - strength * 1320);
    };
    ping();
    return () => window.clearTimeout(timer);
  }, [on]);
}

export function Hunt({ initial }: { initial?: string | null }) {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap)!;
  const own = snap.networks.find((n) => n.connected);
  const [target, setTarget] = useState<string | null>(initial ?? own?.bssid ?? snap.networks[0]?.bssid ?? null);
  const [sound, setSound] = useState(false);
  const { samples, live } = useSeries(target);
  const net = snap.networks.find((n) => n.bssid === target);
  const rssi = samples.length ? samples[samples.length - 1].rssi : (net?.rssi ?? null);
  useSonar(sound, rssi);

  // Warmer / colder: the last few readings against the few before them.
  const trend = useMemo(() => {
    const n = live ? 4 : 2;
    if (samples.length < n * 2) return 0;
    const avg = (xs: Sample[]) => xs.reduce((a, b) => a + b.rssi, 0) / xs.length;
    const d = avg(samples.slice(-n)) - avg(samples.slice(-2 * n, -n));
    // Scans jump by a few dB on their own: ask for a bigger change before calling it.
    const step = live ? 2 : 3;
    return d >= step ? 1 : d <= -step ? -1 : 0;
  }, [samples, live]);

  const [rooms, setRooms] = useState<Room[]>(loadSurvey);
  const [room, setRoom] = useState("");
  const [measuring, setMeasuring] = useState(false);
  const measure = async () => {
    if (!room.trim() || !net) return;
    setMeasuring(true);
    // Average five seconds of readings: a single one jumps by several dB.
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 5200));
    const st = useWifi.getState();
    const pool = (st.link?.bssid === net.bssid ? st.linkHistory : (st.history[net.bssid] ?? [])).filter((s) => s.t >= start - (st.link?.bssid === net.bssid ? 0 : 8000));
    const value = pool.length ? Math.round(pool.reduce((a, b) => a + b.rssi, 0) / pool.length) : (rssi ?? net.rssi);
    const next = [...rooms.filter((r) => !(r.room === room.trim() && r.ssid === net.ssid)), { room: room.trim(), rssi: value, ssid: net.ssid, at: Date.now() }];
    setRooms(next);
    saveSurvey(next);
    setRoom("");
    setMeasuring(false);
  };
  const surveyed = rooms.filter((r) => r.ssid === net?.ssid).sort((a, b) => b.rssi - a.rssi);

  const level = rssi !== null ? signalLevel(rssi) : "bad";
  const TrendIcon = trend > 0 ? TrendingUp : trend < 0 ? TrendingDown : Minus;

  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]" data-testid="wifi-hunt">
      <div className="rounded-card border border-line bg-surface p-5">
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={target ?? ""}
            onChange={(e) => setTarget(e.target.value)}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none"
            data-testid="hunt-target"
          >
            {[...snap.networks]
              .sort((a, b) => Number(b.connected) - Number(a.connected) || b.rssi - a.rssi)
              .map((n) => (
                <option key={n.bssid} value={n.bssid}>
                  {nameOf(n, t("wifi.hidden"))} · {n.band} {t("wifi.ghz")} · {n.bssid.slice(-8)}
                  {n.connected ? ` · ${t("wifi.yours")}` : ""}
                </option>
              ))}
          </select>
          <Button variant={sound ? "primary" : "ghost"} icon={sound ? <Volume2 size={15} /> : <VolumeX size={15} />} onClick={() => setSound(!sound)} data-testid="hunt-sound">
            {t("wifi.hunt.sound")}
          </Button>
        </div>

        <div className="relative mt-4 flex flex-col items-center">
          {/* sonar rings, faster with a stronger signal */}
          <div className="pointer-events-none absolute left-1/2 top-[52%] -translate-x-1/2 -translate-y-1/2">
            {[0, 1, 2].map((i) => (
              <motion.span
                key={`${i}-${level}`}
                className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full border"
                style={{ borderColor: LEVEL_COLOR[level] }}
                initial={{ scale: 0.3, opacity: 0.5 }}
                animate={{ scale: 2.1, opacity: 0 }}
                transition={{ duration: rssi === null ? 3 : 3.2 - ((Math.max(-95, rssi) + 95) / 60) * 2.2, repeat: Infinity, delay: i * 0.7, ease: "easeOut" }}
              />
            ))}
          </div>
          <Gauge rssi={rssi ?? GAUGE_MIN} />
          <div className="mt-1 text-center">
            <div className="num font-display text-[40px] font-semibold leading-none" data-testid="hunt-value">
              {rssi ?? "—"}
              <span className="ml-1 text-[16px] text-muted">dBm</span>
            </div>
            <div className="mt-1 text-[13px]" style={{ color: LEVEL_COLOR[level] }}>
              {rssi !== null ? `${percent(rssi)}% · ${t(`wifi.signal.${level}`)}` : t("wifi.hunt.noSignal")}
            </div>
          </div>
          <AnimatePresence mode="wait">
            <motion.div
              key={trend}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className={`mt-3 flex items-center gap-2 rounded-full px-4 py-1.5 text-[13px] ${trend > 0 ? "bg-risk/15 text-risk" : trend < 0 ? "bg-accent/15 text-accent" : "bg-raised text-muted"}`}
              data-testid="hunt-trend"
            >
              <TrendIcon size={15} />
              {t(`wifi.hunt.trend.${trend > 0 ? "warmer" : trend < 0 ? "colder" : "same"}`)}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="mt-4">
          <Sparkline data={samples.map((s) => s.rssi + 100)} color={LEVEL_COLOR[level]} max={70} height={54} points={live ? 90 : 30} />
          <p className="mt-2 text-[11px] leading-relaxed text-muted">{live ? t("wifi.hunt.liveHint") : t("wifi.hunt.scanHint")}</p>
          {net && (
            <p className="mt-1 text-[11px] text-muted">
              {t("wifi.hunt.distance", { m: net.distanceM < 10 ? net.distanceM.toFixed(1) : Math.round(net.distanceM) })}
            </p>
          )}
        </div>
      </div>

      <div className="rounded-card border border-line bg-surface p-5">
        <h3 className="flex items-center gap-2 text-[14px] font-medium">
          <Footprints size={16} className="text-accent" />
          {t("wifi.hunt.surveyTitle")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{t("wifi.hunt.surveyText")}</p>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            measure();
          }}
        >
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            placeholder={t("wifi.hunt.roomPlaceholder")}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[13px] outline-none placeholder:text-muted/60 focus:border-accent/60"
            maxLength={40}
            data-testid="hunt-room"
          />
          <Button type="submit" variant="primary" disabled={!room.trim() || measuring || !net} data-testid="hunt-measure">
            {measuring ? t("wifi.hunt.measuring") : t("wifi.hunt.measure")}
          </Button>
        </form>
        {surveyed.length > 0 ? (
          <ul className="mt-4 grid gap-2">
            {surveyed.map((r) => {
              const lv = signalLevel(r.rssi);
              return (
                <li key={r.room} className="group flex items-center gap-3">
                  <span className="w-28 truncate text-[12px]">{r.room}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                    <motion.span className="block h-full rounded-full" style={{ background: LEVEL_COLOR[lv] }} initial={{ width: 0 }} animate={{ width: `${percent(r.rssi)}%` }} />
                  </span>
                  <span className="num w-16 text-right text-[11px] text-muted">{r.rssi} dBm</span>
                  <button
                    onClick={() => {
                      const next = rooms.filter((x) => x !== r);
                      setRooms(next);
                      saveSurvey(next);
                    }}
                    className="text-muted opacity-0 transition-opacity hover:text-risk group-hover:opacity-100"
                    aria-label={t("wifi.hunt.remove")}
                  >
                    <Trash2 size={13} />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12px] text-muted">{t("wifi.hunt.surveyEmpty")}</p>
        )}
        {surveyed.length >= 2 && (
          <p className="mt-3 text-[12px] leading-relaxed text-muted">
            {signalLevel(surveyed[surveyed.length - 1].rssi) === "weak" || signalLevel(surveyed[surveyed.length - 1].rssi) === "bad"
              ? t("wifi.hunt.deadZone", { room: surveyed[surveyed.length - 1].room })
              : t("wifi.hunt.allCovered")}
          </p>
        )}
      </div>
    </div>
  );
}
