import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  Brush,
  HardDrive,
  History,
  ListTree,
  Network,
  LayoutDashboard,
  ShieldCheck,
  ShieldHalf,
  PackageX,
  PackageCheck,
  Webcam,
  Wifi,
  BellRing,
  Rocket,
  MessageSquareHeart,
  type LucideIcon,
} from "lucide-react";

import { ThemeMenu } from "./ThemeMenu";
import { openFeedback } from "../lib/feedback";
import { useApp, type Page } from "../lib/app";
import { UpdateChip } from "./UpdateChip";
import { unread, useWatcher } from "../lib/watcher";

export const PAGES: { id: Page; icon: LucideIcon }[] = [
  { id: "overview", icon: LayoutDashboard },
  { id: "cleanup", icon: Brush },
  { id: "leftovers", icon: PackageX },
  { id: "startup", icon: Rocket },
  { id: "updates", icon: PackageCheck },
  { id: "disk", icon: HardDrive },
  { id: "monitoring", icon: Activity },
  { id: "processes", icon: ListTree },
  { id: "network", icon: Network },
  { id: "wifi", icon: Wifi },
  { id: "privacy", icon: Webcam },
  { id: "security", icon: ShieldHalf },
  { id: "watcher", icon: BellRing },
  { id: "journal", icon: History },
];

export function Sidebar({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
  const { t, i18n } = useTranslation();
  const elevated = useApp((s) => s.status?.elevated);
  const lang = i18n.language.startsWith("uk") ? "uk" : "en";
  const alerts = useWatcher((s) => s.alerts);
  const fresh = unread(alerts);

  return (
    <nav className="shell flex w-[13.25rem] shrink-0 flex-col bg-bg p-3">
      {/* The list scrolls in a low window, so the language and theme below always stay reachable. */}
      <motion.ul layoutScroll className="-mr-2 flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto pr-2">
        {PAGES.map(({ id, icon: Icon }) => {
          const active = id === page;
          return (
            <li key={id}>
              <button
                onClick={() => onChange(id)}
                data-testid={`nav-${id}`}
                aria-current={active ? "page" : undefined}
                className={`reveal relative flex h-10 w-full shrink-0 items-center gap-3 rounded-lg px-3 text-left text-[0.8125rem] transition-colors duration-150 ${
                  active ? "text-fg" : "text-muted hover:bg-surface hover:text-fg"
                }`}
              >
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-0 rounded-lg bg-raised"
                    transition={{ type: "spring", stiffness: 420, damping: 34 }}
                  >
                    <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-accent" />
                  </motion.span>
                )}
                <Icon size={17} className={`relative ${active ? "text-accent" : ""}`} />
                <span className="relative">{t(`nav.${id}`)}</span>
                {id === "watcher" && fresh > 0 && (
                  <span className="num relative ml-auto rounded-full bg-warn px-1.5 text-[0.625rem] font-semibold text-bg" data-testid="watcher-badge">
                    {fresh}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </motion.ul>

      <UpdateChip />
      {elevated && (
        <div className="mb-2 flex items-center gap-2 px-3 text-[0.75rem] text-accent" data-testid="admin-chip">
          <ShieldCheck size={15} />
          {t("app.admin")}
        </div>
      )}
      <div className="flex items-center gap-1.5">
      <div className="flex flex-1 rounded-lg border border-line p-0.5 text-[0.75rem]">
        {(["uk", "en"] as const).map((code) => (
          <button
            key={code}
            onClick={() => i18n.changeLanguage(code)}
            data-testid={`lang-${code}`}
            className={`relative h-7 flex-1 rounded-md transition-colors duration-150 ${
              lang === code ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {lang === code && (
              <motion.span
                layoutId="lang-active"
                className="absolute inset-0 rounded-md bg-raised"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
              />
            )}
            <span className="relative">{code === "uk" ? "Укр" : "Eng"}</span>
          </button>
        ))}
      </div>
        <ThemeMenu />
        <button
          onClick={openFeedback}
          title={t("feedback.open")}
          aria-label={t("feedback.open")}
          data-testid="feedback-open"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line text-muted transition-colors hover:bg-raised hover:text-accent"
        >
          <MessageSquareHeart size={15} />
        </button>
      </div>
    </nav>
  );
}
