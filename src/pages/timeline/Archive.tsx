import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Camera, Database, Eraser, GitCompareArrows, Pause, Play, Trash2 } from "lucide-react";
import { Button, Modal } from "../../components/ui";
import { useFmt } from "../../lib/format";
import { LANES, isProblem, laneOf, titleOf, type Row, type Snapshot, type Stats, type TimelineEvent } from "../../lib/timeline";
import { EventRow } from "./Cards";

interface Diff {
  added: Row[];
  removed: Row[];
  changed: [Row, Row][];
}
/** Two exact states, by kind and name. */
function diff(then: Row[], now: Row[]): Diff {
  const key = (r: Row) => `${r[0]}|${r[2]}`;
  const a = new Map(then.map((r) => [key(r), r]));
  const b = new Map(now.filter((r) => r[0] !== "port").map((r) => [key(r), r]));
  return {
    added: [...b].filter(([k]) => !a.has(k)).map(([, r]) => r),
    removed: [...a].filter(([k]) => !b.has(k)).map(([, r]) => r),
    changed: [...a].filter(([k, r]) => b.has(k) && b.get(k)![3] !== r[3]).map(([k, r]) => [r, b.get(k)!]),
  };
}

/** Control states: exact pictures of what was installed, compared with now. */
export function Snapshots({ present, onChange }: { present: Row[]; onChange: () => void }) {
  const { t } = useTranslation();
  const fmt = useFmt();
  const [list, setList] = useState<Snapshot[] | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ id: number; d: Diff } | null>(null);
  const [removing, setRemoving] = useState<Snapshot | null>(null);
  const load = () => invoke<Snapshot[]>("timeline_snapshots").then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
  }, []);
  const look = async (s: Snapshot) => {
    if (open?.id === s.id) return setOpen(null);
    const rows = await invoke<Row[] | null>("timeline_snapshot_get", { id: s.id }).catch(() => null);
    if (rows) setOpen({ id: s.id, d: diff(rows, present) });
  };
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="timeline-snapshots">
      <section className="flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface p-5">
        <p className="min-w-[16rem] flex-1 text-[0.8125rem] leading-relaxed">{t("timeline.snap.lead")}</p>
        <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t("timeline.snap.name")} aria-label={t("timeline.snap.name")} className="w-56 rounded-lg border border-line bg-bg px-3 py-2 text-[0.8125rem]" data-testid="snap-name" />
        <Button
          variant="primary"
          icon={<Camera size={14} />}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await invoke("timeline_snapshot_make", { name }).catch(() => {});
            setName("");
            await load();
            onChange();
            setBusy(false);
          }}
          data-testid="snap-make"
        >
          {t(busy ? "timeline.snap.making" : "timeline.snap.make")}
        </Button>
      </section>
      {list && !list.length && <p className="rounded-card border border-line bg-surface p-6 text-center text-[0.8125rem] text-muted">{t("timeline.snap.empty")}</p>}
      <div className="grid gap-3">
        {list?.map((s) => (
          <section key={s.id} className="rounded-card border border-line bg-surface" data-testid="snap">
            <div className="flex flex-wrap items-center gap-4 p-4">
              <span className={`flex h-10 w-10 items-center justify-center rounded-lg ${s.auto ? "bg-raised text-muted" : "bg-accent/15 text-accent"}`}>
                <Camera size={18} />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="truncate text-[0.875rem] font-medium">{s.name || t(s.auto ? "timeline.snap.auto" : "timeline.snap.manual")}</h3>
                <p className="num text-[0.75rem] text-muted">
                  {fmt.dateTime(s.t)} · {s.counts.map(([k, n]) => `${t(`timeline.rewind.${k}`)}: ${n}`).join(" · ")}
                </p>
              </div>
              <Button icon={<GitCompareArrows size={14} />} onClick={() => look(s)} data-testid="snap-compare">
                {t("timeline.snap.compare")}
              </Button>
              <button onClick={() => setRemoving(s)} aria-label={t("timeline.snap.delete")} title={t("timeline.snap.delete")} className="rounded-md p-2 text-muted hover:bg-raised hover:text-risk">
                <Trash2 size={15} />
              </button>
            </div>
            {open?.id === s.id && (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid gap-4 border-t border-line p-4 text-[0.75rem] md:grid-cols-3" data-testid="snap-diff">
                {(
                  [
                    ["added", open.d.added.map((r) => [r[2], r[3]] as const), "text-safe"],
                    ["removed", open.d.removed.map((r) => [r[2], r[3]] as const), "text-warn"],
                    ["changed", open.d.changed.map(([a, b]) => [a[2], `${a[3] ?? "?"} → ${b[3] ?? "?"}`] as const), "text-accent"],
                  ] as const
                ).map(([k, rows, tone]) => (
                  <div key={k} className="min-w-0">
                    <h4 className={`mb-1 font-medium ${tone}`}>
                      {t(`timeline.snap.${k}`)} <span className="num">{rows.length}</span>
                    </h4>
                    <ul className="max-h-56 space-y-1 overflow-y-auto">
                      {rows.map(([n, v], i) => (
                        <li key={`${n}${i}`} className="flex gap-2">
                          <span className="min-w-0 flex-1 truncate">{n}</span>
                          {v && <span className="num max-w-[55%] truncate text-muted">{v}</span>}
                        </li>
                      ))}
                      {!rows.length && <li className="text-muted">{t("timeline.snap.none")}</li>}
                    </ul>
                  </div>
                ))}
              </motion.div>
            )}
          </section>
        ))}
      </div>
      <Modal open={!!removing} onClose={() => setRemoving(null)}>
        <h2 className="font-display text-[1.0625rem] font-semibold">{t("timeline.snap.deleteTitle")}</h2>
        <p className="mt-2 text-[0.8125rem] text-muted">{t("timeline.snap.deleteText")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setRemoving(null)}>{t("timeline.cancel")}</Button>
          <Button
            variant="danger"
            onClick={async () => {
              await invoke("timeline_snapshot_delete", { id: removing!.id }).catch(() => {});
              setRemoving(null);
              load();
              onChange();
            }}
          >
            {t("timeline.snap.delete")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** The archive itself: the computer's story so far, what is kept and for how long. */
export function Memory({ events, stats, now, onPick, onReload }: { events: TimelineEvent[]; stats: Stats; now: number; onPick: (e: TimelineEvent) => void; onReload: () => void }) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const [erasing, setErasing] = useState(false);
  const locale = i18n.language.startsWith("uk") ? "uk-UA" : "en-US";
  const months = useMemo(() => {
    const out: { key: string; label: string; lanes: Map<string, number>; n: number }[] = [];
    const d = new Date(now * 1000);
    for (let i = 11; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      out.push({ key: `${m.getFullYear()}-${m.getMonth()}`, label: m.toLocaleDateString(locale, { month: "short" }), lanes: new Map(), n: 0 });
    }
    for (const e of events) {
      const m = new Date(e.t * 1000);
      const o = out.find((x) => x.key === `${m.getFullYear()}-${m.getMonth()}`);
      if (!o) continue;
      const l = laneOf(e).id;
      o.lanes.set(l, (o.lanes.get(l) ?? 0) + 1);
      o.n++;
    }
    return out;
  }, [events, now, locale]);
  const top = Math.max(1, ...months.map((m) => m.n));
  const year = events.filter((e) => e.t > now - 365 * 86_400);
  const count = (f: (e: TimelineEvent) => boolean) => year.filter(f).length;
  const worst = useMemo(() => {
    const by = new Map<string, TimelineEvent[]>();
    for (const e of year) if (e.kind === "appcrash") by.set(e.name, [...(by.get(e.name) ?? []), e]);
    return [...by.values()].sort((a, b) => b.length - a.length)[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);
  const big = useMemo(() => {
    const pick: TimelineEvent[] = [];
    if (events[0]) pick.push(events[0]);
    pick.push(...events.filter((e) => e.kind === "update" && /version|верс/i.test(e.name) && /windows 1\d/i.test(e.name)).slice(-2));
    pick.push(...events.filter((e) => e.kind === "crash").slice(-3));
    pick.push(...events.filter((e) => e.kind === "driver" && e.name.includes("|display|")).slice(-2));
    return [...new Map(pick.map((e) => [e.id, e])).values()].sort((a, b) => a.t - b.t);
  }, [events]);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4" data-testid="timeline-memory">
      <section className="overflow-hidden rounded-card border border-line bg-surface p-6" style={{ backgroundImage: "radial-gradient(ellipse at 85% 0%, rgb(76 194 255 / .16), transparent 60%)" }}>
        <p className="font-display text-[1.5rem] font-semibold leading-tight">{t("timeline.memory.slogan1")}</p>
        <p className="font-display text-[1.5rem] font-semibold leading-tight text-accent">{t("timeline.memory.slogan2")}</p>
        <p className="mt-3 max-w-[46rem] text-[0.8125rem] leading-relaxed text-muted">{t("timeline.memory.lead", { date: fmt.date(stats.firstEvent ?? now), count: stats.events })}</p>
        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          {(
            [
              ["programs", new Set(year.filter((e) => e.kind === "program").map((e) => e.name)).size],
              ["drivers", count((e) => e.kind === "driver")],
              ["updates", count((e) => e.kind === "update")],
              ["problems", count(isProblem)],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <div className="num font-display text-[1.75rem] font-semibold leading-none">{v}</div>
              <div className="mt-1 text-[0.75rem] text-muted">{t(`timeline.memory.${k}`)}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-3 text-[0.8125rem] font-medium">{t("timeline.memory.year")}</h3>
          <div className="flex h-40 items-end gap-1.5">
            {months.map((m, i) => (
              <div key={m.key} className="flex h-full flex-1 flex-col justify-end" title={`${m.label}: ${m.n}`}>
                <motion.div className="flex flex-col-reverse overflow-hidden rounded-t-md" initial={{ height: 0 }} animate={{ height: `${(m.n / top) * 85}%` }} transition={{ duration: 0.5, delay: i * 0.03 }}>
                  {LANES.map((l) => (m.lanes.get(l.id) ? <div key={l.id} style={{ flex: m.lanes.get(l.id), background: l.color }} /> : null))}
                </motion.div>
                <div className="mt-1 text-center text-[0.625rem] text-muted">{m.label}</div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[0.6875rem] text-muted">
            {LANES.map((l) => (
              <span key={l.id} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-[2px]" style={{ background: l.color }} />
                {t(`timeline.lane.${l.id}.name`)}
              </span>
            ))}
          </div>
          <p className="mt-3 text-[0.6875rem] leading-relaxed text-muted">{t("timeline.memory.yearNote")}</p>
        </section>
        <section className="rounded-card border border-line bg-surface p-5">
          <h3 className="mb-1 text-[0.8125rem] font-medium">{t("timeline.memory.milestones")}</h3>
          {big.map((e) => (
            <EventRow key={e.id} e={e} onPick={onPick} />
          ))}
          {worst && worst.length > 1 && <p className="mt-2 text-[0.75rem] text-muted">{t("timeline.memory.worst", { name: titleOf(worst[0], t), count: worst.length })}</p>}
        </section>
      </div>

      <section className="rounded-card border border-line bg-surface p-5">
        <h3 className="mb-3 flex items-center gap-2 text-[0.8125rem] font-medium">
          <Database size={15} className="text-accent" />
          {t("timeline.memory.kept")}
        </h3>
        <dl className="grid gap-x-8 gap-y-2 text-[0.8125rem] sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ["size", fmt.bytes(stats.bytes)],
              ["readings", fmt.int(stats.readings)],
              ["snaps", fmt.int(stats.snapshots)],
              ["minute", t("timeline.memory.keep.minute")],
              ["quarter", t("timeline.memory.keep.quarter")],
              ["event", t("timeline.memory.keep.event")],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3 border-b border-line/60 pb-1.5">
              <dt className="text-muted">{t(`timeline.memory.row.${k}`)}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-[0.75rem] leading-relaxed text-muted">{t("timeline.memory.private")}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button icon={stats.paused ? <Play size={14} /> : <Pause size={14} />} onClick={() => invoke("timeline_pause", { on: !stats.paused }).then(onReload)} data-testid="timeline-pause">
            {t(stats.paused ? "timeline.resume" : "timeline.pauseLong")}
          </Button>
          <Button icon={<Eraser size={14} />} onClick={() => setErasing(true)} data-testid="timeline-erase">
            {t("timeline.eraseLong")}
          </Button>
        </div>
      </section>
      <Modal open={erasing} onClose={() => setErasing(false)}>
        <h2 className="font-display text-[1.0625rem] font-semibold">{t("timeline.eraseTitle")}</h2>
        <p className="mt-2 text-[0.8125rem] leading-relaxed text-muted">{t("timeline.eraseText")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setErasing(false)}>{t("timeline.cancel")}</Button>
          <Button
            variant="danger"
            onClick={async () => {
              await invoke("timeline_erase").catch(() => {});
              setErasing(false);
              onReload();
            }}
            data-testid="timeline-erase-yes"
          >
            {t("timeline.eraseYes")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
