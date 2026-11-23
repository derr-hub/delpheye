import { Hero } from "../components/Hero";
import { BadgeCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowRight, Check, CircleAlert, Cpu, Loader2, PackageCheck, RefreshCw, Square } from "lucide-react";
import { Button, Checkbox, Modal } from "../components/ui";
import { cancelUpdates, checkUpdates, installUpdates, useUpdates, type Package, type RowState } from "../lib/updates";

function Intro() {
  const { t } = useTranslation();
  const error = useUpdates((s) => s.error);
  return (
    <Hero
      icon={PackageCheck}
      title={t("updates.introTitle")}
      text={t("updates.introText")}
      features={[
        { icon: BadgeCheck, title: t("hero.updates.f1"), text: t("hero.updates.f1t") },
        { icon: RefreshCw, title: t("hero.updates.f2"), text: t("hero.updates.f2t") },
        { icon: Cpu, title: t("hero.updates.f3"), text: t("hero.updates.f3t") },
      ]}
      action={
        <Button variant="primary" className="!h-11 !px-8 text-[14px]" onClick={checkUpdates} data-testid="updates-check">
          {t("updates.check")}
        </Button>
      }
      error={
        error && (
          <p className="text-[12px] text-risk" role="alert">
            {error === "no-winget" ? t("updates.noWinget") : t("updates.error", { message: error })}
          </p>
        )
      }
    />
  );
}

function Loading() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <Loader2 size={36} className="animate-spin text-accent" />
      <div className="mt-5 font-display text-[18px] font-semibold">{t("updates.loading")}</div>
      <div className="mt-1 max-w-[46ch] text-[13px] text-muted">{t("updates.loadingHint")}</div>
    </div>
  );
}

function Status({ row }: { row: RowState | undefined }) {
  const { t } = useTranslation();
  if (!row) return null;
  if (row.state === "running")
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-accent">
        <Loader2 size={13} className="animate-spin" />
        {t("updates.running")}
      </span>
    );
  if (row.state === "done")
    return (
      <span className="flex items-center gap-1.5 text-[12px] text-safe">
        <Check size={13} />
        {t("updates.done")}
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-[12px] text-warn" title={`0x${(row.code >>> 0).toString(16).toUpperCase()}`}>
      <CircleAlert size={13} />
      {t(`updates.reason.${row.reason}`)}
    </span>
  );
}

function Row({ pkg, chosen, toggle, busy }: { pkg: Package; chosen: boolean; toggle: () => void; busy: boolean }) {
  const { t } = useTranslation();
  const row = useUpdates((s) => s.rows[pkg.id]);
  const finished = row?.state === "done";
  return (
    <li className="flex items-center gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0" data-testid="update-row">
      <Checkbox state={chosen && !finished} onChange={toggle} disabled={busy || finished} label={pkg.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px]">{pkg.name}</div>
        <div className="num flex items-center gap-1.5 text-[11px] text-muted">
          <span>{pkg.version === "Unknown" ? t("updates.unknownVersion") : pkg.version}</span>
          <ArrowRight size={11} className="nudge" />
          <span className="text-fg">{pkg.available}</span>
          {pkg.explicit && <span className="ml-1 rounded bg-raised px-1.5 text-[10px]">{t("updates.explicit")}</span>}
        </div>
      </div>
      <div className="shrink-0">
        <Status row={row} />
      </div>
      {!row && (
        <Button variant="quiet" className="!h-8 !px-3 text-[12px]" disabled={busy} onClick={() => installUpdates([pkg.id])} data-testid="update-one">
          {t("updates.updateOne")}
        </Button>
      )}
    </li>
  );
}

function List() {
  const { t } = useTranslation();
  const { list, phase, rows, checkedAt } = useUpdates();
  const busy = phase === "installing";
  // Everything is chosen at first, except programs winget wants named explicitly.
  const [off, setOff] = useState<Set<string>>(() => new Set(list.filter((p) => p.explicit).map((p) => p.id)));
  const [confirm, setConfirm] = useState<string[] | null>(null);
  const pending = useMemo(() => list.filter((p) => rows[p.id]?.state !== "done"), [list, rows]);
  const chosen = pending.filter((p) => !off.has(p.id)).map((p) => p.id);
  const allState = chosen.length === 0 ? false : chosen.length === pending.length ? true : "mixed";
  const done = list.filter((p) => rows[p.id]?.state === "done").length;
  const failed = list.filter((p) => rows[p.id]?.state === "failed").length;

  const toggle = (id: string) =>
    setOff((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (list.length === 0)
    return (
      <div className="flex h-full flex-col items-center justify-center text-center" data-testid="updates-none">
        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-safe/10 text-safe">
          <Check size={38} />
        </div>
        <h2 className="font-display text-[22px] font-semibold">{t("updates.noneTitle")}</h2>
        <p className="mt-1 text-[13px] text-muted">{t("updates.noneText")}</p>
        <Button className="mt-6" icon={<RefreshCw size={15} />} onClick={checkUpdates}>
          {t("updates.recheck")}
        </Button>
      </div>
    );

  return (
    <div className="mx-auto max-w-[820px] pb-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-[18px] font-semibold">{t("updates.found", { count: list.length })}</h2>
          <p className="text-[12px] text-muted">
            {done > 0 || failed > 0
              ? t("updates.progress", { done, failed })
              : checkedAt && t("updates.checkedAt", { time: new Date(checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}
          </p>
        </div>
        {busy ? (
          <Button icon={<Square size={13} />} onClick={cancelUpdates} data-testid="updates-cancel">
            {t("updates.stop")}
          </Button>
        ) : (
          <>
            <Button variant="quiet" icon={<RefreshCw size={15} />} onClick={checkUpdates}>
              {t("updates.recheck")}
            </Button>
            <Button variant="primary" disabled={chosen.length === 0} onClick={() => setConfirm(chosen)} data-testid="updates-all">
              {chosen.length === pending.length ? t("updates.updateAll") : t("updates.updateChosen", { count: chosen.length })}
            </Button>
          </>
        )}
      </div>

      <div className="overflow-clip rounded-card border border-line bg-surface">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-[11px] text-muted">
          <Checkbox
            state={allState}
            disabled={busy || pending.length === 0}
            label={t("updates.selectAll")}
            onChange={() => setOff(allState === true ? new Set(pending.map((p) => p.id)) : new Set())}
          />
          {t("updates.selectAll")}
        </div>
        <ul>
          {list.map((p) => (
            <Row key={p.id} pkg={p} chosen={!off.has(p.id)} toggle={() => toggle(p.id)} busy={busy} />
          ))}
        </ul>
      </div>

      <div className="mt-4 grid gap-3 text-[12px] leading-relaxed text-muted sm:grid-cols-2">
        <p className="rounded-card border border-line bg-surface px-4 py-3">{t("updates.howItWorks")}</p>
        <div className="rounded-card border border-line bg-surface px-4 py-3">
          <div className="mb-1 flex items-center gap-1.5 text-fg">
            <Cpu size={13} className="text-accent" />
            {t("updates.driversTitle")}
          </div>
          {t("updates.driversText")}
          <button
            className="mt-1 block text-accent hover:underline"
            onClick={() => openUrl("ms-settings:windowsupdate-optionalupdates").catch(console.error)}
          >
            {t("updates.driversOpen")}
          </button>
        </div>
      </div>

      <Modal open={confirm !== null} onClose={() => setConfirm(null)}>
        <h2 className="font-display text-[18px] font-semibold">{t("updates.confirmTitle", { count: confirm?.length ?? 0 })}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("updates.confirmText")}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="quiet" onClick={() => setConfirm(null)}>
            {t("updates.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="updates-confirm"
            onClick={() => {
              const ids = confirm ?? [];
              setConfirm(null);
              installUpdates(ids);
            }}
          >
            {t("updates.confirm")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function Updates() {
  const phase = useUpdates((s) => s.phase);
  const view = phase === "installing" ? "list" : phase;
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={view} className="h-full" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}>
        {view === "idle" && <Intro />}
        {view === "loading" && <Loading />}
        {view === "list" && <List />}
      </motion.div>
    </AnimatePresence>
  );
}
