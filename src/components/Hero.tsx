import type { ReactNode } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { ShieldCheck, type LucideIcon } from "lucide-react";

export interface Feature {
  icon: LucideIcon;
  title: string;
  text: string;
}

/**
 * The start of a page that has not run yet: a glowing emblem, what the page does, three things
 * it looks at, the one button, and the promise that nothing changes without the user.
 */
export function Hero({
  icon: Icon,
  title,
  text,
  features,
  action,
  children,
  error,
  testid,
}: {
  icon: LucideIcon;
  title: string;
  text: string;
  features: Feature[];
  action: ReactNode;
  /** Shown between the text and the button (e.g. a drive picker). */
  children?: ReactNode;
  error?: ReactNode;
  testid?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col items-center justify-center py-8 text-center" data-testid={testid}>
      <div className="relative mb-8 flex h-[132px] w-[132px] items-center justify-center">
        {/* A soft glow of the accent behind the emblem. */}
        <div className="absolute inset-[-40px] rounded-full bg-accent/15 blur-3xl" />
        {[0, 1].map((k) => (
          <motion.span
            key={k}
            className="absolute inset-0 rounded-full border border-accent/40"
            animate={{ scale: [1, 1.45], opacity: [0.6, 0] }}
            transition={{ duration: 2.6, repeat: Infinity, ease: "easeOut", delay: k * 1.3 }}
          />
        ))}
        {/* A small light circling the emblem. */}
        <motion.span className="absolute inset-[-10px]" animate={{ rotate: 360 }} transition={{ duration: 9, repeat: Infinity, ease: "linear" }}>
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_12px_2px] shadow-accent/60" />
        </motion.span>
        <div className="relative flex h-full w-full items-center justify-center rounded-full border border-accent/25 bg-gradient-to-b from-surface to-raised text-accent shadow-[inset_0_1px_0_rgb(255_255_255/0.06),0_20px_40px_-20px_rgb(0_0_0/0.5)]">
          <Icon size={52} strokeWidth={1.3} />
        </div>
      </div>

      <motion.h2 initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="font-display text-[26px] font-semibold tracking-tight">
        {title}
      </motion.h2>
      <motion.p initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mt-2 max-w-[56ch] text-[14px] leading-relaxed text-muted">
        {text}
      </motion.p>
      {children}
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }} className="mt-7">
        {action}
      </motion.div>
      {error && <div className="mt-4 max-w-[60ch]">{error}</div>}

      <div className="mt-10 grid w-full max-w-[780px] gap-3 sm:grid-cols-3">
        {features.map((f, i) => (
          <motion.div
            key={f.title}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + i * 0.06 }}
            className="reveal lift rounded-card border border-line bg-surface/70 p-4 text-left"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <f.icon size={16} />
            </span>
            <div className="mt-3 text-[13px] font-medium">{f.title}</div>
            <div className="mt-1 text-[12px] leading-relaxed text-muted">{f.text}</div>
          </motion.div>
        ))}
      </div>
      <div className="mt-5 flex items-center gap-1.5 text-[11px] text-muted">
        <ShieldCheck size={13} className="text-safe" />
        {t("hero.safe")}
      </div>
    </div>
  );
}
