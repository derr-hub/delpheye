import { useEffect, useRef } from "react";
import { AnimatePresence, MotionConfig, motion, useScroll, useTransform } from "motion/react";
import { useTranslation } from "react-i18next";
import { Sidebar } from "./components/Sidebar";
import { TitleBar } from "./components/TitleBar";
import { go, loadAppStatus, useApp, type Page } from "./lib/app";
import { startCleanupEvents } from "./lib/cleanup";
import { loadDrives, startDiskEvents } from "./lib/disk";
import { startLeftoversEvents } from "./lib/leftovers";
import { startMonitor } from "./lib/monitor";
import { startMetrics } from "./lib/metrics";
import { checkForUpdate } from "./lib/update";
import { Cleanup } from "./pages/Cleanup";
import { Disk } from "./pages/Disk";
import { Leftovers } from "./pages/Leftovers";
import { Monitoring } from "./pages/Monitoring";
import { Processes } from "./pages/Processes";
import { Network } from "./pages/Network";
import { Report } from "./pages/Report";
import { SlowdownPanel } from "./components/Slowdown";
import { Feedback } from "./components/Feedback";
import { Onboarding } from "./components/Onboarding";
import { WhatsNew } from "./components/WhatsNew";
import { Security } from "./pages/Security";
import { Startup } from "./pages/Startup";
import { Updates } from "./pages/Updates";
import { Privacy } from "./pages/Privacy";
import { Wifi } from "./pages/Wifi";
import { Watcher } from "./pages/Watcher";
import { saveWatcher, startWatcher } from "./lib/watcher";
import { listen } from "@tauri-apps/api/event";
import i18n from "./i18n";
import { startPrivacy } from "./lib/privacy";
import { Journal } from "./pages/Journal";
import { Overview } from "./pages/Overview";

function PageBody({ page }: { page: Page }) {
  switch (page) {
    case "overview":
      return <Overview />;
    case "cleanup":
      return <Cleanup />;
    case "startup":
      return <Startup />;
    case "updates":
      return <Updates />;
    case "privacy":
      return <Privacy />;
    case "wifi":
      return <Wifi />;
    case "watcher":
      return <Watcher />;
    case "leftovers":
      return <Leftovers />;
    case "disk":
      return <Disk />;
    case "journal":
      return <Journal />;
    case "monitoring":
      return <Monitoring />;
    case "processes":
      return <Processes />;
    case "network":
      return <Network />;
    case "report":
      return <Report />;
    case "security":
      return <Security />;
  }
}

/** Keeps the reveal light (see styles.css) following the pointer across cards and buttons. */
function useRevealLight() {
  useEffect(() => {
    let frame = 0;
    let x = -9999;
    let y = -9999;
    const paint = () => {
      frame = 0;
      for (const el of document.querySelectorAll<HTMLElement>(".reveal")) {
        const r = el.getBoundingClientRect();
        const dx = Math.max(r.left - x, 0, x - r.right);
        const dy = Math.max(r.top - y, 0, y - r.bottom);
        const near = 1 - Math.min(1, Math.hypot(dx, dy) / 110);
        el.style.setProperty("--rx", `${x - r.left}px`);
        el.style.setProperty("--ry", `${y - r.top}px`);
        el.style.setProperty("--ro", near.toFixed(2));
      }
    };
    const move = (e: PointerEvent) => {
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const leave = () => {
      x = y = -9999;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    return () => {
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
      cancelAnimationFrame(frame);
    };
  }, []);
}

function App() {
  const { t } = useTranslation();
  const page = useApp((s) => s.page);
  const main = useRef<HTMLElement>(null);
  // The page heading shrinks into a compact, blurred bar as the page scrolls.
  const { scrollY } = useScroll({ container: main });
  const headingSize = useTransform(scrollY, [0, 72], [22, 15]);
  const barOpacity = useTransform(scrollY, [8, 72], [0, 1]);
  useRevealLight();

  useEffect(() => {
    loadAppStatus();
    startMetrics();
    startCleanupEvents();
    startDiskEvents();
    startLeftoversEvents();
    startMonitor();
    startPrivacy();
    startWatcher(i18n.language.startsWith("en") ? "en" : "uk");
    i18n.on("languageChanged", (lng) => saveWatcher({ lang: lng.startsWith("en") ? "en" : "uk" }));
    loadDrives();
    // The overlay's "open DelphEye" can ask for a page.
    if ("__TAURI_INTERNALS__" in window) listen<Page>("navigate", ({ payload }) => go(payload));
    // A quiet look for a newer release, at most once a day.
    window.setTimeout(() => checkForUpdate(true), 8000);
  }, []);

  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [page]);

  return (
    // reducedMotion="user" honours the Windows "animation effects" setting.
    <MotionConfig reducedMotion="user">
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="flex min-h-0 flex-1">
          <Sidebar page={page} onChange={go} />
          <main ref={main} className="content-layer relative flex min-w-0 flex-1 flex-col overflow-y-auto px-7 pb-6">
            <div className="sticky top-0 z-20 -mx-7 mb-3 flex h-[52px] shrink-0 items-center px-7 pt-2">
              <motion.div
                aria-hidden
                style={{ opacity: barOpacity }}
                className="pointer-events-none absolute inset-0 border-b border-line/70 bg-bg/80 shadow-[0_8px_24px_-16px_rgb(0_0_0/0.35)] backdrop-blur-xl"
              />
              <motion.h1 style={{ fontSize: headingSize }} className="relative font-display font-semibold leading-none">
                <motion.span key={page} layoutId={`page-title-${page}`} className="inline-block" transition={{ type: "spring", stiffness: 300, damping: 32 }}>
                  {page === "overview" ? t("overview.title") : page === "report" ? t("report.title") : t(`nav.${page}`)}
                </motion.span>
              </motion.h1>
            </div>
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={page}
                className="page-enter flex-1"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ type: "spring", stiffness: 380, damping: 36 }}
              >
                <PageBody page={page} />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
      <SlowdownPanel />
      <Feedback />
      <Onboarding />
      <WhatsNew />
    </MotionConfig>
  );
}

export default App;
