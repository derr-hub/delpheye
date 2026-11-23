import { useEffect } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { BellRing, Check, Sparkles, Webcam, CircleAlert, Cpu, HardDrive, Rocket, ShieldAlert, Smartphone, Wifi, Zap, type LucideIcon } from "lucide-react";
import { Button, Switch } from "../components/ui";
import { go, type Page } from "../lib/app";
import { OPEN_KEY, TOGGLE_KEY, loadOverlay, saveOverlay, testOverlay, useOverlay } from "../lib/overlay";
import { readAll, saveWatcher, setAutostart, testNotification, unread, useWatcher, type Alert, type Kind } from "../lib/watcher";

/** The watcher's checks, by what they look after. */
const GROUPS: [string, Kind[]][] = [
  ["pc", ["heat", "disk", "crash"]],
  ["security", ["threat", "autostart", "sensor"]],
  ["network", ["device", "twin"]],
];

const ICON: Record<Kind, LucideIcon> = { device: Smartphone, twin: Wifi, heat: Cpu, disk: HardDrive, autostart: Rocket, crash: Zap, threat: ShieldAlert, sensor: Webcam };
const PAGE: Record<Kind, Page> = { device: "wifi", twin: "wifi", heat: "monitoring", disk: "cleanup", autostart: "startup", crash: "monitoring", threat: "security", sensor: "privacy" };
const TONE = { info: "text-accent", warn: "text-warn", risk: "text-risk" } as const;

function when(at: number, locale: string) {
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(at * 1000));
}

function Row({ a }: { a: Alert }) {
  const { t, i18n } = useTranslation();
  const Icon = a.values.loginFailed ? ShieldAlert : ICON[a.kind];
  const v = a.values as Record<string, string>;
  const name = v.name || v.vendor || t("watcher.unknownDevice");
  const key = a.kind === "device" && a.values.loginFailed ? "loginFailed" : a.kind;
  return (
    <li className={`flex gap-3 border-b border-line/60 px-4 py-3 last:border-b-0 ${a.read ? "" : "bg-accent/[0.04]"}`} data-testid="watcher-alert">
      <Icon size={18} className={`mt-0.5 shrink-0 ${TONE[a.level] ?? "text-muted"}`} />
      <div className="min-w-0 flex-1">
        <div className="text-[0.8125rem] font-medium">{t(`watcher.alert.${key}.title`, { ...v, name })}</div>
        <div className="mt-0.5 text-[0.75rem] leading-relaxed text-muted">{t(`watcher.alert.${key}.text`, { ...v, name })}</div>
      </div>
      <div className="shrink-0 text-right">
        <div className="num text-[0.6875rem] text-muted">{when(a.at, i18n.language.startsWith("uk") ? "uk-UA" : "en-US")}</div>
        <button onClick={() => go(PAGE[a.kind])} className="mt-1 text-[0.6875rem] text-accent hover:underline">
          {t("watcher.open")}
        </button>
      </div>
    </li>
  );
}

export function Watcher() {
  const { t } = useTranslation();
  const { settings, alerts, autostart } = useWatcher();
  const count = unread(alerts);
  const overlay = useOverlay((s) => s.settings);
  useEffect(() => {
    loadOverlay().catch(() => {});
  }, []);

  // Seen once opened.
  useEffect(() => {
    if (count) {
      const id = window.setTimeout(readAll, 2500);
      return () => window.clearTimeout(id);
    }
  }, [count]);

  if (!settings) return null;
  const on = (k: Kind) => !settings.off.includes(k);
  const toggle = (k: Kind) => saveWatcher({ off: on(k) ? [...settings.off, k] : settings.off.filter((x) => x !== k) });

  return (
    <div className="grid gap-4 pb-6 lg:grid-cols-[1.4fr_1fr]" data-testid="watcher-page">
      <div className="grid content-start gap-4">
        <div className="flex items-center gap-4 rounded-card border border-line bg-surface p-5">
          <span className={`relative flex h-12 w-12 items-center justify-center rounded-xl ${settings.enabled ? "bg-safe/10 text-safe" : "bg-raised text-muted"}`}>
            {settings.enabled && (
              <motion.span className="absolute inset-0 rounded-xl border border-safe/50" animate={{ scale: [1, 1.25], opacity: [0.6, 0] }} transition={{ duration: 2, repeat: Infinity }} />
            )}
            <BellRing size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[1.125rem] font-semibold">{settings.enabled ? t("watcher.on") : t("watcher.off")}</h2>
            <p className="text-[0.75rem] leading-relaxed text-muted">{t("watcher.lead")}</p>
          </div>
          <Switch on={settings.enabled} onChange={() => saveWatcher({ enabled: !settings.enabled })} label={t("watcher.enabled")} />
        </div>

        <div className="overflow-clip rounded-card border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <h3 className="text-[0.8125rem] font-medium">{t("watcher.events")}</h3>
            {count > 0 && (
              <button onClick={readAll} className="flex items-center gap-1 text-[0.6875rem] text-muted hover:text-fg">
                <Check size={12} />
                {t("watcher.readAll")}
              </button>
            )}
          </div>
          {alerts.length === 0 ? (
            <div className="px-4 py-10 text-center text-[0.8125rem] text-muted" data-testid="watcher-empty">
              <CircleAlert size={22} className="mx-auto mb-2 text-muted/60" />
              {t("watcher.empty")}
            </div>
          ) : (
            <ul className="rows-enter">
              {alerts.map((a) => (
                <Row key={a.id} a={a} />
              ))}
            </ul>
          )}
        </div>
        {overlay && (
          <div className="rounded-card border border-line bg-surface p-4" data-testid="overlay-card">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-[4rem] shrink-0 items-center justify-center rounded-full bg-black text-[0.625rem] font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.12)]">
                <Sparkles size={12} className="mr-1 text-[#4ade80]" />
                144
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[0.8125rem] font-medium">{t("overlay.title")}</h3>
                <p className="text-[0.6875rem] leading-relaxed text-muted">{t("overlay.lead")}</p>
              </div>
              <Switch on={overlay.enabled} onChange={() => saveOverlay({ enabled: !overlay.enabled })} label={t("overlay.title")} />
            </div>
            <ul className="mt-3 grid gap-2.5 text-[0.8125rem]">
              {(["pc", "fps", "net", "alerts"] as const).map((k) => (
                <li key={k} className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div>{t(`overlay.part.${k}.title`)}</div>
                    <div className="text-[0.6875rem] leading-relaxed text-muted">{t(`overlay.part.${k}.text`)}</div>
                  </div>
                  <Switch on={overlay[k]} onChange={() => saveOverlay({ [k]: !overlay[k] })} label={t(`overlay.part.${k}.title`)} />
                </li>
              ))}
            </ul>
            <p className="mt-3 rounded-lg bg-raised/60 px-3 py-2 text-[0.6875rem] leading-relaxed text-muted">{t("overlay.hotkeys", { toggle: TOGGLE_KEY, open: OPEN_KEY })}</p>
          </div>
        )}
      </div>

      <div className="grid content-start gap-4">
        <div className="rounded-card border border-line bg-surface p-4">
          <h3 className="text-[0.8125rem] font-medium">{t("watcher.what")}</h3>
          <p className="mb-2 text-[0.6875rem] leading-relaxed text-muted">{t("watcher.whatLead")}</p>
          {GROUPS.map(([group, kinds]) => (
            <div key={group} className="mt-2">
              <div className="px-1 pb-1 pt-2 text-[0.625rem] font-semibold uppercase tracking-wider text-muted">{t(`watcher.group.${group}`)}</div>
              <ul className="grid gap-0.5">
                {kinds.map((k) => {
                  const Icon = ICON[k];
                  return (
                    <li key={k} className="flex items-start gap-3 rounded-lg px-1 py-2 transition-colors hover:bg-raised/40">
                      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                        <Icon size={14} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
                          {t(`watcher.kind.${k}.title`)}
                          <span className="text-[0.625rem] text-muted">{t(`watcher.every.${k}`)}</span>
                        </div>
                        <div className="text-[0.6875rem] leading-relaxed text-muted">{t(`watcher.kind.${k}.text`)}</div>
                      </div>
                      <Switch on={on(k)} onChange={() => toggle(k)} disabled={!settings.enabled} label={t(`watcher.kind.${k}.title`)} />
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <h3 className="mb-2 text-[0.8125rem] font-medium">{t("watcher.behaviour")}</h3>
          <ul className="grid gap-3 text-[0.8125rem]">
            {(
              [
                ["tray", settings.trayOnClose, () => saveWatcher({ trayOnClose: !settings.trayOnClose })],
                ["autostart", !!autostart, () => setAutostart(!autostart)],
                ["weekly", settings.weekly, () => saveWatcher({ weekly: !settings.weekly })],
              ] as const
            ).map(([k, value, act]) => (
              <li key={k} className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div>{t(`watcher.option.${k}.title`)}</div>
                  <div className="text-[0.6875rem] leading-relaxed text-muted">{t(`watcher.option.${k}.text`)}</div>
                </div>
                <Switch on={value} onChange={act} label={t(`watcher.option.${k}.title`)} />
              </li>
            ))}
          </ul>
          <Button className="mt-4 w-full" icon={<BellRing size={14} />} onClick={() => (overlay?.enabled && overlay.alerts ? testOverlay() : testNotification())} data-testid="watcher-test">
            {t("watcher.test")}
          </Button>
          <p className="mt-2 text-center text-[0.6875rem] text-muted">{overlay?.enabled && overlay.alerts ? t("watcher.testWhere.island") : t("watcher.testWhere.windows")}</p>
        </div>
      </div>
    </div>
  );
}
