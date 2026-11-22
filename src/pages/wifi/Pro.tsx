import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Cable,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Eye,
  EyeOff,
  Info,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  Router,
  ShieldAlert,
  ShieldCheck,
  Sparkle,
  UserCheck,
  Wifi,
} from "lucide-react";
import { Button, Checkbox } from "../../components/ui";
import { formatUptime } from "../../lib/format";
import { connectRouter, disconnectRouter, findRouter, refreshRouter, toggleKnown, useRouter, type Client } from "../../lib/router";
import { BAND_COLORS, useWifi } from "../../lib/wifi";
import { Bars } from "./Simple";

const TONE = { ok: "text-safe", info: "text-accent", warn: "text-warn", risk: "text-risk" } as const;
const ICON = { ok: CircleCheck, info: Info, warn: CircleAlert, risk: ShieldAlert } as const;

function Connect() {
  const { t } = useTranslation();
  const { found, busy, error } = useRouter();
  const [user, setUser] = useState("admin");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [remember, setRemember] = useState(true);

  if (!found)
    return (
      <div className="flex h-64 items-center justify-center text-muted">
        <Loader2 className="animate-spin text-accent" />
      </div>
    );
  if (!found.host || found.vendor !== "asus")
    return (
      <div className="mx-auto max-w-[560px] rounded-card border border-line bg-surface p-6 text-center" data-testid="router-unsupported">
        <Router size={32} className="mx-auto text-muted" />
        <h2 className="mt-3 font-display text-[18px] font-semibold">{t(found.host ? "router.unsupported" : "router.noGateway")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t(found.host ? "router.unsupportedText" : "router.noGatewayText", { host: found.host })}</p>
      </div>
    );

  const login = found.login;
  const left = login ? Math.max(0, 9 - login.errors) : null;
  const errorText = error && (error.startsWith("locked") ? t("router.error.locked", { secs: error.split(":")[1] }) : t(`router.error.${error}`, { defaultValue: t("router.error.failed") }));
  return (
    <div className="mx-auto grid max-w-[920px] gap-4 md:grid-cols-[1.1fr_1fr]" data-testid="router-connect">
      <div className="rounded-card border border-line bg-surface p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <Router size={22} />
          </span>
          <div>
            <h2 className="font-display text-[17px] font-semibold">
              {t("router.foundAsus")}
              {found.model && ` ${found.model}`}
            </h2>
            <div className="num text-[12px] text-muted">{found.host}</div>
          </div>
        </div>
        {found.saved && (
          <Button variant="primary" className="mt-5 w-full" disabled={busy} onClick={() => connectRouter(null, null, true)} data-testid="router-saved">
            {busy ? <Loader2 size={15} className="animate-spin" /> : <KeyRound size={15} />}
            {t("router.useSaved")}
          </Button>
        )}
        <form
          className="mt-5 grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (password) connectRouter(user.trim(), password, remember).then(() => setPassword(""));
          }}
        >
          <label className="grid gap-1 text-[12px] text-muted">
            {t("router.user")}
            <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" className="h-9 rounded-lg border border-line bg-raised px-3 text-[13px] text-fg outline-none focus:border-accent/60" />
          </label>
          <label className="grid gap-1 text-[12px] text-muted">
            {t("router.password")}
            <span className="relative">
              <input
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                className="h-9 w-full rounded-lg border border-line bg-raised px-3 pr-9 text-[13px] text-fg outline-none focus:border-accent/60"
                data-testid="router-password"
              />
              <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-fg" aria-label={t("router.showPassword")}>
                {show ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </span>
          </label>
          <label className="flex items-center gap-2 text-[12px] text-muted">
            <Checkbox state={remember} onChange={() => setRemember(!remember)} label={t("router.remember")} />
            {t("router.remember")}
          </label>
          <Button type="submit" variant={found.saved ? "ghost" : "primary"} disabled={busy || !password || !!login?.captcha || !!login?.lockedFor} data-testid="router-login">
            {busy && <Loader2 size={15} className="animate-spin" />}
            {t("router.connect")}
          </Button>
        </form>
        {errorText && (
          <p className="mt-3 text-[12px] leading-relaxed text-risk" role="alert" data-testid="router-error">
            {errorText}
          </p>
        )}
        {login && (login.errors > 0 || login.captcha || login.lockedFor) && (
          <p className="mt-3 rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-2 text-[12px] leading-relaxed text-warn" data-testid="router-attempts">
            {login.lockedFor ? t("router.lockedNow", { secs: login.lockedFor }) : login.captcha ? t("router.captcha") : t("router.attempts", { errors: login.errors, left })}
          </p>
        )}
        {(login?.captcha || login?.lockedFor) && (
          <button className="mt-2 flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => openUrl(`http://${found.host}/`).catch(console.error)}>
            {t("router.openInBrowser")} <ExternalLink size={12} />
          </button>
        )}
      </div>
      <div className="grid content-start gap-3 text-[12px] leading-relaxed text-muted">
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] text-fg">
            <Sparkle size={14} className="text-accent" />
            {t("router.whatTitle")}
          </div>
          {t("router.whatText")}
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] text-fg">
            <ShieldCheck size={14} className="text-safe" />
            {t("router.safeTitle")}
          </div>
          {t("router.safeText")}
        </div>
      </div>
    </div>
  );
}

function duration(secs: number | null, t: (k: string) => string) {
  return secs === null ? "—" : formatUptime(secs, { d: t("units.d"), h: t("units.h"), m: t("units.m") });
}

function ClientRow({ c, host }: { c: Client; host: string }) {
  const { t } = useTranslation();
  const known = useRouter((s) => (s.known[host] ?? []).includes(c.mac));
  const fresh = useRouter((s) => s.fresh.includes(c.mac));
  const name = c.name || c.vendor || t("router.unknownDevice");
  return (
    <motion.li
      layout="position"
      className={`flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0 ${!c.online ? "opacity-50" : ""} ${!known && c.online ? "bg-warn/[0.035]" : ""}`}
      data-testid="router-client"
    >
      <span className="flex w-6 justify-center">{c.link === "wired" ? <Cable size={16} className="text-muted" /> : c.rssi !== null ? <Bars rssi={c.rssi} /> : <Wifi size={15} className="text-muted" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className={`truncate text-[13px] ${c.name ? "" : "italic"}`}>{name}</span>
          {fresh && <span className="shrink-0 rounded bg-safe/15 px-1.5 text-[10px] text-safe">{t("router.new")}</span>}
          {c.guest && <span className="shrink-0 rounded bg-raised px-1.5 text-[10px] text-muted">{t("router.guest")}</span>}
          {!known && c.online && <span className="shrink-0 rounded bg-warn/15 px-1.5 text-[10px] text-warn">{t("router.notMarked")}</span>}
        </div>
        <div className="num truncate text-[11px] text-muted">
          {c.ip || "—"} · {c.mac}
          {c.randomMac && <span title={t("router.privateHint")}> · {t("router.private")}</span>}
          {c.name && c.vendor && ` · ${c.vendor}`}
        </div>
      </div>
      <div className="hidden w-28 shrink-0 text-right text-[11px] sm:block">
        {c.link === "wired" ? (
          <span className="text-muted">{t("router.wired")}</span>
        ) : (
          <>
            <span style={{ color: BAND_COLORS[c.link] }}>
              {c.link} {t("wifi.ghz")}
            </span>
            {c.rssi !== null && <span className="num text-muted"> · {c.rssi} dBm</span>}
          </>
        )}
        <div className="num text-muted">{c.online ? duration(c.connectedSecs, t) : t("router.offline")}</div>
      </div>
      <button
        onClick={() => toggleKnown(host, c.mac)}
        className={`flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-[11px] transition-colors ${known ? "bg-safe/15 text-safe" : "border border-line text-muted hover:text-fg"}`}
        data-testid="router-known"
      >
        <UserCheck size={12} />
        {known ? t("router.mine") : t("router.markMine")}
      </button>
    </motion.li>
  );
}

function Dashboard() {
  const { t } = useTranslation();
  const o = useRouter((s) => s.overview)!;
  // Select the stored array itself: a fresh `[]` on every call would re-render forever.
  const knownList = useRouter((s) => s.known[o.host]);
  const known = knownList ?? [];
  const [refreshing, setRefreshing] = useState(false);
  // On "auto" the router does not say which channel it picked; the Wi-Fi scan hears it.
  const heard = useWifi((s) => s.snap?.networks);
  const liveChannel = (ssid: string, band: string) => heard?.find((n) => n.ssid === ssid && n.band === band)?.channel;
  const online = o.clients.filter((c) => c.online);
  const unmarked = online.filter((c) => !known.includes(c.mac));
  const order = { risk: 0, warn: 1, info: 2, ok: 3 };

  useEffect(() => {
    const id = window.setInterval(refreshRouter, 10_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="grid gap-4" data-testid="router-dashboard">
      <div className="flex flex-wrap items-center gap-4 rounded-card border border-line bg-surface p-5">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <Router size={24} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[19px] font-semibold">ASUS {o.model}</h2>
          <div className="num text-[12px] text-muted">
            {o.host} · {t("router.firmware")} {o.firmware} · {t("router.uptime")} {duration(o.uptimeSecs, t)}
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="quiet"
            icon={<RefreshCw size={14} className={refreshing ? "animate-spin" : ""} />}
            onClick={async () => {
              setRefreshing(true);
              await refreshRouter();
              setRefreshing(false);
            }}
          >
            {t("router.refresh")}
          </Button>
          <Button variant="quiet" icon={<ExternalLink size={14} />} onClick={() => openUrl(`http://${o.host}/`).catch(console.error)}>
            {t("router.openAdmin")}
          </Button>
          <Button icon={<LogOut size={14} />} onClick={() => disconnectRouter(false)} data-testid="router-disconnect">
            {t("router.disconnect")}
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {o.radios.map((r) => (
          <div key={r.unit} className="rounded-card border border-line bg-surface p-4" data-testid="router-radio">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-medium" style={{ color: BAND_COLORS[r.band] }}>
                {r.band} {t("wifi.ghz")}
              </span>
              <span className={`text-[11px] ${r.enabled ? "text-safe" : "text-muted"}`}>{r.enabled ? t("router.on") : t("router.off")}</span>
            </div>
            <div className="mt-1 truncate text-[15px] font-medium">{r.ssid}</div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              <span className="rounded bg-raised px-1.5 py-0.5">{r.auto
                  ? liveChannel(r.ssid, r.band) && r.enabled
                    ? t("router.autoNow", { n: liveChannel(r.ssid, r.band) })
                    : t("router.autoChannel")
                  : t("wifi.channelN", { n: r.channel })}</span>
              {r.width && <span className="num rounded bg-raised px-1.5 py-0.5">{r.width} {t("wifi.mhz")}</span>}
              <span className={`rounded px-1.5 py-0.5 ${["open", "wep", "wpa"].includes(r.security) || r.tkip ? "bg-warn/15 text-warn" : "bg-raised"}`}>
                {t(`wifi.security.${r.security}`, { defaultValue: r.security })}
                {r.tkip && " · TKIP"}
              </span>
              {r.hidden && <span className="rounded bg-raised px-1.5 py-0.5">{t("router.hidden")}</span>}
            </div>
          </div>
        ))}
      </div>

      <div className="grid gap-4">
        <div className="grid content-start gap-2 md:grid-cols-2">
          <h3 className="text-[13px] font-medium md:col-span-2">{t("router.checksTitle")}</h3>
          {[...o.checks]
            .sort((a, b) => order[a.level] - order[b.level])
            .map((c) => {
              const Icon = ICON[c.level];
              return (
                <div key={c.id} className="flex gap-3 rounded-card border border-line bg-surface px-4 py-3" data-testid="router-check">
                  <Icon size={18} className={`mt-0.5 shrink-0 ${TONE[c.level]}`} />
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium">{t(`router.check.${c.id}.title`, c.values)}</div>
                    <div className="mt-0.5 text-[12px] leading-relaxed text-muted">{t(`router.check.${c.id}.text`, c.values)}</div>
                  </div>
                </div>
              );
            })}
        </div>
        <div className="overflow-clip rounded-card border border-line bg-surface">
          <div className="flex items-baseline justify-between border-b border-line px-4 py-3">
            <h3 className="text-[13px] font-medium">{t("router.devices", { online: online.length, total: o.clients.length })}</h3>
            <span className={`text-[11px] ${unmarked.length ? "text-warn" : "text-safe"}`}>
              {unmarked.length ? t("router.unmarked", { count: unmarked.length }) : t("router.allMarked")}
            </span>
          </div>
          <p className="border-b border-line/60 px-4 py-2 text-[11px] leading-relaxed text-muted">{t("router.devicesHint")}</p>
          <ul>
            {o.clients.map((c) => (
              <ClientRow key={c.mac} c={c} host={o.host} />
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

export function Pro() {
  const overview = useRouter((s) => s.overview);
  useEffect(() => {
    // A session DelphEye already has (e.g. after the page reloaded) is reused, not logged into again.
    if (!overview)
      findRouter().then(() => {
        if (useRouter.getState().found?.connected) refreshRouter();
      });
  }, [overview]);
  return overview ? <Dashboard /> : <Connect />;
}
