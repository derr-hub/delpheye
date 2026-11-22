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
  Rocket,
  type LucideIcon,
} from "lucide-react";

import { useApp, type Page } from "../lib/app";
import { UpdateChip } from "./UpdateChip";

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
  { id: "security", icon: ShieldHalf },
  { id: "journal", icon: History },
];

export function Sidebar({ page, onChange }: { page: Page; onChange: (p: Page) => void }) {
  const { t, i18n } = useTranslation();
  const elevated = useApp((s) => s.status?.elevated);
  const lang = i18n.language.startsWith("uk") ? "uk" : "en";

  return (
    <nav className="shell flex w-[212px] shrink-0 flex-col bg-bg p-3">
      <ul className="flex flex-col gap-1">
        {PAGES.map(({ id, icon: Icon }) => {
          const active = id === page;
          return (
            <li key={id}>
              <button
                onClick={() => onChange(id)}
                data-testid={`nav-${id}`}
                aria-current={active ? "page" : undefined}
                className={`reveal relative flex h-10 w-full items-center gap-3 rounded-lg px-3 text-left text-[13px] transition-colors duration-150 ${
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
              </button>
            </li>
          );
        })}
      </ul>

      <div className="mt-auto" />
      <UpdateChip />
      {elevated && (
        <div className="mb-2 flex items-center gap-2 px-3 text-[12px] text-accent" data-testid="admin-chip">
          <ShieldCheck size={15} />
          {t("app.admin")}
        </div>
      )}
      <div className="flex rounded-lg border border-line p-0.5 text-[12px]">
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
            <span className="relative">{code === "uk" ? "Українська" : "English"}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
