import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AppWindow, Camera, ExternalLink, Info, Loader2, MapPin, Mic, type LucideIcon } from "lucide-react";
import { SETTINGS, usePrivacy, type Capability, type Kind, type Use } from "../lib/privacy";
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
        chosen ? "border-accent/60" : "border-line hover:border-[#3a4452]"
      }`}
    >
      <div className="flex w-full items-center gap-2">
        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${active.length ? "bg-risk/15 text-risk" : "bg-raised text-accent"}`}>
          <Icon size={16} />
        </span>
        <span className="text-[13px] font-medium">{t(`privacy.kind.${cap.kind}`)}</span>
        {active.length > 0 && (
          <span className="relative ml-auto flex h-2 w-2">
            <motion.span className="absolute inset-0 rounded-full bg-risk" animate={{ scale: [1, 2.6], opacity: [0.7, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
            <span className="relative h-2 w-2 rounded-full bg-risk" />
          </span>
        )}
      </div>
      <div className={`mt-3 text-[13px] ${active.length ? "text-risk" : "text-fg"}`}>
        {active.length ? t("privacy.usedBy", { names: active.map((u) => u.name).join(", ") }) : t("privacy.nobody")}
      </div>
      <div className="mt-0.5 text-[11px] text-muted">
        {!cap.allowed ? t("privacy.offForAll") : !cap.desktopAllowed ? t("privacy.offForDesktop") : t("privacy.allowed")}
        {" · "}
        {t("privacy.programs", { count: cap.uses.length })}
      </div>
    </button>
  );
}

function Row({ use }: { use: Use }) {
  const { t } = useTranslation();
  const when = useWhen();
  const length = useLength();
  const icon = useProcesses((s) => (use.path ? s.icons[use.path] : null));
  return (
    <li className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0" data-testid="privacy-row">
      {icon ? <img src={icon} alt="" className="h-6 w-6 shrink-0" /> : <AppWindow size={22} className="shrink-0 text-muted" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px]">{use.name}</span>
          {use.system && <span className="shrink-0 rounded bg-raised px-1.5 text-[10px] text-muted">{t("privacy.system")}</span>}
          {use.permission === "deny" && <span className="shrink-0 rounded bg-raised px-1.5 text-[10px] text-muted">{t("privacy.denied")}</span>}
        </div>
        <div className="truncate text-[11px] text-muted" title={use.path ?? undefined}>
          {use.path ?? t("privacy.storeApp")}
        </div>
      </div>
      <div className="shrink-0 text-right text-[12px]">
        {use.active ? (
          <span className="flex items-center gap-1.5 text-risk">
            <span className="h-1.5 w-1.5 rounded-full bg-risk" />
            {t("privacy.now")}
            {use.started && <span className="num text-muted">· {length(Date.now() - use.started)}</span>}
          </span>
        ) : (
          <>
            <div className="text-fg">{use.started ? when(use.started) : "—"}</div>
            <div className="num text-[11px] text-muted">
              {use.stale ? t("privacy.stale") : use.started && use.stopped ? length(use.stopped - use.started) : ""}
            </div>
          </>
        )}
      </div>
    </li>
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
    <div className="mx-auto max-w-[860px] pb-6">
      <p className="mb-4 max-w-[70ch] text-[13px] leading-relaxed text-muted">{t("privacy.intro")}</p>
      <div className="grid grid-cols-3 gap-3">
        {caps.map((c) => (
          <Tile key={c.kind} cap={c} chosen={c.kind === kind} onChoose={() => setKind(c.kind)} />
        ))}
      </div>

      {cap && (
        <>
          <div className="mb-2 mt-6 flex items-center gap-3">
            <h2 className="font-display text-[16px] font-semibold">{t(`privacy.listTitle.${kind}`)}</h2>
            <button
              onClick={() => openUrl(SETTINGS[kind]).catch(console.error)}
              className="ml-auto flex items-center gap-1.5 text-[12px] text-accent hover:underline"
              data-testid="privacy-settings"
            >
              {t("privacy.manage")}
              <ExternalLink size={12} />
            </button>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={kind} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {cap.uses.length === 0 ? (
                <div className="rounded-card border border-line bg-surface px-4 py-6 text-center text-[13px] text-muted">{t("privacy.empty")}</div>
              ) : (
                <ul className="overflow-clip rounded-card border border-line bg-surface">
                  {cap.uses.map((u) => (
                    <Row key={`${u.system}-${u.key}`} use={u} />
                  ))}
                </ul>
              )}
            </motion.div>
          </AnimatePresence>
          <p className="mt-3 flex gap-2 text-[12px] leading-relaxed text-muted">
            <Info size={14} className="mt-0.5 shrink-0 text-accent" />
            {t("privacy.note")}
          </p>
        </>
      )}
    </div>
  );
}
