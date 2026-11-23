import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppWindow, Camera, ExternalLink, Info, Loader2, MapPin, Mic, type LucideIcon } from "lucide-react";
import { SETTINGS, usePrivacy, type Capability, type Kind, type Use } from "../lib/privacy";
import { BellRing, Ban } from "lucide-react";
import { Switch } from "../components/ui";
import { saveWatcher, useWatcher } from "../lib/watcher";
import { ensureIcons, useProcesses } from "../lib/processes";

const ICONS: Record<Kind, LucideIcon> = { webcam: Camera, microphone: Mic, location: MapPin };

/** "5 min ago", "yesterday 14:32", "12 Mar 2026". */
function useWhen() {
  const { t, i18n } = useTranslation();
  const locale = i18n.language.startsWith("uk") ? "uk-UA" : "en-US";
  return useMemo(() => {
    const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
    const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
    return (ms: number) => {
      const ago = Date.now() - ms;
      if (ago < 60_000) return t("privacy.justNow");
      if (ago < 3_600_000) return t("privacy.minutesAgo", { count: Math.floor(ago / 60_000) });
      const d = new Date(ms);
      const today = new Date();
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      if (d.toDateString() === today.toDateString()) return t("privacy.today", { time: time.format(d) });
      if (d.toDateString() === yesterday.toDateString()) return t("privacy.yesterday", { time: time.format(d) });
      return day.format(d);
    };
  }, [t, locale]);
}

function useLength() {
  const { t } = useTranslation();
  return (ms: number) => {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return t("privacy.seconds", { count: s });
    const m = Math.round(s / 60);
    if (m < 60) return t("privacy.minutes", { count: m });
    return t("privacy.hours", { count: Math.floor(m / 60), minutes: m % 60 });
  };
}

function Tile({ cap, chosen, onChoose }: { cap: Capability; chosen: boolean; onChoose: () => void }) {
  const { t } = useTranslation();
  const Icon = ICONS[cap.kind];
  const active = cap.uses.filter((u) => u.active);
  return (
    <button
      onClick={onChoose}
      data-testid={`privacy-tile-${cap.kind}`}
      aria-pressed={chosen}
      className={`reveal relative flex flex-col items-start rounded-card border bg-surface p-4 text-left transition-colors ${
        chosen ? "border-accent/60" : "border-line hover:border-line-strong"
      }`}
    >
      <div className="flex w-full items-center gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${active.length ? "bg-risk/15 text-risk" : "bg-raised text-accent"}`}>
          <Icon size={16} />
        </span>
        <span className="text-[0.8125rem] font-medium">{t(`privacy.kind.${cap.kind}`)}</span>
        {active.length > 0 && (
          <span className="relative ml-auto flex h-2 w-2">
            <motion.span className="absolute inset-0 rounded-full bg-risk" animate={{ scale: [1, 2.6], opacity: [0.7, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
            <span className="relative h-2 w-2 rounded-full bg-risk" />
          </span>
        )}
      </div>
      <div className={`mt-3 text-[0.8125rem] ${active.length ? "text-risk" : "text-fg"}`}>
        {active.length ? t("privacy.usedBy", { names: active.map((u) => u.name).join(", ") }) : t("privacy.nobody")}
      </div>
      <div className="mt-0.5 text-[0.6875rem] text-muted">
        {!cap.allowed ? t("privacy.offForAll") : !cap.desktopAllowed ? t("privacy.offForDesktop") : t("privacy.allowed")}
        {" · "}
        {t("privacy.programs", { count: cap.uses.length })}
      </div>
    </button>
  );
}

function Row({ use, kind }: { use: Use; kind: Kind }) {
  const { t } = useTranslation();
  const when = useWhen();
  const length = useLength();
  const icon = useProcesses((s) => (use.path ? s.icons[use.path] : null));
  return (
    <li className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0" data-testid="privacy-row">
      {icon ? <img src={icon} alt="" className="h-6 w-6 shrink-0" /> : <AppWindow size={22} className="shrink-0 text-muted" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[0.8125rem]">{use.name}</span>
          {use.system && <span className="shrink-0 rounded bg-raised px-1.5 text-[0.625rem] text-muted">{t("privacy.system")}</span>}
          {use.permission === "deny" && <span className="shrink-0 rounded bg-raised px-1.5 text-[0.625rem] text-muted">{t("privacy.denied")}</span>}
        </div>
        <div className="truncate text-[0.6875rem] text-muted" title={use.path ?? undefined}>
          {use.path ?? t("privacy.storeApp")}
        </div>
      </div>
      {use.permission !== "deny" && !use.system && (
        <button
          onClick={() => openUrl(SETTINGS[kind]).catch(console.error)}
          className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-[0.6875rem] text-muted hover:border-risk/50 hover:text-risk"
          title={t("privacy.denyHint")}
        >
          <Ban size={12} />
          {t("privacy.deny")}
        </button>
      )}
      <div className="shrink-0 text-right text-[0.75rem]">
        {use.active ? (
          <span className="flex items-center gap-1.5 text-risk">
            <span className="h-1.5 w-1.5 rounded-full bg-risk" />
            {t("privacy.now")}
            {use.started && <span className="num text-muted">· {length(Date.now() - use.started)}</span>}
          </span>
        ) : (
          <>
            <div className="text-fg">{use.started ? when(use.started) : "—"}</div>
            <div className="num text-[0.6875rem] text-muted">
              {use.stale ? t("privacy.stale") : use.started && use.stopped ? length(use.stopped - use.started) : ""}
            </div>
          </>
        )}
      </div>
    </li>
  );
}

/** The last 24 hours of one device: every use as a bar on a time line, and who used it most. */
function Today({ cap }: { cap: Capability }) {
  const { t, i18n } = useTranslation();
  const length = useLength();
  const now = Date.now();
  const from = now - 24 * 3_600_000;
  const uses = cap.uses.filter((u) => u.started && (u.stopped ?? now) > from);
  const spans = uses.map((u) => ({ u, a: Math.max(from, u.started!), b: u.active ? now : Math.max(u.started! + 30_000, u.stopped ?? u.started!) }));
  const total = spans.reduce((s, x) => s + (x.b - x.a), 0);
  const byApp = new Map<string, number>();
  for (const x of spans) byApp.set(x.u.name, (byApp.get(x.u.name) ?? 0) + (x.b - x.a));
  const top = [...byApp.entries()].sort((a, b) => b[1] - a[1])[0];
  const hour = new Intl.DateTimeFormat(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { hour: "2-digit", minute: "2-digit" });
  const [hover, setHover] = useState<number | null>(null);
  return (
    <div className="mt-4 rounded-card border border-line bg-surface p-4" data-testid="privacy-today">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="text-[0.8125rem] font-medium">{t("privacy.day.title")}</h3>
        <span className="text-[0.75rem] text-muted">
          {uses.length ? t("privacy.day.summary", { count: uses.length, total: length(total) }) : t("privacy.day.none")}
        </span>
        {top && <span className="text-[0.75rem] text-muted">{t("privacy.day.top", { name: top[0], total: length(top[1]) })}</span>}
      </div>
      <div className="relative mt-3 h-9 rounded-lg bg-raised/60" onMouseLeave={() => setHover(null)}>
        {[0.25, 0.5, 0.75].map((f) => (
          <span key={f} className="absolute bottom-0 top-0 w-px bg-line" style={{ left: `${f * 100}%` }} />
        ))}
        {spans.map((x, i) => (
          <span
            key={i}
            onMouseEnter={() => setHover(i)}
            className={`absolute top-1.5 h-6 min-w-[3px] rounded ${x.u.active ? "bg-risk" : "bg-accent"} ${hover === i ? "opacity-100" : "opacity-75"}`}
            style={{ left: `${((x.a - from) / (now - from)) * 100}%`, width: `${((x.b - x.a) / (now - from)) * 100}%` }}
          />
        ))}
        {hover !== null && spans[hover] && (
          <span className="pointer-events-none absolute -top-8 z-10 whitespace-nowrap rounded-md border border-line bg-surface px-2 py-1 text-[0.6875rem] shadow-lg" style={{ left: `${Math.min(80, ((spans[hover].a - from) / (now - from)) * 100)}%` }}>
            {spans[hover].u.name} · {hour.format(spans[hover].a)} · {length(spans[hover].b - spans[hover].a)}
          </span>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[0.625rem] text-muted">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{hour.format(from + h * 3_600_000)}</span>
        ))}
      </div>
    </div>
  );
}

/** A switch for the watcher's alert when a program turns the camera or microphone on. */
function AlertsCard() {
  const { t } = useTranslation();
  const settings = useWatcher((s) => s.settings);
  if (!settings) return null;
  const on = settings.enabled && !settings.off.includes("sensor");
  return (
    <div className="mt-4 flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3">
      <BellRing size={16} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[0.8125rem]">{t("privacy.alerts.title")}</div>
        <div className="text-[0.6875rem] leading-relaxed text-muted">{t(settings.enabled ? "privacy.alerts.text" : "privacy.alerts.watcherOff")}</div>
      </div>
      <Switch
        on={on}
        disabled={!settings.enabled}
        onChange={() => saveWatcher({ off: on ? [...settings.off, "sensor"] : settings.off.filter((k) => k !== "sensor") })}
        label={t("privacy.alerts.title")}
      />
    </div>
  );
}

export function Privacy() {
  const { t } = useTranslation();
  const { caps, error } = usePrivacy();
  const [kind, setKind] = useState<Kind>("webcam");
  // Re-render every 30 s so "5 min ago" stays true even when nothing new is recorded.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => window.clearInterval(id);
  }, []);
  const cap = caps?.find((c) => c.kind === kind);
  useEffect(() => {
    if (cap) ensureIcons(cap.uses.map((u) => u.path));
  }, [cap]);

  if (!caps)
    return (
      <div className="flex h-full items-center justify-center text-muted">
        {error ? <span className="text-risk">{error}</span> : <Loader2 className="animate-spin" />}
      </div>
    );

  return (
    <div className="mx-auto max-w-[53.75rem] pb-6">
      <p className="mb-4 max-w-[70ch] text-[0.8125rem] leading-relaxed text-muted">{t("privacy.intro")}</p>
      <div className="grid grid-cols-3 gap-3">
        {caps.map((c) => (
          <Tile key={c.kind} cap={c} chosen={c.kind === kind} onChoose={() => setKind(c.kind)} />
        ))}
      </div>

      <AlertsCard />
      {cap && <Today cap={cap} />}
      {cap && (
        <>
          <div className="mb-2 mt-6 flex items-center gap-3">
            <h2 className="font-display text-[1rem] font-semibold">{t(`privacy.listTitle.${kind}`)}</h2>
            <button
              onClick={() => openUrl(SETTINGS[kind]).catch(console.error)}
              className="ml-auto flex items-center gap-1.5 text-[0.75rem] text-accent hover:underline"
              data-testid="privacy-settings"
            >
              {t("privacy.manage")}
              <ExternalLink size={12} />
            </button>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={kind} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {cap.uses.length === 0 ? (
                <div className="rounded-card border border-line bg-surface px-4 py-6 text-center text-[0.8125rem] text-muted">{t("privacy.empty")}</div>
              ) : (
                <ul className="overflow-clip rounded-card border border-line bg-surface">
                  {cap.uses.map((u) => (
                    <Row key={`${u.system}-${u.key}`} use={u} kind={kind} />
                  ))}
                </ul>
              )}
            </motion.div>
          </AnimatePresence>
          <p className="mt-3 flex gap-2 text-[0.75rem] leading-relaxed text-muted">
            <Info size={14} className="mt-0.5 shrink-0 text-accent" />
            {t("privacy.note")}
          </p>
        </>
      )}
    </div>
  );
}
