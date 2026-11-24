import { create } from "zustand";

/** "system" follows Windows' own light/dark setting. */
export type ThemePref = "system" | "dark" | "light";

const KEY = "delpheye.theme";
const load = (): ThemePref => {
  try {
    const v = localStorage.getItem(KEY);
    return v === "dark" || v === "light" ? v : "system";
  } catch {
    return "system";
  }
};

export const useTheme = create<{ pref: ThemePref; light: boolean }>(() => ({ pref: load(), light: false }));

const media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: light)") : null;

/** Counts choices, so a slow answer to an earlier one cannot override a later one. */
let turn = 0;

async function apply() {
  const mine = ++turn;
  const { pref } = useTheme.getState();
  const tauri = "__TAURI_INTERNALS__" in window;
  if (tauri && pref === "system") {
    // A window forced light or dark answers "prefers-color-scheme" with that, not with Windows'
    // own setting: let go of the window first.
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow()
      .setTheme(null)
      .catch(() => {});
    if (mine !== turn) return;
  }
  paint();
  if (tauri && pref !== "system") {
    // The Mica backdrop and the window frame follow the theme too.
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    if (mine === turn) await getCurrentWindow().setTheme(pref).catch(() => {});
  }
}

function paint() {
  const { pref } = useTheme.getState();
  const light = pref === "light" || (pref === "system" && !!media?.matches);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  useTheme.setState({ light });
}

let started = false;
export function startTheme() {
  if (started) return;
  started = true;
  // Painted at once, before anything is asked of the window: no flash of the wrong theme.
  paint();
  apply();
  media?.addEventListener("change", () => useTheme.getState().pref === "system" && paint());
}

export function setTheme(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* this session only */
  }
  useTheme.setState({ pref });
  apply();
}

/** System → dark → light → system. */
export const nextTheme = (p: ThemePref): ThemePref => (p === "system" ? "dark" : p === "dark" ? "light" : "system");
