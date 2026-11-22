import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowUp, Ban, DoorOpen, History, LogIn, LogOut } from "lucide-react";
import { useFmt } from "../../lib/format";
import { useRouter } from "../../lib/router";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Nov 22 17:48:24" → "22.11 17:48". */
const when = (at: string) => {
  const [m, d, time] = at.split(/\s+/);
  const month = MONTHS.indexOf(m) + 1;
  return `${d.padStart(2, "0")}.${String(month).padStart(2, "0")} ${(time ?? "").slice(0, 5)}`;
};

/** Bytes per second as a network speed: "26.3 kbit/s", "13.6 Mbit/s". */
function bitrate(bytesPerSec: number, t: (k: string) => string) {
  const bits = bytesPerSec * 8;
  const [v, unit] = bits >= 1e6 ? [bits / 1e6, "mbit"] : bits >= 1e3 ? [bits / 1e3, "kbit"] : [bits, "bit"];
  return `${v.toLocaleString(undefined, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${t(`router.extras.${unit}`)}`;
}

/** Traffic, open ports, the connection log and blocked devices: the router's wider view. */
export function RouterExtras({ onUnblock }: { onUnblock: (mac: string, label: string) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const o = useRouter((s) => s.overview)!;
  const rate = useRouter((s) => s.rate);
  const events = useRouter((s) => s.events);
  const applying = useRouter((s) => s.applying);
  const nameOf = (mac: string) => {
    const c = o.clients.find((x) => x.mac === mac);
    return c?.name || c?.vendor || mac;
  };
  const tr = o.traffic;

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="rounded-card border border-line bg-surface p-4" data-testid="router-traffic">
        <h3 className="mb-3 text-[13px] font-medium">{t("router.extras.traffic")}</h3>
        <div className="grid grid-cols-2 gap-3">
          {(
            [
              [ArrowDown, rate?.down, "down", "text-safe"],
              [ArrowUp, rate?.up, "up", "text-accent"],
            ] as const
          ).map(([Icon, v, k, tone]) => (
            <div key={k}>
              <div className="num flex items-baseline gap-1.5 whitespace-nowrap font-display text-[19px] font-semibold">
                <Icon size={14} className={`self-center ${tone}`} />
                {v === undefined ? "—" : bitrate(v, t)}
              </div>
              <div className="text-[11px] text-muted">{t(`router.extras.${k}`)}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted">{t("router.extras.wifiShare", { wifi: fmt.bytes(tr.wirelessRx + tr.wirelessTx), wired: fmt.bytes(tr.wiredRx + tr.wiredTx) })}</p>
        <p className="mt-2 text-[11px] leading-relaxed text-muted/80">{t("router.extras.perDevice")}</p>
      </div>

      <div className="rounded-card border border-line bg-surface p-4" data-testid="router-ports">
        <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium">
          <DoorOpen size={15} className="text-accent" />
          {t("router.extras.ports")}
        </h3>
        {o.ports.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-safe">{t("router.extras.noPorts")}</p>
        ) : (
          <>
            <ul className="grid gap-1.5 text-[12px]">
              {o.ports.map((p, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-2">
                  <span className="num font-medium text-warn">
                    {p.external}/{p.protocol}
                  </span>
                  <span className="num text-muted">
                    → {p.ip}:{p.internal}
                  </span>
                  <span className="text-[11px] text-muted">
                    {p.name} · {p.upnp ? t("router.extras.upnp") : t("router.extras.manual")}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">{t("router.extras.portsHint")}</p>
          </>
        )}
        {(o.blocked.length > 0 || o.allowList) && (
          <div className="mt-4 border-t border-line pt-3">
            <h4 className="mb-2 flex items-center gap-2 text-[12px] font-medium">
              <Ban size={13} className="text-risk" />
              {t("router.extras.blocked")}
            </h4>
            {o.allowList && <p className="text-[11px] text-warn">{t("router.extras.allowList")}</p>}
            <ul className="grid gap-1">
              {o.blocked.map((m) => (
                <li key={m} className="flex items-center gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">{nameOf(m)}</span>
                  <button disabled={!!applying} onClick={() => onUnblock(m, nameOf(m))} className="text-[11px] text-accent hover:underline disabled:opacity-40">
                    {t("router.fix.unblock.button")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded-card border border-line bg-surface p-4" data-testid="router-log">
        <h3 className="mb-3 flex items-center gap-2 text-[13px] font-medium">
          <History size={15} className="text-accent" />
          {t("router.extras.log")}
        </h3>
        {events.length === 0 ? (
          <p className="text-[12px] text-muted">{t("router.extras.noLog")}</p>
        ) : (
          <ul className="grid max-h-[220px] gap-1 overflow-y-auto pr-1 text-[12px]">
            {[...events].reverse().slice(0, 60).map((e, i) => (
              <li key={i} className="flex items-center gap-2">
                {e.kind === "join" ? <LogIn size={12} className="shrink-0 text-safe" /> : <LogOut size={12} className="shrink-0 text-muted" />}
                <span className="num w-[92px] shrink-0 text-[11px] text-muted">{when(e.at)}</span>
                <span className="min-w-0 flex-1 truncate" title={e.kind === "join" ? t("router.extras.joined") : t("router.extras.left")}>
                  {nameOf(e.mac)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
