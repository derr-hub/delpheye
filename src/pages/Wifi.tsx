import { ShareWifi } from "./wifi/Share";
import { useEffect } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, MapPin, Radar, Router, Sparkles, WifiOff } from "lucide-react";
import { Button } from "../components/ui";
import { setMode, startWifi, stopWifi, useWifi } from "../lib/wifi";
import { Simple } from "./wifi/Simple";
import { Advanced } from "./wifi/Advanced";
import { Pro } from "./wifi/Pro";

function Blocked({ state }: { state: "off" | "none" | "denied" | "error" }) {
  const { t } = useTranslation();
  const Icon = state === "denied" ? MapPin : WifiOff;
  const url = state === "off" ? "ms-settings:network-wifi" : state === "denied" ? "ms-settings:privacy-location" : null;
  return (
    <div className="flex h-full flex-col items-center justify-center text-center" data-testid={`wifi-${state}`}>
      <div className="mb-6 flex h-24 w-24 items-center justify-center rounded-full border border-line bg-surface text-muted">
        <Icon size={40} strokeWidth={1.4} />
      </div>
      <h2 className="font-display text-[1.25rem] font-semibold">{t(`wifi.blocked.${state}.title`)}</h2>
      <p className="mt-2 max-w-[52ch] text-[0.8125rem] leading-relaxed text-muted">{t(`wifi.blocked.${state}.text`)}</p>
      {url && (
        <Button variant="primary" className="mt-6" onClick={() => openUrl(url).catch(console.error)}>
          {t(`wifi.blocked.${state}.action`)}
        </Button>
      )}
      <p className="mt-4 flex items-center gap-1.5 text-[0.6875rem] text-muted/70">
        <Loader2 size={11} className="animate-spin" />
        {t("wifi.waiting")}
      </p>
    </div>
  );
}

export function Wifi() {
  const { t } = useTranslation();
  const snap = useWifi((s) => s.snap);
  const mode = useWifi((s) => s.mode);
  const scanning = useWifi((s) => s.scanning);

  useEffect(() => {
    startWifi();
    return stopWifi;
  }, []);

  const body =
    mode === "pro" ? (
      <Pro />
    ) : !snap ? (
      <div className="flex h-[60vh] flex-col items-center justify-center gap-3 text-muted">
        <Loader2 className="animate-spin text-accent" />
        {t("wifi.first")}
      </div>
    ) : snap.state !== "ok" ? (
      <div className="h-[70vh]">
        <Blocked state={snap.state} />
      </div>
    ) : mode === "simple" ? (
      <Simple />
    ) : (
      <Advanced />
    );

  return (
    <div className="mx-auto max-w-[68.75rem] pb-6">
      <div className="mb-4 flex items-center gap-3">
        <div className="flex rounded-lg border border-line bg-surface p-0.5" role="tablist">
          {(
            [
              ["simple", Sparkles],
              ["advanced", Radar],
              ["pro", Router],
            ] as const
          ).map(([m, Icon]) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              data-testid={`wifi-mode-${m}`}
              className={`relative flex h-8 items-center gap-1.5 rounded-md px-3 text-[0.75rem] transition-colors ${mode === m ? "text-fg" : "text-muted hover:text-fg"}`}
            >
              {mode === m && <motion.span layoutId="wifi-mode" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
              <Icon size={13} className="relative" />
              <span className="relative">{t(`wifi.mode.${m}`)}</span>
            </button>
          ))}
        </div>
        {snap?.state === "ok" && snap.link && <ShareWifi />}
        <span className={`ml-auto items-center gap-2 text-[0.6875rem] text-muted ${mode === "pro" ? "hidden" : "flex"}`}>
          <span className="relative flex h-2 w-2">
            {scanning && <motion.span className="absolute inset-0 rounded-full bg-accent" animate={{ scale: [1, 2.4], opacity: [0.7, 0] }} transition={{ duration: 1.2, repeat: Infinity }} />}
            <span className={`relative h-2 w-2 rounded-full ${scanning ? "bg-accent" : "bg-line"}`} />
          </span>
          {snap?.state === "ok" && mode !== "pro" && (scanning ? t("wifi.scanning") : t("wifi.live", { count: snap.networks.length }))}
          {snap?.interface && mode !== "pro" && <span className="hidden text-muted/60 lg:inline">· {snap.interface}</span>}
        </span>
      </div>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={mode} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
          {body}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
