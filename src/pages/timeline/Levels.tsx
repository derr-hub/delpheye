import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Binary, Blocks, Cable, Compass, Cpu, HardDrive, ListTree, MousePointer2, ShieldCheck, AppWindow, type LucideIcon } from "lucide-react";
import { LEVELS, direction, picture, type Fact, type LevelId, type LevelView, type Picture, type Run, type State } from "../../lib/levels";
import type { TimelineEvent } from "../../lib/timeline";

const ICON: Record<LevelId, LucideIcon> = { action: MousePointer2, program: AppWindow, process: ListTree, library: Blocks, kernel: ShieldCheck, driver: Cable, hardware: HardDrive, machine: Binary };
const TONE: Record<State, string> = { ok: "#3fa96b", warn: "#e0a030", bad: "#e5484d", unknown: "#6b7a8d" };
const MODES = ["simple", "tech", "code"] as const;
type Mode = (typeof MODES)[number];

function useFact() {
  const { t } = useTranslation();
  return (f: Fact) => {
    const v = { ...(f.v ?? {}) };
    if (typeof v.list === "string") v.list = v.list.split(", ").map((x) => t(`timeline.lv.made.${x}`, { defaultValue: x })).join(", ");
    if (typeof v.cls === "string") v.cls = t(`timeline.class.${v.cls}`, { defaultValue: "" });
    return t(`timeline.lv.fact.${f.key}`, v);
  };
}

/** The very instructions, with the one it stopped at marked. */
export function CodeView({ p }: { p: Picture }) {
  const { t } = useTranslation();
  const c = p.code;
  if (!c) return <p className="text-[0.75rem] text-muted">{t("timeline.lv.noCode")}</p>;
  if (c.same === false) return <p className="text-[0.75rem] text-muted">{t("timeline.lv.otherBuild")}</p>;
  return (
    <div className="grid gap-3" data-testid="code-view">
      {c.lines.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-line bg-[#0b0f14] p-3 font-mono text-[0.6875rem] leading-[1.7] text-[#c9d6e2]">
          {c.lines.map((l) => (
            <div key={l.at} className={`flex w-max min-w-full gap-4 rounded px-2 ${l.here && p.detail ? "bg-[#e5484d33] text-white" : ""}`} data-here={l.here || undefined}>
              <span className="w-16 shrink-0 text-right text-[#6b7a8d]">{l.at}</span>
              <span className="w-44 shrink-0 text-[#5fb3d9]">{l.bytes}</span>
              <span>{l.text}</span>
              {l.here && p.detail && <span className="text-[#ff9aa0]">← {t("timeline.lv.here")}</span>}
            </div>
          ))}
        </div>
      )}
      {c.hex.length > 0 && (
        <div>
          <div className="mb-1 text-[0.6875rem] text-muted">{t("timeline.lv.bytes")}</div>
          <div className="grid gap-x-6 overflow-x-auto rounded-lg border border-line bg-[#0b0f14] p-3 font-mono text-[0.6875rem] leading-[1.7] text-[#5fb3d9] md:grid-cols-2">
            <div>{c.hex.map((h, i) => <div key={i} className="whitespace-nowrap">{h}</div>)}</div>
            <div className="text-[#7fa08a]">{c.hex.slice(0, 2).map((h, i) => <div key={i} className="break-all">{h.split(" ").map((b) => parseInt(b, 16).toString(2).padStart(8, "0")).join(" ")}</div>)}</div>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[0.6875rem] text-muted">
        <span>{c.arch}</span>
        <span>linker {c.linker}</span>
        {c.sections.slice(0, 6).map(([n, s]) => (
          <span key={n} className="num">{`${n} ${Math.round(s / 1024)} KB`}</span>
        ))}
      </div>
    </div>
  );
}

/** One moment through every level of the machine, from the person to the bits. */
export function Levels({ at, event = null, run = null, all, start = "simple", onPicture }: { at: number; event?: TimelineEvent | null; run?: Run | null; all: TimelineEvent[]; start?: Mode; onPicture?: (p: Picture) => void }) {
  const { t } = useTranslation();
  const still = useReducedMotion();
  const text = useFact();
  const [p, setP] = useState<Picture | null>(null);
  const [mode, setMode] = useState<Mode>(start);
  const [open, setOpen] = useState<LevelId | null>(null);
  useEffect(() => {
    let alive = true;
    setP(null);
    setOpen(null);
    picture(at, { event, run, all })
      .then((x) => {
        if (!alive) return;
        setP(x);
        onPicture?.(x);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // The same moment is the same picture; `all` only grows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, event?.id, run?.start, run?.exe]);
  const problem = event && ["crash", "appcrash", "hang", "svccrash", "io", "alert"].includes(event.kind);
  const dir = p && event && problem ? direction(event, p) : null;
  const by = (id: LevelId): LevelView | undefined => p?.levels.find((l) => l.id === id);
  return (
    <section data-testid="levels">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h4 className="text-[0.8125rem] font-medium">{t("timeline.lv.title")}</h4>
        <div className="ml-auto flex rounded-lg border border-line p-0.5 text-[0.6875rem]">
          {MODES.map((m) => (
            <button key={m} onClick={() => setMode(m)} aria-pressed={mode === m} className={`rounded-md px-2.5 py-1 ${mode === m ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`levels-${m}`}>
              {t(`timeline.lv.mode.${m}`)}
            </button>
          ))}
        </div>
      </div>
      {dir && (
        <div className={`mb-3 flex gap-3 rounded-xl border p-3.5 ${dir.sure === "certain" ? "border-safe/50 bg-safe/5" : dir.sure === "direction" ? "border-accent/50 bg-accent/5" : "border-line"}`} data-testid="direction" data-sure={dir.sure} data-level={dir.level}>
          <Compass size={18} className={`mt-0.5 shrink-0 ${dir.sure === "certain" ? "text-safe" : dir.sure === "direction" ? "text-accent" : "text-muted"}`} />
          <div>
            <div className="text-[0.75rem] font-medium">{t(`timeline.dir.sure.${dir.sure}`, { level: t(`timeline.lv.name.${dir.level}`) })}</div>
            <div className="text-[0.75rem] leading-relaxed text-muted">{dir.key === "verdict" ? `${t(`monitor.verdict.cause.${dir.v?.cause}.title`)}. ${t(`monitor.verdict.cause.${dir.v?.cause}.todo`)}` : t(`timeline.dir.${dir.key}`, dir.v ?? {})}</div>
          </div>
        </div>
      )}
      {mode === "code" ? (
        p ? (
          <CodeView p={p} />
        ) : (
          <p className="text-[0.75rem] text-muted">…</p>
        )
      ) : (
        <ol className="relative">
          {/* The signal running through the machine; it breaks where something is wrong. */}
          <span className="absolute bottom-6 left-[1.1rem] top-6 w-px bg-line" />
          {p && !still && <motion.span key={`${at}${event?.id}`} className="absolute left-[1rem] h-2 w-2 rounded-full bg-accent" initial={{ top: "2%", opacity: 0 }} animate={{ top: "96%", opacity: [0, 1, 1, 0] }} transition={{ duration: 2.2, ease: "easeInOut" }} />}
          {LEVELS.map((id, i) => {
            const l = by(id);
            const Icon = ICON[id];
            const tone = TONE[l?.state ?? "unknown"];
            const on = open === id || mode === "tech";
            const here = dir?.level === id && dir.sure !== "unknown";
            return (
              <motion.li key={id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: still ? 0 : i * 0.05 }} className="relative flex gap-3 py-1" data-level={id} data-state={l?.state ?? "unknown"}>
                <span className="relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border bg-surface" style={{ borderColor: tone, color: tone, boxShadow: here ? `0 0 0 3px ${tone}40` : undefined }}>
                  <Icon size={16} />
                </span>
                <div className={`min-w-0 flex-1 rounded-lg px-2.5 py-1 ${here ? "bg-raised/70" : ""}`}>
                  <button onClick={() => setOpen(open === id ? null : id)} className="flex w-full items-baseline gap-2 text-left" disabled={!l?.facts.length} aria-expanded={on}>
                    <span className="text-[0.75rem] font-medium">{t(`timeline.lv.name.${id}`)}</span>
                    <span className="text-[0.625rem]" style={{ color: tone }}>
                      {t(`timeline.lv.state.${l?.state ?? "unknown"}`)}
                    </span>
                  </button>
                  {mode === "simple" && <p className="text-[0.75rem] leading-relaxed text-muted">{l ? text(l.simple) : "…"}</p>}
                  {on && l && l.facts.length > 0 && (
                    <ul className="mt-0.5 space-y-0.5">
                      {l.facts.map((f, k) => (
                        <li key={k} className="flex gap-2 break-words text-[0.6875rem] leading-relaxed">
                          <span className="mt-[0.4rem] h-1 w-1 shrink-0 rounded-full" style={{ background: TONE[f.state ?? "unknown"] }} />
                          <span className="min-w-0 break-words">{text(f)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {mode === "tech" && l && !l.facts.length && <p className="text-[0.6875rem] text-muted">{t("timeline.lv.fact.sUnknown")}</p>}
                </div>
              </motion.li>
            );
          })}
        </ol>
      )}
      <p className="mt-2 flex items-center gap-1.5 text-[0.6875rem] text-muted">
        <Cpu size={12} />
        {t("timeline.lv.note")}
      </p>
    </section>
  );
}
