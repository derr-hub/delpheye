import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Check, Loader2, Minus, Plus, X } from "lucide-react";
import { useFmt } from "../../lib/format";
import { STEPS, advice, type Finding, type Progress, type Proof, type Suspect } from "../../lib/investigate";
import { titleOf, type TimelineEvent } from "../../lib/timeline";
import { Badge } from "./Cards";

const COLOR = { likely: "#ef5a60", possible: "#f0a04b", timing: "#7f8ea3", out: "#7f8ea3" } as const;

function Line({ p, sign }: { p: Proof; sign: "for" | "against" | "fact" }) {
  const { t } = useTranslation();
  const Icon = sign === "for" ? Plus : sign === "against" ? Minus : Check;
  return (
    <li className="flex gap-2 text-[0.75rem] leading-relaxed">
      <Icon size={13} className={`mt-[3px] shrink-0 ${sign === "for" ? "text-risk" : sign === "against" ? "text-safe" : "text-accent"}`} />
      <span>{t(`timeline.proof.${p.id}`, p.values ?? {})}</span>
    </li>
  );
}

/** The checks as they run: what each looked at and what it found. */
export function SearchSteps({ done, running }: { done: Progress[]; running: boolean }) {
  const { t } = useTranslation();
  return (
    <section className="rounded-card border border-line bg-surface p-5" data-testid="search-steps">
      <h3 className="mb-3 text-[0.8125rem] font-medium">{t(running ? "timeline.search.running" : "timeline.search.done")}</h3>
      <ol className="grid gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-3">
        {STEPS.map((id, i) => {
          const p = done.find((d) => d.step === id);
          const now = running && done.length === i;
          return (
            <li key={id} className={`flex gap-2.5 transition-opacity ${p || now ? "" : "opacity-40"}`} data-step={id}>
              <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[0.625rem] ${p ? (p.found.length ? "bg-accent text-bg" : "bg-raised text-muted") : "border border-line text-muted"}`}>{now ? <Loader2 size={11} className="animate-spin" /> : p ? <Check size={11} /> : i + 1}</span>
              <div className="min-w-0">
                <div className="text-[0.75rem] font-medium">{t(`timeline.search.step.${id}.name`)}</div>
                <div className="text-[0.6875rem] text-muted">{p ? t(`timeline.search.step.${id}.done`, { count: p.count }) : t(`timeline.search.step.${id}.what`)}</div>
                <AnimatePresence>
                  {p && p.found.length > 0 && (
                    <motion.ul initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="mt-1">
                      {p.found.slice(0, 2).map((f, k) => (
                        <Line key={k} p={f} sign="fact" />
                      ))}
                    </motion.ul>
                  )}
                </AnimatePresence>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function SuspectCard({ s, onPick }: { s: Suspect; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  return (
    <div className="rounded-xl border border-line p-3.5" data-testid="suspect" data-level={s.level}>
      <button className="flex w-full items-center gap-2.5 text-left" onClick={() => onPick(s.cause.e.id)}>
        <Badge e={s.cause.e} size={30} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[0.8125rem] font-medium">{titleOf(s.cause.e, t)}</span>
          <span className="num block text-[0.6875rem] text-muted">{fmt.date(s.cause.e.t)}</span>
        </span>
        <span className="shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-medium" style={{ background: `${COLOR[s.level]}26`, color: COLOR[s.level] }}>
          {t(`timeline.level.${s.level}`)}
        </span>
      </button>
      <ul className="mt-2 space-y-0.5">
        {s.for.map((p, i) => (
          <Line key={`f${i}`} p={p} sign="for" />
        ))}
        {s.against.map((p, i) => (
          <Line key={`a${i}`} p={p} sign="against" />
        ))}
        {!s.for.length && !s.against.length && <li className="text-[0.75rem] text-muted">{t("timeline.reason.none")}</li>}
      </ul>
    </div>
  );
}

/** What the search came to: a conclusion, the evidence for and against, what was ruled out and what to do. */
export function SearchResult({ problem, f, onPick }: { problem: TimelineEvent; f: Finding; onPick: (id: string) => void }) {
  const { t } = useTranslation();
  const top = f.suspects[0];
  const shared = f.conditions.filter((c) => c.id !== "normal");
  const verdict = top?.level === "likely" ? "likely" : shared.some((c) => c.id === "hot" || c.id === "ram" || c.id === "gpu") ? "conditions" : top?.level === "possible" ? "possible" : "nothing";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="search-result" data-verdict={verdict}>
      <section className="rounded-card border border-accent/40 bg-surface p-5">
        <h3 className="text-[0.75rem] text-muted">{t("timeline.conn.summary")}</h3>
        <p className="mt-1 font-display text-[1.125rem] font-semibold leading-snug">{t(`timeline.search.verdict.${verdict}`, { name: top ? titleOf(top.cause.e, t) : "" })}</p>
        <p className="mt-1 text-[0.75rem] text-muted">{t("timeline.search.basis", { count: f.siblings, measured: f.measured })}</p>
        {f.conditions.length > 0 && (
          <ul className="mt-3 space-y-0.5">
            {f.conditions.map((p, i) => (
              <Line key={i} p={p} sign="fact" />
            ))}
          </ul>
        )}
        {f.maker?.exists && (
          <p className="mt-2 text-[0.75rem] text-muted">
            {t("timeline.search.file", { name: f.module ?? "", company: f.maker.company ?? t("timeline.unknownMaker") })} {f.maker.signed === false && t("timeline.search.unsigned")}
          </p>
        )}
        <h4 className="mt-4 text-[0.75rem] font-medium">{t("timeline.search.next")}</h4>
        <ul className="mt-1 list-inside list-disc space-y-0.5 text-[0.8125rem]">
          {advice(problem, f).map((a) => (
            <li key={a}>{t(`timeline.search.advice.${a}`)}</li>
          ))}
        </ul>
      </section>
      {f.suspects.length > 0 && (
        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-3 text-[0.8125rem] font-medium">{t("timeline.search.suspects")}</h3>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            {f.suspects.slice(0, 6).map((s) => (
              <SuspectCard key={s.cause.e.id} s={s} onPick={onPick} />
            ))}
          </div>
          <p className="mt-3 text-[0.6875rem] text-muted">{t("timeline.search.legend")}</p>
        </section>
      )}
      {f.out.length > 0 && (
        <details className="rounded-card border border-line bg-surface p-5">
          <summary className="cursor-pointer text-[0.8125rem] font-medium">
            <X size={13} className="mr-1.5 inline text-muted" />
            {t("timeline.search.out", { count: f.out.length })}
          </summary>
          <div className="mt-3 grid items-start gap-3 lg:grid-cols-2">
            {f.out.slice(0, 10).map((s) => (
              <SuspectCard key={s.cause.e.id} s={s} onPick={onPick} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
