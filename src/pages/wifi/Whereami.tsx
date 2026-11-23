import { useState } from "react";
import { motion } from "motion/react";
import { create } from "zustand";
import { useTranslation } from "react-i18next";
import { Fingerprint, Loader2, Trash2 } from "lucide-react";
import { Button } from "../../components/ui";
import { useWifi } from "../../lib/wifi";

/**
 * "Where am I": every spot in a home hears the 30–40 access points around (the neighbours' too) at
 * its own mix of strengths. Remember that mix once per room; later the closest remembered mix
 * names the room the laptop is in.
 */
interface Place {
  name: string;
  x?: number;
  y?: number;
  /** Signal per access point, dBm. */
  vec: Record<string, number>;
}

const KEY = "wifi.places";
const load = (): Record<string, Place[]> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
};
const usePlaces = create<{ all: Record<string, Place[]> }>(() => ({ all: load() }));
const setPlaces = (planKey: string, list: Place[]) => {
  const all = { ...usePlaces.getState().all, [planKey]: list };
  usePlaces.setState({ all });
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* this session only */
  }
};

const FLOOR = -95;
/** What one side missing an access point costs: far ones come and go between scans. */
const MISSING = 6;

/**
 * Mean difference in dB over the access points heard clearly at either end. Access points heard
 * only on one side cost a fixed amount rather than the full gap to silence: weak, far ones blink in
 * and out of scans and would otherwise swamp the comparison.
 */
export function distance(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => (a[k] ?? FLOOR) > -80 || (b[k] ?? FLOOR) > -80));
  if (!keys.size) return Infinity;
  let sum = 0;
  for (const k of keys) sum += a[k] !== undefined && b[k] !== undefined ? Math.abs(a[k] - b[k]) : MISSING;
  return sum / keys.size;
}

/** The remembered place closest to what is heard now, and how clearly it wins. */
function useGuess(planKey: string) {
  const places = usePlaces((s) => s.all[planKey]) ?? [];
  const snap = useWifi((s) => s.snap);
  return guessFrom(places, snap);
}

/** The same, outside React (the 3D scene asks once per scan). */
export function guessNow(planKey: string) {
  return guessFrom(usePlaces.getState().all[planKey] ?? [], useWifi.getState().snap);
}

function guessFrom(places: Place[], snap: ReturnType<typeof useWifi.getState>["snap"]) {
  if (!snap || places.length === 0) return null;
  const now = Object.fromEntries(snap.networks.map((n) => [n.bssid, n.rssi]));
  const ranked = places.map((p) => ({ p, d: distance(now, p.vec) })).sort((a, b) => a.d - b.d);
  // With one place there is nothing to tell it from: at best "roughly".
  const confidence =
    ranked.length > 1 ? (ranked[1].d - ranked[0].d >= 4 ? "good" : ranked[1].d - ranked[0].d >= 2 ? "rough" : "unsure") : ranked[0].d <= 6 ? "rough" : "unsure";
  return { place: ranked[0].p, d: ranked[0].d, confidence } as const;
}

function Marker({ scale, planKey }: { scale: number; planKey: string }) {
  const guess = useGuess(planKey);
  if (!guess || guess.place.x === undefined || guess.place.y === undefined || guess.confidence === "unsure") return null;
  const { x, y } = guess.place as Required<Place>;
  return (
    <g pointerEvents="none">
      <motion.circle cx={x * scale} cy={y * scale} r={10} fill="none" stroke="#F5A35C" strokeWidth={2} animate={{ r: [10, 26], opacity: [0.9, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
      <circle cx={x * scale} cy={y * scale} r={8} fill="#F5A35C" stroke="var(--color-bg)" strokeWidth={2} />
    </g>
  );
}

export function Whereami({ planKey, cursor }: { planKey: string; cursor: { x: number; y: number } | null }) {
  const { t } = useTranslation();
  const places = usePlaces((s) => s.all[planKey]) ?? [];
  const guess = useGuess(planKey);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const remember = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const start = Date.now();
    // Two scans' worth, averaged per access point.
    await new Promise((r) => setTimeout(r, 10_000));
    const history = useWifi.getState().history;
    const vec: Record<string, number> = {};
    for (const [bssid, samples] of Object.entries(history)) {
      const recent = samples.filter((s) => s.t >= start - 2000);
      if (recent.length) vec[bssid] = recent.reduce((a, b) => a + b.rssi, 0) / recent.length;
    }
    setBusy(false);
    if (!Object.keys(vec).length) return;
    setPlaces(planKey, [...places.filter((p) => p.name !== name.trim()), { name: name.trim(), x: cursor?.x, y: cursor?.y, vec }]);
    setName("");
  };

  return (
    <div className="rounded-card border border-line bg-surface p-4" data-testid="wifi-whereami">
      <div className="flex items-center gap-2 text-[0.8125rem] font-medium">
        <Fingerprint size={15} className="text-[#F5A35C]" />
        {t("wifi.where.title")}
      </div>
      {guess ? (
        <div className="mt-2">
          <div className="font-display text-[1.125rem] font-semibold" data-testid="whereami-guess">
            {guess.confidence === "unsure" ? t("wifi.where.unsure") : t("wifi.where.here", { name: guess.place.name })}
          </div>
          <div className="text-[0.6875rem] text-muted">{t(`wifi.where.confidence.${guess.confidence}`, { db: guess.d.toFixed(1) })}</div>
        </div>
      ) : (
        <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">{t("wifi.where.intro")}</p>
      )}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          remember();
        }}
      >
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("wifi.where.placeholder")}
          maxLength={30}
          className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-raised px-3 text-[0.8125rem] outline-none placeholder:text-muted/60 focus:border-accent/60"
        />
        <Button type="submit" disabled={!name.trim() || busy}>
          {busy && <Loader2 size={13} className="animate-spin" />}
          {busy ? t("wifi.where.listening") : t("wifi.where.remember")}
        </Button>
      </form>
      <p className="mt-2 text-[0.6875rem] leading-relaxed text-muted">{t("wifi.where.how")}</p>
      {places.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {places.map((p) => (
            <li key={p.name} className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[0.6875rem] ${guess?.place.name === p.name && guess.confidence !== "unsure" ? "bg-[#F5A35C]/20 text-[#F5A35C]" : "bg-raised"}`}>
              {p.name}
              <button onClick={() => setPlaces(planKey, places.filter((x) => x !== p))} className="text-muted hover:text-risk" aria-label={t("wifi.where.forget")}>
                <Trash2 size={11} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

Whereami.Marker = Marker;
