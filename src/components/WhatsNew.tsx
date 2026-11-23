import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Activity, AppWindow, Maximize2, Building2, ArrowRight, BellRing, Gift, HardDrive, Headphones, PackageCheck, Palette, ShieldCheck, Smartphone, Sparkles, Webcam, Wifi, Zap, type LucideIcon } from "lucide-react";
import { Button, Modal } from "./ui";
import { go, useApp, type Page } from "../lib/app";

/** What each release brings, newest first; texts live under whatsnew.<id>. */
const RELEASES: Record<string, { id: string; icon: LucideIcon; page: Page | null }[]> = {
  "0.4.3": [
    { id: "phones", icon: Headphones, page: "watcher" },
    { id: "vpnPing", icon: Wifi, page: "network" },
    { id: "layout", icon: Maximize2, page: null },
  ],
  "0.4.2": [
    { id: "cityPlan", icon: Building2, page: "disk" },
    { id: "scale", icon: Maximize2, page: null },
  ],
  "0.4.1": [
    { id: "city", icon: Building2, page: "disk" },
    { id: "disk3d", icon: HardDrive, page: "disk" },
    { id: "crashes", icon: Zap, page: "monitoring" },
    { id: "privacy", icon: Webcam, page: "privacy" },
    { id: "watcher", icon: BellRing, page: "watcher" },
    { id: "updates", icon: PackageCheck, page: "updates" },
    { id: "single", icon: AppWindow, page: null },
  ],
  "0.4.0": [
    { id: "phone", icon: Smartphone, page: "wifi" },
    { id: "shield", icon: ShieldCheck, page: "security" },
    { id: "overlay", icon: Sparkles, page: "watcher" },
    { id: "health", icon: Activity, page: "monitoring" },
    { id: "wifi", icon: Wifi, page: "wifi" },
    { id: "look", icon: Palette, page: null },
  ],
};

const KEY = "delpheye.seenVersion";

/** "0.4.1" > "0.4.0". */
const newer = (a: string, b: string) => {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** After an update: what is new, in a few animated cards. A fresh install gets the tour instead. */
export function WhatsNew() {
  const { t } = useTranslation();
  const version = useApp((s) => s.status?.version);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<(typeof RELEASES)[string]>([]);

  useEffect(() => {
    if (!version) return;
    let seen: string | null = null;
    try {
      seen = localStorage.getItem(KEY);
      localStorage.setItem(KEY, version);
    } catch {
      return;
    }
    // The onboarding marks a first start; only an existing install that moved up sees this.
    const onboarded = (() => {
      try {
        return localStorage.getItem("delpheye.onboarded") === "1";
      } catch {
        return false;
      }
    })();
    // Everything released after the version this install last ran, newest first.
    const fresh = Object.keys(RELEASES).filter((v) => newer(v, seen ?? "0.0.0") && !newer(v, version));
    setItems(fresh.sort((a, b) => (newer(a, b) ? -1 : 1)).flatMap((v) => RELEASES[v]).slice(0, 8));
    if (seen !== version && fresh.length && (seen !== null || onboarded)) setOpen(true);
  }, [version]);
  return (
    <Modal open={open} onClose={() => setOpen(false)} width="max-w-[38.75rem]">
      <div data-testid="whats-new">
        <div className="flex items-center gap-3">
          <motion.span
            initial={{ scale: 0.4, rotate: -25, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 380, damping: 14 }}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/12 text-accent"
          >
            <Gift size={22} />
          </motion.span>
          <div>
            <h2 className="font-display text-[1.1875rem] font-semibold">{t("whatsnew.title", { version })}</h2>
            <p className="text-[0.75rem] text-muted">{t("whatsnew.lead")}</p>
          </div>
        </div>
        <div className="mt-5 grid gap-2.5 sm:grid-cols-2">
          {items.map((it, i) => (
            <motion.button
              key={it.id}
              initial={{ opacity: 0, y: 14, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 340, damping: 26, delay: 0.12 + i * 0.07 }}
              onClick={() => {
                if (it.page) {
                  go(it.page);
                  setOpen(false);
                }
              }}
              className={`group lift flex items-start gap-3 rounded-xl border border-line bg-bg/40 p-3 text-left ${it.page ? "cursor-pointer hover:border-accent/40" : "cursor-default"}`}
            >
              <motion.span
                initial={{ rotate: -12, scale: 0.6 }}
                animate={{ rotate: 0, scale: 1 }}
                transition={{ type: "spring", stiffness: 420, damping: 12, delay: 0.2 + i * 0.07 }}
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent"
              >
                <it.icon size={16} />
              </motion.span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 text-[0.8125rem] font-medium">
                  {t(`whatsnew.items.${it.id}.title`)}
                  {it.page && <ArrowRight size={12} className="nudge text-muted" />}
                </span>
                <span className="mt-0.5 block text-[0.75rem] leading-relaxed text-muted">{t(`whatsnew.items.${it.id}.text`)}</span>
              </span>
            </motion.button>
          ))}
        </div>
        <div className="mt-5 flex justify-end">
          <Button variant="primary" onClick={() => setOpen(false)} data-testid="whats-new-close">
            {t("whatsnew.ok")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
