import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { ArrowLeft, ArrowRight, BellRing, Brush, Eye, Gauge, MessageSquareHeart, Wifi } from "lucide-react";
import { Button, Modal } from "./ui";
import { go, type Page } from "../lib/app";

const KEY = "delpheye.onboarded";
const seen = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return true;
  }
};

export const useOnboarding = create<{ open: boolean }>(() => ({ open: !seen() }));
export const showOnboarding = () => useOnboarding.setState({ open: true });

const STEPS = [
  { id: "welcome", icon: Eye, page: "overview" },
  { id: "speed", icon: Gauge, page: "overview" },
  { id: "clean", icon: Brush, page: "cleanup" },
  { id: "wifi", icon: Wifi, page: "wifi" },
  { id: "watch", icon: BellRing, page: "watcher" },
  { id: "feedback", icon: MessageSquareHeart, page: null },
] as const satisfies readonly { id: string; icon: unknown; page: Page | null }[];

/** A short tour on the first start: what DelphEye does and where. */
export function Onboarding() {
  const { t } = useTranslation();
  const open = useOnboarding((s) => s.open);
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);
  const step = STEPS[i];
  const Icon = step.icon;

  const close = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      /* shown again next time */
    }
    useOnboarding.setState({ open: false });
    setI(0);
  };
  const move = (d: number) => {
    setDir(d);
    setI((x) => Math.max(0, Math.min(STEPS.length - 1, x + d)));
  };

  return (
    <Modal open={open} onClose={close} width="max-w-[520px]">
      <div data-testid="onboarding">
        <div className="mb-4 flex gap-1.5">
          {STEPS.map((s, k) => (
            <span key={s.id} className={`h-1 flex-1 rounded-full transition-colors duration-300 ${k <= i ? "bg-accent" : "bg-raised"}`} />
          ))}
        </div>
        <div className="relative h-[230px] overflow-hidden">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div
              key={step.id}
              custom={dir}
              initial={{ opacity: 0, x: dir * 40 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: dir * -40 }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              className="absolute inset-0"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent">
                <Icon size={28} />
              </span>
              <h2 className="mt-4 font-display text-[20px] font-semibold">{t(`onboarding.${step.id}.title`)}</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-muted">{t(`onboarding.${step.id}.text`)}</p>
              {step.page && i > 0 && (
                <button
                  onClick={() => {
                    go(step.page as Page);
                    close();
                  }}
                  className="mt-3 text-[12px] text-accent hover:underline"
                >
                  {t("onboarding.open", { page: t(`nav.${step.page}`) })} →
                </button>
              )}
            </motion.div>
          </AnimatePresence>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button onClick={close} className="text-[12px] text-muted hover:text-fg" data-testid="onboarding-skip">
            {t("onboarding.skip")}
          </button>
          <span className="ml-auto" />
          {i > 0 && (
            <Button variant="quiet" icon={<ArrowLeft size={14} />} onClick={() => move(-1)}>
              {t("onboarding.back")}
            </Button>
          )}
          {i < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => move(1)} data-testid="onboarding-next">
              {i === 0 ? t("onboarding.start") : t("onboarding.next")}
              <ArrowRight size={14} />
            </Button>
          ) : (
            <Button variant="primary" onClick={close} data-testid="onboarding-done">
              {t("onboarding.done")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
