import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useApp } from "../lib/app";
import { Island } from "./Island";

const inTauri = "__TAURI_INTERNALS__" in window;

function act(fn: (w: ReturnType<typeof getCurrentWindow>) => Promise<void>) {
  if (inTauri) fn(getCurrentWindow()).catch(console.error);
}

export function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        stroke="var(--color-accent)"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3.2" fill="var(--color-accent)" />
    </svg>
  );
}

export function TitleBar() {
  const { t } = useTranslation();
  const sandbox = useApp((s) => s.status?.sandbox);
  const btn =
    "flex h-9 w-11 items-center justify-center text-muted transition-colors duration-150 hover:bg-raised hover:text-fg";
  return (
    <div data-tauri-drag-region className="shell grid h-9 shrink-0 grid-cols-[1fr_auto_1fr] items-center bg-bg pl-4">
      <div data-tauri-drag-region className="flex items-center gap-2">
        <Logo />
        <span data-tauri-drag-region className="font-display text-[13px] font-semibold tracking-wide">
          DelphEye
        </span>
        {sandbox && (
          <span data-tauri-drag-region className="rounded-full bg-warn/10 px-2 py-0.5 text-[11px] text-warn" title={t("cleanup.sandbox")}>
            {t("app.sandbox")}
          </span>
        )}
      </div>
      <Island />
      <div data-tauri-drag-region className="flex h-full justify-end">
      <button className={btn} title={t("window.minimize")} aria-label={t("window.minimize")} onClick={() => act((w) => w.minimize())}>
        <Minus size={15} />
      </button>
      <button className={btn} title={t("window.maximize")} aria-label={t("window.maximize")} onClick={() => act((w) => w.toggleMaximize())}>
        <Square size={12} />
      </button>
      <button
        className="flex h-9 w-11 items-center justify-center text-muted transition-colors duration-150 hover:bg-[#c42b1c] hover:text-white"
        title={t("window.close")}
        aria-label={t("window.close")}
        onClick={() => act((w) => w.close())}
      >
        <X size={15} />
      </button>
      </div>
    </div>
  );
}
