import { useEffect, useState } from "react";
import { motion } from "motion/react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Binary, Blocks, CircleAlert, CircleCheck, CircleHelp, FileCode2, MessageSquareText, Sparkles, TriangleAlert } from "lucide-react";
import type { Maker } from "../../lib/investigate";
import { health, loadCode, loadMaker, type Code, type Part, type Picture, type State } from "../../lib/levels";
import type { TimelineEvent } from "../../lib/timeline";

const STEPS = [
  ["does", Sparkles],
  ["calls", Blocks],
  ["plain", MessageSquareText],
  ["asm", FileCode2],
  ["bytes", Binary],
  ["bits", Binary],
] as const;
type Step = (typeof STEPS)[number][0];
const MARK: Record<State, [typeof CircleCheck, string]> = { ok: [CircleCheck, "text-safe"], warn: [TriangleAlert, "text-warn"], bad: [CircleAlert, "text-risk"], unknown: [CircleHelp, "text-muted"] };
const nameOf = (p: string) => p.split("\\").pop() ?? p;

/** An instruction in words. Knows the common ones; the rest keep their own name. */
export function plain(text: string, t: TFunction): string {
  const at = text.indexOf(" ");
  let op = at < 0 ? text : text.slice(0, at);
  let rest = at < 0 ? "" : text.slice(at + 1).trim();
  if (["rep", "repe", "repne", "lock"].includes(op)) {
    op = rest.split(" ")[0];
    rest = rest.slice(op.length).trim();
  }
  // Commas inside brackets do not occur; those between operands do.
  const [a = "", b = ""] = rest.split(",").map((x) => x.trim().replace(/\b0+(?=[0-9A-Fa-f]+h\b)/g, "").replace(/^(short|near ptr|far ptr)\s+/, "").replace(/\b(qword|dword|word|byte|xmmword|ymmword) ptr\s*/g, ""));
  const mem = (x: string) => x.includes("[");
  const k = (key: string, v: Record<string, string> = {}) => t(`timeline.asm.${key}`, { a, b, op, ...v });
  const cond = (c: string) => t(`timeline.asm.c.${c}`, { defaultValue: t("timeline.asm.c.x") });
  if (/^mov(zx|sx|sxd|abs)?$/.test(op)) return mem(b) ? k("load") : mem(a) ? k("store") : k("copy");
  if (op === "lea") return k("address");
  if (op === "add") return k("add");
  if (op === "sub") return k("sub");
  if (op === "inc" || op === "dec") return k(op);
  if (op === "xor" && a === b) return k("zero");
  if (["xor", "and", "or", "not"].includes(op)) return k("bit");
  if (["shl", "shr", "sar", "rol", "ror"].includes(op)) return k("shift");
  if (op === "imul" || op === "mul") return k("mul", { a: rest });
  if (op === "idiv" || op === "div") return k("div");
  if (op === "cmp") return k("compare");
  if (op === "test") return a === b ? k("testZero") : k("test");
  if (op === "jmp") return k("jump");
  if (/^j/.test(op)) return k("jumpIf", { cond: cond(op.slice(1)) });
  if (op === "call") return k("call");
  if (op === "ret") return k("ret");
  if (op === "push" || op === "pop") return k(op);
  if (op === "nop" || op === "endbr64") return k("nop");
  if (op === "int" && /^29h/.test(rest)) return k("stop");
  if (op === "int3" || op === "int") return k("trap");
  if (op === "syscall" || op === "sysenter") return k("syscall");
  if (/^cmov/.test(op)) return k("move2", { cond: cond(op.slice(4)) });
  if (op === "neg" || op === "bswap" || op === "sbb" || /^bt[src]?$/.test(op)) return k(op === "sbb" ? "sub" : op.startsWith("bt") ? "testBit" : op);
  if (op === "cld") return k("cld");
  if (op === "rdtsc") return k("rdtsc");
  if (/^set/.test(op)) return k("set", { cond: cond(op.slice(3)) });
  if (/^v?(mov[ua]p|movdq|movs[sd]|p?xor|add[ps]|mul[ps]|sub[ps]|unpck|shuf|por|pand|xorps)/.test(op)) return k("data");
  return k("other", { a: rest });
}

/** A file through every level of code, from what it can do to its bits, and whether anything is wrong with it. */
export function CodeLadder({ p, at, event, all }: { p: Picture; at: number; event: TimelineEvent | null; all: TimelineEvent[] }) {
  const { t } = useTranslation();
  const [i, setI] = useState(0);
  const [step, setStep] = useState<Step>("plain");
  const [symbol, setSymbol] = useState<string | null>(null);
  const [data, setData] = useState<{ code: Code | null; maker: Maker | null; rebuilt: boolean } | null>(null);
  const [there, setThere] = useState<Set<number> | null>(null);
  const part: Part | undefined = p.parts[i];

  // Some pieces of Windows exist only on some computers: those that are not here are not offered.
  useEffect(() => {
    let alive = true;
    setThere(null);
    setI(0);
    Promise.all(p.parts.map((x) => loadMaker(x.path))).then(async (m) => {
      if (!alive) return;
      const here = m.map((x, k) => (x?.exists ? k : -1)).filter((k) => k >= 0);
      setThere(new Set(here));
      // The first one that is still here and may be read is shown at once.
      for (const k of here) {
        const x = p.parts[k];
        if (!(await loadCode(x.path, x.offset, x.stamp, x.symbol).catch(() => null))) continue;
        if (alive && k) setI((now) => now || k);
        break;
      }
    });
    return () => {
      alive = false;
    };
  }, [p]);
  useEffect(() => setSymbol(null), [i, p]);
  useEffect(() => {
    if (!part) return;
    let alive = true;
    setData(null);
    (async () => {
      const [was, maker] = await Promise.all([loadCode(part.path, part.offset, part.stamp, symbol ?? part.symbol).catch(() => null), loadMaker(part.path)]);
      // Updated since the crash: the place no longer means anything, the file as it is now still can be read.
      const rebuilt = was?.same === false;
      const code = rebuilt ? await loadCode(part.path, undefined, undefined, symbol ?? undefined).catch(() => null) : was;
      if (alive) setData({ code, maker, rebuilt });
    })();
    return () => {
      alive = false;
    };
  }, [part, symbol]);

  if (!part) return <p className="text-[0.75rem] text-muted">{t("timeline.lv.noCode")}</p>;
  const c = data?.code ?? null;
  const fault = !!part.offset && !!data && !data.rebuilt;
  const system = ["api", "gate", "kernel", "system"].includes(part.role);
  const dark = "overflow-x-auto rounded-lg border border-line bg-[#0b0f14] p-3 font-mono text-[0.6875rem] leading-[1.75] text-[#c9d6e2]";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3" data-testid="code-view">
      <div>
        <div className="mb-1.5 text-[0.6875rem] text-muted">{t("timeline.code.parts")}</div>
        <div className="flex flex-wrap gap-1.5">
          {p.parts.map((x, k) =>
            there && !there.has(k) && ["api", "gate", "kernel", "system"].includes(x.role) ? null : (
              <button key={k} onClick={() => setI(k)} aria-pressed={i === k} className={`max-w-full rounded-lg border px-2.5 py-1.5 text-left ${i === k ? "border-accent/60 bg-accent/10" : "border-line hover:bg-raised"}`} data-testid="code-part" data-role={x.role}>
                <span className="block truncate text-[0.75rem] font-medium">{nameOf(x.path)}{there && !there.has(k) ? ` · ${t("timeline.code.away")}` : ""}</span>
                <span className="block truncate text-[0.625rem] text-muted">{`${t(`timeline.lv.name.${x.level}`)} · ${t(`timeline.code.role.${x.role}`)}${x.symbol ? ` · ${x.symbol}` : ""}`}</span>
              </button>
            ),
          )}
        </div>
      </div>

      {!data ? (
        <p className="text-[0.75rem] text-muted">{t("timeline.code.loading")}</p>
      ) : !c ? (
        <p className="text-[0.75rem] text-muted">{t(there?.has(i) ? "timeline.code.shut" : "timeline.code.gone")}</p>
      ) : (
        <motion.div key={`${i}${symbol}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid grid-cols-[minmax(0,1fr)] gap-3">
          <div className="flex flex-wrap rounded-lg border border-line p-0.5 text-[0.6875rem]" role="tablist">
            {STEPS.map(([k, Icon]) => (
              <button key={k} role="tab" aria-selected={step === k} onClick={() => setStep(k)} className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 ${step === k ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`code-${k}`}>
                <Icon size={12} />
                {t(`timeline.code.step.${k}`)}
              </button>
            ))}
          </div>

          {step === "does" && (
            <div className="rounded-lg border border-line p-3 text-[0.75rem]">
              {c.abilities.length ? (
                <ul className="flex flex-wrap gap-1.5">
                  {c.abilities.map((x) => (
                    <li key={x} className="rounded-full bg-raised px-2.5 py-1">
                      {t(`timeline.code.can.${x}`)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted">{t("timeline.code.noAbilities")}</p>
              )}
              <p className="mt-2 text-[0.6875rem] text-muted">
                {[c.made.map((m) => t(`timeline.lv.made.${m}`, { defaultValue: m })).join(", "), c.arch, c.linker && `linker ${c.linker}`, data.maker?.company, c.exportCount ? t("timeline.code.exported", { count: c.exportCount }) : ""].filter(Boolean).join(" · ")}
              </p>
            </div>
          )}
          {step === "calls" && (
            <div className={dark}>
              {c.imports.length ? (
                c.imports.slice(0, 14).map((x) => (
                  <div key={x.dll} className="flex gap-3">
                    <span className="w-52 shrink-0 truncate text-[#5fb3d9]" title={x.dll}>
                      {x.dll}
                    </span>
                    <span className="w-10 shrink-0 text-right text-[#6b7a8d]">{x.count}</span>
                    <span className="whitespace-nowrap">{x.names.join("  ")}</span>
                  </div>
                ))
              ) : (
                <span className="text-[#6b7a8d]">{t("timeline.code.noImports")}</span>
              )}
            </div>
          )}
          {(step === "plain" || step === "asm" || step === "bytes" || step === "bits") && (
            <>
              {!c.lines.length && step !== "bytes" && step !== "bits" ? (
                <p className="text-[0.75rem] text-muted">{t("timeline.code.noAsm")}</p>
              ) : (
                <>
                  {data.rebuilt && <p className="text-[0.75rem] text-warn">{t("timeline.code.rebuilt")}</p>}
                  {c.exports.length > 0 && !fault && (
                    <label className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted">
                      {t("timeline.code.func")}
                      <select value={c.symbol ?? ""} onChange={(e) => setSymbol(e.target.value || null)} className="max-w-full rounded-lg border border-line bg-surface px-2 py-1 text-[0.75rem] text-fg" data-testid="code-symbol">
                        {!c.symbol && <option value="">{t("timeline.code.entry")}</option>}
                        {[...new Set([...(c.symbol ? [c.symbol] : []), ...c.exports])].map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <div className={dark}>
                    {step === "bytes" || (step === "bits" && !c.lines.length)
                      ? (c.lines.length ? c.lines.map((l) => [l.at, l.bytes, l.here] as const) : c.hex.map((h, k) => [String(k * 16).padStart(3, "0"), h, false] as const)).map(([a, h, on]) => (
                          <div key={a} className={`flex w-max min-w-full gap-4 rounded px-2 ${on && fault ? "bg-[#e5484d33]" : ""}`}>
                            <span className="w-16 shrink-0 text-right text-[#6b7a8d]">{a}</span>
                            <span className="text-[#5fb3d9]">{h}</span>
                          </div>
                        ))
                      : c.lines.map((l) => (
                          <div key={l.at} className={`flex w-max min-w-full gap-4 rounded px-2 ${l.here && fault ? "bg-[#e5484d33] text-white" : ""}`} data-here={(l.here && fault) || undefined}>
                            <span className="w-16 shrink-0 text-right text-[#6b7a8d]">{l.at}</span>
                            {step === "bits" ? (
                              <span className="text-[#7fa08a]">
                                {l.bytes
                                  .split(" ")
                                  .map((x) => parseInt(x, 16).toString(2).padStart(8, "0"))
                                  .join(" ")}
                              </span>
                            ) : (
                              <>
                                <span className="w-56 shrink-0">{step === "plain" ? <span className="text-[#6b7a8d]">{l.text}</span> : <span className="text-[#5fb3d9]">{l.bytes}</span>}</span>
                                <span>{step === "plain" ? plain(l.text, t) : l.text}</span>
                              </>
                            )}
                            {l.here && fault && <span className="text-[#ff9aa0]">← {t("timeline.lv.here")}</span>}
                          </div>
                        ))}
                  </div>
                </>
              )}
              <p className="text-[0.6875rem] leading-relaxed text-muted">{t(`timeline.code.notes.${fault ? "crash" : system ? "system" : "own"}`)}</p>
            </>
          )}

          <div className="rounded-lg border border-line p-3" data-testid="code-health">
            <div className="mb-1.5 text-[0.6875rem] font-medium">{t("timeline.code.health")}</div>
            <ul className="grid gap-1 sm:grid-cols-2">
              {health(c, data.maker, at, event, all, part.path).map((f, k) => {
                const [Icon, tone] = MARK[f.state ?? "unknown"];
                return (
                  <li key={k} className="flex gap-2 text-[0.6875rem] leading-relaxed" data-state={f.state}>
                    <Icon size={13} className={`mt-[2px] shrink-0 ${tone}`} />
                    <span className="min-w-0 break-words">{t(`timeline.lv.fact.h_${f.key}`, f.v ?? {})}</span>
                  </li>
                );
              })}
            </ul>
            <p className="num mt-2 break-all text-[0.625rem] text-muted">{part.path}</p>
          </div>
        </motion.div>
      )}
    </div>
  );
}
