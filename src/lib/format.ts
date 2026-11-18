import { useMemo } from "react";
import { useTranslation } from "react-i18next";

export type Lang = "uk" | "en";

const UNITS: Record<Lang, { bytes: string[]; ghz: string; mhz: string; sec: string; ms: string }> = {
  en: { bytes: ["B", "KB", "MB", "GB", "TB"], ghz: "GHz", mhz: "MHz", sec: "s", ms: "ms" },
  uk: { bytes: ["Б", "КБ", "МБ", "ГБ", "ТБ"], ghz: "ГГц", mhz: "МГц", sec: "с", ms: "мс" },
};

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/** Number, size and date formatting in the conventions of one language. */
export function makeFormat(lang: Lang) {
  const locale = lang === "uk" ? "uk-UA" : "en-US";
  const units = UNITS[lang];
  const fixed = (digits: number) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const [d0, d1, d2] = [fixed(0), fixed(1), fixed(2)];
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const date = new Intl.DateTimeFormat(locale, { day: "2-digit", month: "2-digit", year: "numeric" });

  return {
    int: (n: number) => d0.format(n),
    /** Binary units, e.g. 15.8 GB. */
    bytes(bytes: number): string {
      if (!Number.isFinite(bytes) || bytes < 1) return `0 ${units.bytes[0]}`;
      const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.bytes.length - 1);
      return `${(i === 0 ? d0 : d1).format(bytes / 1024 ** i)} ${units.bytes[i]}`;
    },
    frequency: (mhz: number) =>
      mhz >= 1000 ? `${d2.format(mhz / 1000)} ${units.ghz}` : `${d0.format(mhz)} ${units.mhz}`,
    duration: (ms: number) => (ms < 1000 ? `${d0.format(ms)} ${units.ms}` : `${d1.format(ms / 1000)} ${units.sec}`),
    dateTime: (unixSeconds: number) => dateTime.format(new Date(unixSeconds * 1000)),
    date: (unixSeconds: number) => date.format(new Date(unixSeconds * 1000)),
  };
}

export function useFmt() {
  const { i18n } = useTranslation();
  const lang: Lang = i18n.language.startsWith("uk") ? "uk" : "en";
  return useMemo(() => makeFormat(lang), [lang]);
}

export function formatUptime(seconds: number, u: { d: string; h: string; m: string }): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} ${u.d} ${h} ${u.h}`;
  if (h > 0) return `${h} ${u.h} ${m} ${u.m}`;
  return `${m} ${u.m}`;
}

/** Shortens a long path from the middle, keeping the drive and the file name readable. */
export function shortenPath(path: string, max = 72): string {
  if (path.length <= max) return path;
  const tail = Math.ceil((max - 1) * 0.6);
  return `${path.slice(0, max - 1 - tail)}…${path.slice(-tail)}`;
}
