import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Clock, Loader2 } from "lucide-react";
import { BAND_COLORS, type Band } from "../../lib/wifi";

interface Record {
  at: number;
  total: number;
  perBand: [string, number][];
  ownBand: string | null;
  ownChannel: number | null;
  ownRssi: number | null;
  ownInterference: number | null;
  channels: { band: string; channel: number; interference: number; networks: number }[];
}

/** Interference (dBm, −100 = silent) as 0–1 for colour. */
const load = (dbm: number) => Math.max(0, Math.min(1, (dbm + 100) / 45));
const heat = (k: number) => `color-mix(in oklab, var(--color-safe) ${Math.round((1 - k) * 100)}%, var(--color-risk))`;

export function History() {
  const { t } = useTranslation();
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<Record[] | null>(null);

  useEffect(() => {
    setRows(null);
    invoke<Record[]>("wifi_history", { days }).then(setRows).catch(() => setRows([]));
  }, [days]);

  // Per hour of day: how many networks around and how loud the user's channel was.
  const hours = useMemo(() => {
    const acc = Array.from({ length: 24 }, () => ({ n: 0, total: 0, own: 0, ownN: 0 }));
    for (const r of rows ?? []) {
      const h = new Date(r.at * 1000).getHours();
      acc[h].n++;
      acc[h].total += r.total;
      if (r.ownInterference !== null) {
        acc[h].own += r.ownInterference;
        acc[h].ownN++;
      }
    }
    return acc.map((a) => ({ samples: a.n, total: a.n ? a.total / a.n : null, own: a.ownN ? a.own / a.ownN : null }));
  }, [rows]);

  // Per channel over the whole period: average interference, quietest first.
  const channels = useMemo(() => {
    const map = new Map<string, { band: string; channel: number; sum: number; n: number; nets: number }>();
    for (const r of rows ?? [])
      for (const c of r.channels) {
        const k = `${c.band}/${c.channel}`;
        const m = map.get(k) ?? { band: c.band, channel: c.channel, sum: 0, n: 0, nets: 0 };
        m.sum += c.interference;
        m.nets += c.networks;
        m.n++;
        map.set(k, m);
      }
    return [...map.values()].map((m) => ({ ...m, avg: m.sum / m.n, avgNets: m.nets / m.n }));
  }, [rows]);

  const daysSeen = new Set((rows ?? []).map((r) => new Date(r.at * 1000).toDateString())).size;
  const busiest = hours.reduce((best, h, i) => (h.own !== null && (best === -1 || h.own > (hours[best].own ?? -200)) ? i : best), -1);

  return (
    <div className="grid gap-4" data-testid="wifi-history">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-line bg-surface p-0.5">
          {[1, 7, 30].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`rounded-md px-3 py-1 text-[12px] ${days === d ? "bg-raised text-fg" : "text-muted hover:text-fg"}`}>
              {t("wifi.history.days", { count: d })}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <Clock size={12} />
          {t("wifi.history.how")}
        </span>
      </div>

      {rows === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="animate-spin text-accent" />
        </div>
      ) : rows.length < 2 ? (
        <div className="rounded-card border border-dashed border-line p-6 text-center text-[13px] leading-relaxed text-muted" data-testid="wifi-history-empty">
          {t("wifi.history.empty", { count: rows.length })}
        </div>
      ) : (
        <>
          <div className="rounded-card border border-line bg-surface p-4">
            <div className="mb-1 text-[13px] font-medium">{t("wifi.history.byHour")}</div>
            <p className="mb-3 text-[11px] text-muted">{t("wifi.history.byHourHint", { records: rows.length, days: daysSeen })}</p>
            <div className="grid grid-cols-24 gap-1" style={{ gridTemplateColumns: "repeat(24, minmax(0, 1fr))" }}>
              {hours.map((h, i) => (
                <div key={i} className="grid gap-1 text-center">
                  <div
                    className="h-14 rounded-md"
                    title={h.own === null ? "—" : `${i}:00 · ${Math.round(h.own)} dBm · ${Math.round(h.total ?? 0)}`}
                    style={{ background: h.own === null ? "var(--color-raised)" : heat(load(h.own)), opacity: h.samples ? 1 : 0.35 }}
                  />
                  <span className="num text-[9px] text-muted">{i}</span>
                </div>
              ))}
            </div>
            {busiest >= 0 && <p className="mt-3 text-[12px] text-muted">{t("wifi.history.busiest", { hour: busiest })}</p>}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {(["2.4", "5", "6"] as Band[])
              .filter((b) => channels.some((c) => c.band === b))
              .map((b) => {
                const list = channels.filter((c) => c.band === b).sort((x, y) => x.avg - y.avg);
                return (
                  <div key={b} className="rounded-card border border-line bg-surface p-4">
                    <div className="mb-2 text-[13px] font-medium" style={{ color: BAND_COLORS[b] }}>
                      {t("wifi.history.channels", { band: b })}
                    </div>
                    <ul className="grid gap-1.5">
                      {list.map((c, i) => (
                        <li key={c.channel} className="flex items-center gap-3 text-[12px]">
                          <span className="num w-10">{c.channel}</span>
                          <span className="h-2 flex-1 overflow-hidden rounded-full bg-raised">
                            <span className="block h-full rounded-full" style={{ width: `${Math.max(4, load(c.avg) * 100)}%`, background: heat(load(c.avg)) }} />
                          </span>
                          <span className="num w-24 text-right text-[11px] text-muted">{t("wifi.history.nets", { n: c.avgNets.toFixed(1) })}</span>
                          {i === 0 && <span className="rounded bg-safe/15 px-1.5 text-[10px] text-safe">{t("wifi.history.best")}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
          </div>
        </>
      )}
    </div>
  );
}
