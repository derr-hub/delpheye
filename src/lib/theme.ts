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

function apply() {
  const { pref } = useTheme.getState();
  const light = pref === "light" || (pref === "system" && !!media?.matches);
  document.documentElement.classList.toggle("light", light);
  document.documentElement.style.colorScheme = light ? "light" : "dark";
  useTheme.setState({ light });
  // The Mica backdrop and the window frame follow the theme too.
  if ("__TAURI_INTERNALS__" in window) {
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => getCurrentWindow().setTheme(light ? "light" : "dark").catch(() => {}));
  }
}

let started = false;
export function startTheme() {
  if (started) return;
  started = true;
  apply();
  media?.addEventListener("change", () => useTheme.getState().pref === "system" && apply());
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
