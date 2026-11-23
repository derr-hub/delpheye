import { Hero } from "../components/Hero";
import { Bug, ShieldHalf, Puzzle, HardDriveDownload, Router, KeyRound, Fingerprint, Eye, EyeOff, Loader2, Copy, Check, ArrowRight, Wifi } from "lucide-react";
import { lazy, Suspense, useMemo, useState, type CSSProperties, type ReactNode } from "react";

const Shield3D = lazy(() => import("./security/Shield3D"));
import { invoke } from "@tauri-apps/api/core";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArchiveRestore,
  CheckCircle2,
  ChevronDown,
  FolderOpen,
  Globe,
  HelpCircle,
  Info,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Square,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Button, Modal, Ring, Switch } from "../components/ui";
import { go, relaunchElevated } from "../lib/app";
import {
  SECTIONS,
  act,
  checkPassword,
  sectionScores,
  shieldScore,
  type Extension,
  type OpenPort,
  type PasswordCheck,
  type Section,
  checkReputation,
  scan,
  setReputationOn,
  useSecurity,
  type Action,
  type Area,
  type Finding,
  type HardeningTest,
  type Reputation,
  type Severity,
} from "../lib/security";

const SEVERITY_TONE: Record<Severity, string> = {
  high: "bg-risk/10 text-risk",
  medium: "bg-warn/10 text-warn",
  low: "bg-accent/10 text-accent",
  info: "bg-raised text-muted",
};
const OUTCOME_ICON: Record<HardeningTest["outcome"], LucideIcon> = { pass: CheckCircle2, fail: XCircle, unknown: HelpCircle };
const OUTCOME_TONE: Record<HardeningTest["outcome"], string> = { pass: "text-safe", fail: "text-risk", unknown: "text-muted" };

export function SeverityBadge({ severity }: { severity: Severity }) {
  const { t } = useTranslation();
  return <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] ${SEVERITY_TONE[severity]}`}>{t(`security.severity.${severity}`)}</span>;
}

function ReputationBadge({ value }: { value: Reputation | "pending" }) {
  const { t } = useTranslation();
  if (value === "pending") return <span className="text-[11px] text-muted">{t("security.rep.pending")}</span>;
  const tone = value.verdict === "malicious" ? "bg-risk/10 text-risk" : value.verdict === "known" ? "bg-safe/10 text-safe" : "bg-raised text-muted";
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] ${tone}`} data-testid="rep-badge">
      {t(`security.rep.${value.verdict}`, { pct: value.detectionPct ?? 0, source: value.maliciousSource ?? "" })}
    </span>
  );
}

/** Actions that change something are confirmed first; the confirmation says what will happen. */
function ActionButton({ finding, action, label, icon }: { finding: Finding; action: Action; label: string; icon: ReactNode }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Button icon={icon} onClick={() => setConfirming(true)} data-testid={`act-${action}`}>
        {label}
      </Button>
      <Modal open={confirming} onClose={() => setConfirming(false)}>
        <h2 className="font-display text-[18px] font-semibold">{label}?</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t(`security.confirm.${action}`, { name: finding.title })}</p>
        <p className="num mt-3 break-all rounded-lg border border-line bg-bg/50 px-3 py-2 text-[11px]">{finding.file ?? finding.key ?? finding.detail}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirming(false)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="danger"
            data-testid="act-confirm"
            onClick={() => {
              setConfirming(false);
              act(finding, action);
            }}
          >
            {label}
          </Button>
        </div>
      </Modal>
    </>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { reputationOn, reputation, acted } = useSecurity();
  const rep = finding.file ? reputation[finding.file] : undefined;
  const result = acted[finding.id];
  const reason = finding.reason ? t(`security.reason.${finding.reason}`, { defaultValue: "" }) : "";

  return (
    <div className="border-b border-line last:border-b-0" data-testid={`finding-${finding.kind}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setOpen(!open)}
        className="flex cursor-pointer items-center gap-3.5 px-5 py-3 transition-colors duration-150 hover:bg-raised/40"
      >
        <SeverityBadge severity={finding.severity} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-medium">{finding.title}</div>
          <div className="truncate text-[12px] text-muted">{t(`security.kind.${finding.kind}.title`)}</div>
        </div>
        {rep && <ReputationBadge value={rep} />}
        {result && (
          <span className={`text-[11px] ${result.done ? "text-safe" : "text-risk"}`}>
            {result.done ? t(`security.done.${result.action}`) : t(`security.fail.${result.reason}`, { defaultValue: t("security.fail.failed") })}
          </span>
        )}
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ duration: 0.2 }} className="shrink-0 text-muted">
          <ChevronDown size={16} />
        </motion.span>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="space-y-3 border-t border-line/60 bg-bg/40 px-5 py-4 text-[12px]">
              <p className="max-w-[85ch] leading-relaxed">{t(`security.kind.${finding.kind}.why`)}</p>
              {reason && <p className="max-w-[85ch] leading-relaxed text-muted">{reason}</p>}
              <dl className="grid grid-cols-[120px_1fr] gap-x-4 gap-y-1.5">
                <dt className="text-muted">{t("security.evidence")}</dt>
                <dd className="num select-text break-all text-[11px]">{finding.detail || "—"}</dd>
                <dt className="text-muted">{t("security.where")}</dt>
                <dd className="num select-text break-all text-[11px]">{finding.location}</dd>
              </dl>
              <p className="text-muted">{t(`security.kind.${finding.kind}.todo`)}</p>
              {rep && rep !== "pending" && rep.hashes && (
                <p className="num break-all text-[11px] text-muted">SHA-256 {rep.hashes.sha256}</p>
              )}
              <div className="flex flex-wrap gap-2">
                {finding.file && (
                  <Button icon={<FolderOpen size={14} />} onClick={() => revealItemInDir(finding.file!).catch(console.error)}>
                    {t("disk.reveal")}
                  </Button>
                )}
                {finding.file && reputationOn && !rep && (
                  <Button icon={<Globe size={14} />} onClick={() => checkReputation([finding.file!])} data-testid="check-rep">
                    {t("security.checkRep")}
                  </Button>
                )}
                {!result?.doneActions.includes("quarantine-file") && finding.file && finding.area !== "tamper" && (
                  <ActionButton finding={finding} action="quarantine-file" label={t("security.action.quarantine-file")} icon={<ArchiveRestore size={14} />} />
                )}
                {!result?.doneActions.includes("quarantine-key") && finding.key && (
                  <ActionButton finding={finding} action="quarantine-key" label={t("security.action.quarantine-key")} icon={<ArchiveRestore size={14} />} />
                )}
                {!result?.doneActions.includes("end-process") && finding.pid !== null && (
                  <ActionButton finding={finding} action="end-process" label={t("security.action.end-process")} icon={<Square size={14} />} />
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AreaSection({ area, findings }: { area: Area; findings: Finding[] }) {
  const { t } = useTranslation();
  const [showInfo, setShowInfo] = useState(false);
  const important = findings.filter((f) => f.severity !== "info");
  const info = findings.filter((f) => f.severity === "info");
  return (
    <section data-testid={`area-${area}`}>
      <h2 className="mb-2 flex items-baseline justify-between px-1 text-[11px] uppercase tracking-wider text-muted">
        {t(`security.area.${area}`)}
        <span className="normal-case tracking-normal">{important.length ? t("security.count", { count: important.length }) : t("security.clean")}</span>
      </h2>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {important.length === 0 && (
          <div className="flex items-start gap-3 px-5 py-3.5 text-[12px] text-muted">
            <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-safe" />
            <span className="leading-relaxed">{t(`security.checked.${area}`)}</span>
          </div>
        )}
        {important.map((f) => (
          <FindingRow key={f.id} finding={f} />
        ))}
        {info.length > 0 && (
          <>
            <button className="flex w-full items-center gap-2 border-t border-line/60 px-5 py-2.5 text-left text-[12px] text-muted hover:text-fg" onClick={() => setShowInfo(!showInfo)}>
              <Info size={14} />
              {t(showInfo ? "security.hideInfo" : "security.showInfo", { count: info.length })}
            </button>
            {showInfo && info.map((f) => <FindingRow key={f.id} finding={f} />)}
          </>
        )}
      </div>
    </section>
  );
}

function ReputationCard() {
  const { t } = useTranslation();
  const { reputationOn, report, reputation } = useSecurity();
  const [confirming, setConfirming] = useState(false);
  const files = [...new Set(report?.findings.filter((f) => f.file && f.severity !== "info" && !reputation[f.file]).map((f) => f.file!) ?? [])];
  return (
    <div className="flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-3.5">
      <Globe size={18} className="shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{t("security.repTitle")}</div>
        <p className="text-[12px] leading-relaxed text-muted">{t("security.repText")}</p>
      </div>
      {reputationOn && files.length > 0 && (
        <Button onClick={() => checkReputation(files)} data-testid="check-rep-all">
          {t("security.checkRepAll", { count: files.length })}
        </Button>
      )}
      <Switch on={reputationOn} onChange={() => (reputationOn ? setReputationOn(false) : setConfirming(true))} label={t("security.repTitle")} />
      <Modal open={confirming} onClose={() => setConfirming(false)}>
        <h2 className="font-display text-[18px] font-semibold">{t("security.repConfirmTitle")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{t("security.repConfirmText")}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button autoFocus onClick={() => setConfirming(false)}>
            {t("cleanup.cancel")}
          </Button>
          <Button
            variant="primary"
            data-testid="rep-enable"
            onClick={() => {
              setConfirming(false);
              setReputationOn(true);
            }}
          >
            {t("security.repEnable")}
          </Button>
        </div>
      </Modal>
    </div>
  );
}

const toneOf = (score: number) => (score >= 85 ? "var(--color-safe)" : score >= 60 ? "var(--color-warn)" : "var(--color-risk)");

/** A list of yes/no checks (Windows' defences, backups), each opening into why it matters. */
function TestList({ tests, group }: { tests: HardeningTest[]; group: "test" | "backup" }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState<string | null>(null);
  const sorted = [...tests].sort((a, b) => ["fail", "unknown", "pass"].indexOf(a.outcome) - ["fail", "unknown", "pass"].indexOf(b.outcome) || b.weight - a.weight);
  const base = group === "test" ? "security.test" : "security.backup";
  return (
    <ul className="overflow-hidden rounded-card border border-line bg-surface">
      {sorted.map((test) => {
        const Icon = OUTCOME_ICON[test.outcome];
        const isOpen = open === test.id;
        const detail =
          test.detail === "other-av"
            ? t("security.backup.otherAv")
            : test.detail === "cloud-enough"
              ? t("security.backup.cloudEnough")
              : test.id === "cloud-folders" && test.detail
                ? test.detail.split(", ").map((f) => t(`security.backup.folder.${f}`, { defaultValue: f })).join(", ")
                : test.detail;
        return (
          <li key={test.id} className="border-b border-line last:border-b-0" data-testid={`test-${test.id}`}>
            <button className="flex w-full items-start gap-3.5 px-5 py-3 text-left transition-colors hover:bg-raised/40" onClick={() => setOpen(isOpen ? null : test.id)} aria-expanded={isOpen}>
              <Icon size={18} className={`mt-0.5 shrink-0 ${OUTCOME_TONE[test.outcome]}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[14px] font-medium">
                  {t(`${base}.${test.id}.name`)}
                  {detail && <span className="truncate text-[12px] font-normal text-muted">{detail}</span>}
                </div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{t(`${base}.${test.id}.${test.outcome}`, { defaultValue: t(`security.outcome.${test.outcome}`) })}</p>
              </div>
              <motion.span animate={{ rotate: isOpen ? 180 : 0 }} className="mt-1 shrink-0 text-muted">
                <ChevronDown size={16} />
              </motion.span>
            </button>
            <AnimatePresence initial={false}>
              {isOpen && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                  <div className="grid gap-3 border-t border-line/60 bg-bg/40 px-5 py-4 text-[12px] leading-relaxed md:grid-cols-2">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{t("security.whyTitle")}</div>
                      {t(`${base}.${test.id}.why`)}
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted">{t("security.howTitle")}</div>
                      {t(`${base}.${test.id}.how`)}
                      {test.fix && test.outcome !== "pass" && (
                        <div className="mt-3">
                          <Button onClick={() => openUrl(test.fix!).catch(console.error)}>{t("security.openSettings")}</Button>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </li>
        );
      })}
    </ul>
  );
}

const BROWSER_NAMES: Record<Extension["browser"], string> = { chrome: "Chrome", edge: "Edge", brave: "Brave", vivaldi: "Vivaldi", opera: "Opera", firefox: "Firefox" };
const RISK_TONE = { high: "bg-risk/10 text-risk", medium: "bg-warn/10 text-warn", low: "bg-safe/10 text-safe" } as const;

function ExtensionRow({ e }: { e: Extension }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const page = e.browser === "firefox" ? "about:addons" : `${e.browser === "edge" ? "edge" : e.browser === "brave" ? "brave" : e.browser === "opera" ? "opera" : e.browser === "vivaldi" ? "vivaldi" : "chrome"}://extensions/?id=${e.id}`;
  return (
    <li className={`border-b border-line last:border-b-0 ${e.enabled === false ? "opacity-60" : ""}`} data-testid="extension">
      <button className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-raised/40" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] ${RISK_TONE[e.risk]}`}>{t(`security.ext.risk.${e.risk}`)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 truncate text-[14px] font-medium">
            {e.name}
            {e.known && <span className="rounded bg-safe/10 px-1.5 py-0.5 text-[10px] font-normal text-safe">{t("security.ext.known")}</span>}
            {e.enabled === false && <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] font-normal text-muted">{t("security.ext.off")}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted">
            <span>
              {BROWSER_NAMES[e.browser]} · {e.profile}
            </span>
            {e.allSites && <span className="rounded bg-warn/10 px-1.5 text-warn">{t("security.ext.allSites")}</span>}
            {e.powers.slice(0, 4).map((p) => (
              <span key={p} className="rounded bg-raised px-1.5">
                {t(`security.ext.power.${p}.name`, { defaultValue: p })}
              </span>
            ))}
            {!e.fromStore && <span className="rounded bg-risk/10 px-1.5 text-risk">{e.unpacked ? t("security.ext.unpacked") : t("security.ext.notStore")}</span>}
          </div>
        </div>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="shrink-0 text-muted">
          <ChevronDown size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="space-y-3 border-t border-line/60 bg-bg/40 px-5 py-4 text-[12px] leading-relaxed">
              <p>{t(`security.ext.riskText.${e.risk}`)}</p>
              <ul className="grid gap-1.5">
                {e.allSites && (
                  <li className="flex gap-2">
                    <Globe size={14} className="mt-0.5 shrink-0 text-warn" />
                    {t("security.ext.allSitesText")}
                  </li>
                )}
                {e.powers.map((p) => (
                  <li key={p} className="flex gap-2">
                    <Fingerprint size={14} className="mt-0.5 shrink-0 text-accent" />
                    <span>
                      <b className="font-medium">{t(`security.ext.power.${p}.name`, { defaultValue: p })}</b> — {t(`security.ext.power.${p}.text`, { defaultValue: "" })}
                    </span>
                  </li>
                ))}
                {!e.fromStore && (
                  <li className="flex gap-2">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0 text-risk" />
                    {e.unpacked ? t("security.ext.unpackedText") : t("security.ext.notStoreText")}
                  </li>
                )}
              </ul>
              <p className="text-muted">{t("security.ext.how")}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  icon={copied ? <Check size={14} /> : <Copy size={14} />}
                  onClick={() => {
                    navigator.clipboard.writeText(page);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {t("security.ext.copy")}
                </Button>
                <span className="num select-text text-[11px] text-muted">{page}</span>
                {e.path && (
                  <Button icon={<FolderOpen size={14} />} onClick={() => revealItemInDir(e.path).catch(console.error)}>
                    {t("disk.reveal")}
                  </Button>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

function BrowserSection({ list }: { list: Extension[] }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const shown = all ? list : list.filter((e) => e.risk !== "low");
  if (!list.length) return <Empty text={t("security.ext.none")} />;
  return (
    <div className="space-y-2">
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {shown.map((e) => (
          <ExtensionRow key={`${e.browser}-${e.profile}-${e.id}`} e={e} />
        ))}
        {!shown.length && (
          <li className="flex items-center gap-3 px-5 py-3.5 text-[12px] text-muted">
            <CheckCircle2 size={16} className="text-safe" />
            {t("security.ext.allLow")}
          </li>
        )}
      </ul>
      {list.length > shown.length || all ? (
        <button className="px-1 text-[12px] text-accent hover:underline" onClick={() => setAll(!all)}>
          {all ? t("security.ext.hideLow") : t("security.ext.showAll", { count: list.length })}
        </button>
      ) : null}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-line bg-surface px-5 py-3.5 text-[12px] text-muted">
      <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-safe" />
      <span className="leading-relaxed">{text}</span>
    </div>
  );
}

function NetworkSection({ open, publicNets }: { open: OpenPort[]; publicNets: string[] }) {
  const { t } = useTranslation();
  const [show, setShow] = useState<number | null>(null);
  return (
    <div className="space-y-3">
      {publicNets.length > 0 && (
        <div className="flex items-start gap-3 rounded-card border border-warn/30 bg-warn/[0.06] px-5 py-3 text-[12px] leading-relaxed">
          <Wifi size={16} className="mt-0.5 shrink-0 text-warn" />
          <span>{t("security.net.public", { names: publicNets.join(", ") })}</span>
        </div>
      )}
      {open.length === 0 ? (
        <Empty text={t("security.net.none")} />
      ) : (
        <ul className="overflow-hidden rounded-card border border-line bg-surface">
          {open.map((o) => (
            <li key={o.port} className="border-b border-line last:border-b-0" data-testid="open-port">
              <button className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-raised/40" onClick={() => setShow(show === o.port ? null : o.port)}>
                <span className={`inline-flex shrink-0 rounded-full px-2 py-0.5 text-[11px] ${RISK_TONE[o.risk]}`}>{t(`security.net.risk.${o.risk}`)}</span>
                <span className="num w-20 shrink-0 truncate text-[13px] font-medium" title={o.ports.join(", ")}>
                  :{o.port}
                  {o.ports.length > 1 && <span className="text-[11px] font-normal text-muted"> +{o.ports.length - 1}</span>}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px]">{o.service ? t(`security.net.svc.${o.service}.name`) : o.name}</div>
                  <div className="truncate text-[11px] text-muted">
                    {o.name}
                    {o.windows ? ` · ${t("security.net.windows")}` : ""}
                  </div>
                </div>
                <ChevronDown size={16} className={`shrink-0 text-muted transition-transform ${show === o.port ? "rotate-180" : ""}`} />
              </button>
              {show === o.port && (
                <div className="space-y-2 border-t border-line/60 bg-bg/40 px-5 py-3 text-[12px] leading-relaxed">
                  <p>{o.service ? t(`security.net.svc.${o.service}.text`) : o.windows ? t("security.net.windowsText") : t("security.net.unknownText", { name: o.name })}</p>
                  {o.ports.length > 1 && <p className="num text-[11px] text-muted">{t("security.net.ports", { list: o.ports.join(", ") })}</p>}
                  {o.exe && <p className="num break-all text-[11px] text-muted">{o.exe}</p>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="px-1 text-[11px] leading-relaxed text-muted">{t("security.net.hint")}</p>
    </div>
  );
}

const STRENGTH_TONE = ["bg-risk", "bg-risk", "bg-warn", "bg-safe", "bg-safe"];

function PasswordsSection() {
  const { t } = useTranslation();
  const [pw, setPw] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(PasswordCheck & { label: string }) | null>(null);
  const run = async (password: string, label: string) => {
    setBusy(true);
    try {
      setResult({ ...(await checkPassword(password)), label });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]">
      <div className="rounded-card border border-line bg-surface p-5">
        <h3 className="flex items-center gap-2 text-[14px] font-medium">
          <KeyRound size={16} className="text-accent" />
          {t("security.pw.title")}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-muted">{t("security.pw.lead")}</p>
        <form
          className="mt-4 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pw) run(pw, t("security.pw.yours")).then(() => setPw(""));
          }}
        >
          <span className="relative flex-1">
            <input
              type={show ? "text" : "password"}
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              autoComplete="off"
              placeholder={t("security.pw.placeholder")}
              className="h-10 w-full rounded-lg border border-line bg-bg px-3 pr-9 text-[13px] outline-none focus:border-accent"
              data-testid="pw-input"
            />
            <button type="button" onClick={() => setShow(!show)} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-fg" aria-label={t("router.showPassword")}>
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </span>
          <Button type="submit" variant="primary" disabled={!pw || busy} icon={busy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />} data-testid="pw-check">
            {t("security.pw.check")}
          </Button>
        </form>
        <button
          className="mt-3 flex items-center gap-1.5 text-[12px] text-accent hover:underline disabled:opacity-50"
          disabled={busy}
          onClick={async () => {
            try {
              const share = await invoke<{ password: string; ssid: string }>("wifi_share");
              await run(share.password, t("security.pw.wifi", { ssid: share.ssid }));
            } catch {
              /* not on Wi-Fi */
            }
          }}
        >
          <Wifi size={13} />
          {t("security.pw.checkWifi")}
        </button>
        {result && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-xl border border-line bg-bg/40 p-4" data-testid="pw-result">
            <div className="text-[11px] text-muted">{result.label}</div>
            <div className={`mt-1 text-[15px] font-semibold ${result.leaked ? "text-risk" : result.leaked === 0 ? "text-safe" : "text-muted"}`}>
              {result.leaked === null ? t("security.pw.offline") : result.leaked ? t("security.pw.leaked", { count: result.leaked }) : t("security.pw.clean")}
            </div>
            <div className="mt-3 flex items-center gap-2 text-[12px]">
              <span className="text-muted">{t("security.pw.strength")}</span>
              <div className="flex flex-1 gap-1">
                {[0, 1, 2, 3].map((k) => (
                  <span key={k} className={`h-1.5 flex-1 rounded-full ${k < result.strength ? STRENGTH_TONE[result.strength] : "bg-raised"}`} />
                ))}
              </div>
              <span>{t(`security.pw.level.${result.strength}`)}</span>
            </div>
            {result.weak.length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-[12px] text-muted">
                {result.weak.map((w) => (
                  <li key={w}>{t(`security.pw.weak.${w}`)}</li>
                ))}
              </ul>
            )}
          </motion.div>
        )}
      </div>
      <div className="grid content-start gap-3 text-[12px] leading-relaxed">
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="mb-1 flex items-center gap-1.5 text-[13px] font-medium">
            <ShieldCheck size={14} className="text-safe" />
            {t("security.pw.privacyTitle")}
          </div>
          <p className="text-muted">{t("security.pw.privacy")}</p>
        </div>
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="mb-1 text-[13px] font-medium">{t("security.pw.tipsTitle")}</div>
          <p className="text-muted">{t("security.pw.tips")}</p>
        </div>
      </div>
    </div>
  );
}

const SECTION_ICON: Record<Section, LucideIcon> = {
  threats: Bug,
  tamper: ShieldHalf,
  windows: ShieldCheck,
  browser: Puzzle,
  backup: HardDriveDownload,
  network: Router,
  passwords: KeyRound,
};

function sectionIssues(r: NonNullable<ReturnType<typeof useSecurity.getState>["report"]>, s: Section): number {
  switch (s) {
    case "threats":
      return r.findings.filter((f) => f.area !== "tamper" && f.severity !== "info").length;
    case "tamper":
      return r.findings.filter((f) => f.area === "tamper" && f.severity !== "info").length;
    case "windows":
      return r.hardening.tests.filter((x) => x.outcome === "fail").length;
    case "browser":
      return r.extensions.filter((e) => e.risk === "high" && e.enabled !== false).length;
    case "backup":
      return r.backup.tests.filter((x) => x.outcome === "fail").length;
    case "network":
      return r.exposure.open.filter((o) => o.risk === "high" || (o.risk === "medium" && !o.windows)).length;
    default:
      return 0;
  }
}

/** The shield: one score over all sections, and what to look at first. */
function Shield() {
  const { t } = useTranslation();
  const report = useSecurity((s) => s.report)!;
  const score = shieldScore(report);
  const high = report.findings.filter((f) => f.severity === "high").length;
  const key = high ? "security.shield.bad" : score >= 85 ? "security.shield.good" : score >= 60 ? "security.shield.fair" : "security.shield.poor";
  const color = high ? "var(--color-risk)" : toneOf(score);
  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-surface px-6 py-5">
      <div className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full blur-3xl" style={{ background: color, opacity: 0.12 }} />
      <div className="relative flex flex-wrap items-center gap-6">
        <Ring value={score} color={color} size={124} stroke={9}>
          <span className="font-display text-[34px] font-semibold leading-none" data-testid="shield-score">
            {score}
          </span>
          <span className="text-[11px] text-muted">/ 100</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] uppercase tracking-wider text-muted">{t("security.shield.label")}</div>
          <div className="font-display text-[24px] font-semibold" style={{ color }} data-testid="security-verdict">
            {t(key)}
          </div>
          <p className="mt-1 max-w-[70ch] text-[12px] leading-relaxed text-muted">
            {t("security.summary", { high, medium: report.findings.filter((f) => f.severity === "medium").length, low: report.findings.filter((f) => f.severity === "low").length, seconds: (report.durationMs / 1000).toFixed(1) })}
          </p>
        </div>
        <Button icon={<RefreshCw size={15} />} onClick={scan} data-testid="security-rescan">
          {t("security.rescan")}
        </Button>
      </div>
    </div>
  );
}

function SectionCards({ active, onPick }: { active: Section; onPick: (s: Section) => void }) {
  const { t } = useTranslation();
  const report = useSecurity((s) => s.report)!;
  const scores = sectionScores(report);
  return (
    <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4 xl:grid-cols-7">
      {SECTIONS.map((s) => {
        const Icon = SECTION_ICON[s];
        const score = s === "passwords" ? null : scores[s];
        const issues = sectionIssues(report, s);
        const on = active === s;
        const color = score === null ? "var(--color-accent)" : toneOf(score);
        return (
          <button
            key={s}
            onClick={() => onPick(s)}
            data-testid={`section-${s}`}
            aria-pressed={on}
            className={`reveal relative flex flex-col gap-2 rounded-card border p-3.5 text-left transition-colors ${on ? "border-accent/60 bg-accent/[0.07]" : "border-line bg-surface hover:bg-raised/40"}`}
          >
            <div className="flex items-center justify-between">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>
                <Icon size={16} />
              </span>
              {score !== null && (
                <span className="num text-[13px] font-semibold" style={{ color }}>
                  {score}
                </span>
              )}
            </div>
            <div className="text-[13px] font-medium leading-tight">{t(`security.section.${s}.title`)}</div>
            <div className="text-[11px] leading-snug text-muted">
              {s === "passwords" ? t("security.section.passwords.status") : issues ? t("security.section.issues", { count: issues }) : t("security.section.ok")}
            </div>
            {score !== null && (
              <div className="mt-auto h-1 overflow-hidden rounded-full bg-raised">
                <motion.div className="h-full rounded-full" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${score}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

const VIEW_KEY = "security.view";
const loadView = (): "3d" | "cards" => {
  try {
    return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "3d";
  } catch {
    return "3d";
  }
};

export function Security() {
  const { t } = useTranslation();
  const { phase, report, tab, error } = useSecurity();
  const [declined, setDeclined] = useState(false);
  const [view, setViewState] = useState<"3d" | "cards">(loadView);
  const setView = (v: "3d" | "cards") => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      /* this session only */
    }
  };
  // In 3D, nothing is open until a piece of the shield is chosen.
  const [zoom, setZoom] = useState<Section | null>(null);
  // The section to show first: the weakest one.
  const worst = useMemo<Section>(() => {
    if (!report) return "threats";
    const sc = sectionScores(report);
    return (Object.entries(sc) as [Section, number][]).sort((a, b) => a[1] - b[1])[0][0];
  }, [report]);
  const active = tab ?? worst;

  if (phase === "scanning") {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center">
        <motion.div className="h-20 w-20 rounded-full border-[5px] border-raised border-t-accent" animate={{ rotate: 360 }} transition={{ duration: 1.1, repeat: Infinity, ease: "linear" }} />
        <div className="mt-6 font-display text-[18px] font-semibold">{t("security.scanning")}</div>
        <p className="mt-1 text-[12px] text-muted">{t("security.scanningHint")}</p>
      </div>
    );
  }
  if (!report) {
    return (
      <Hero
        icon={ShieldCheck}
        title={t("security.introTitle")}
        text={t("security.introText")}
        features={[
          { icon: Bug, title: t("hero.security.f1"), text: t("hero.security.f1t") },
          { icon: Puzzle, title: t("hero.security.f4"), text: t("hero.security.f4t") },
          { icon: HardDriveDownload, title: t("hero.security.f5"), text: t("hero.security.f5t") },
        ]}
        action={
          <Button variant="primary" className="!h-11 !px-8 text-[14px]" onClick={scan} data-testid="security-scan">
            {t("security.scan")}
          </Button>
        }
        error={error && <p className="text-[12px] text-risk">{t("cleanup.error.other", { message: error })}</p>}
      />
    );
  }

  const shown: Section | null = view === "3d" ? zoom : active;
  const Icon = SECTION_ICON[shown ?? active];
  const scores = sectionScores(report);
  const toggle = (
    <div className="flex rounded-lg border border-line p-0.5 text-[12px]">
      {(["3d", "cards"] as const).map((v) => (
        <button key={v} onClick={() => setView(v)} className={`rounded-md px-2.5 py-1 ${view === v ? "bg-raised text-fg" : "text-muted hover:text-fg"}`} data-testid={`security-view-${v}`}>
          {t(`security.view.${v}`)}
        </button>
      ))}
    </div>
  );
  return (
    <div className="flex flex-col gap-4 pb-2">
      {view === "cards" ? (
        <>
          <div className="flex justify-end">{toggle}</div>
          <Shield />
        </>
      ) : (
        // The 3D shield always stands on a dark stage, in both themes; the controls on it use the dark tokens.
        <div
          className="relative overflow-hidden rounded-card border border-line bg-[#0b0f14] text-[#e6e9ee]"
          style={{ "--color-fg": "#e6e9ee", "--color-muted": "#8b95a5", "--color-line": "#2a313b", "--color-surface": "#171b21", "--color-raised": "#1f242c", "--color-bg": "#0f1216", "--color-accent": "#4cc2ff" } as CSSProperties}
        >
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgb(76_194_255/0.12),transparent_60%)]" />
          <div className="absolute left-5 top-4 z-10 max-w-[280px]">
            <div className="text-[11px] uppercase tracking-wider text-muted">{t("security.shield.label")}</div>
            <div className="font-display text-[22px] font-semibold" style={{ color: report.findings.some((f) => f.severity === "high") ? "var(--color-risk)" : toneOf(shieldScore(report)) }} data-testid="security-verdict">
              {t(report.findings.some((f) => f.severity === "high") ? "security.shield.bad" : shieldScore(report) >= 85 ? "security.shield.good" : shieldScore(report) >= 60 ? "security.shield.fair" : "security.shield.poor")}
            </div>
            <p className="mt-1 text-[12px] leading-relaxed text-muted">{zoom ? t("security.view.back") : t("security.view.hint")}</p>
          </div>
          <div className="absolute right-4 top-4 z-10 flex items-center gap-2">
            {toggle}
            <Button icon={<RefreshCw size={14} />} onClick={scan} data-testid="security-rescan">
              {t("security.rescan")}
            </Button>
          </div>
          {zoom && (
            <button onClick={() => setZoom(null)} className="absolute bottom-4 left-5 z-10 flex items-center gap-1.5 rounded-full border border-line bg-surface/90 px-3 py-1.5 text-[12px] backdrop-blur hover:bg-raised" data-testid="shield-back">
              ← {t("security.view.whole")}
            </button>
          )}
          <div className="h-[470px]">
            <Suspense fallback={<div className="flex h-full items-center justify-center text-muted">…</div>}>
              <Shield3D
                parts={SECTIONS.map((s) => ({
                  id: s,
                  title: t(`security.section.${s}.title`),
                  score: s === "passwords" ? null : scores[s],
                  status: s === "passwords" ? t("security.section.passwords.status") : sectionIssues(report, s) ? t("security.section.issues", { count: sectionIssues(report, s) }) : t("security.section.ok"),
                }))}
                score={shieldScore(report)}
                selected={zoom}
                onSelect={(id) => {
                  setZoom(id as Section | null);
                  // The panel opens as the camera arrives.
                  if (id) window.setTimeout(() => document.querySelector("[data-testid^=panel-]")?.scrollIntoView({ behavior: "smooth", block: "start" }), 650);
                }}
              />
            </Suspense>
          </div>
        </div>
      )}
      {!report.elevated && (
        <div className="flex items-center gap-4 rounded-card border border-warn/25 bg-warn/[0.06] px-5 py-2.5">
          <ShieldAlert size={16} className="shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">{declined ? t("cleanup.adminDeclined") : t("security.adminText")}</p>
          <Button onClick={async () => setDeclined(!(await relaunchElevated()))}>{t("cleanup.adminAction")}</Button>
        </div>
      )}
      {view === "cards" && <SectionCards active={active} onPick={(s) => useSecurity.setState({ tab: s })} />}

      <AnimatePresence mode="wait" initial={false}>
        {shown && (
        <motion.section key={shown} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }} className="space-y-3" data-testid={`panel-${shown}`}>
          <div className="flex items-start gap-3 px-1">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
              <Icon size={18} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="font-display text-[18px] font-semibold">{t(`security.section.${shown}.title`)}</h2>
              <p className="max-w-[90ch] text-[12px] leading-relaxed text-muted">{t(`security.section.${shown}.lead`)}</p>
            </div>
          </div>

          {shown === "threats" && (
            <>
              <ReputationCard />
              {(["persistence", "process"] as const).map((area) => (
                <AreaSection key={area} area={area} findings={report.findings.filter((f) => f.area === area)} />
              ))}
            </>
          )}
          {shown === "tamper" && <AreaSection area="tamper" findings={report.findings.filter((f) => f.area === "tamper")} />}
          {shown === "windows" && <TestList tests={report.hardening.tests} group="test" />}
          {shown === "browser" && <BrowserSection list={report.extensions} />}
          {shown === "backup" && (
            <>
              <TestList tests={report.backup.tests} group="backup" />
              <button className="flex items-center gap-1.5 px-1 text-[12px] text-accent hover:underline" onClick={() => go("journal")}>
                {t("security.backup.toRestore")} <ArrowRight size={13} />
              </button>
            </>
          )}
          {shown === "network" && <NetworkSection open={report.exposure.open} publicNets={report.exposure.publicNetworks} />}
          {shown === "passwords" && <PasswordsSection />}
        </motion.section>
        )}
      </AnimatePresence>

      <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-muted/80">
        <AlertTriangle size={13} className="mt-0.5 shrink-0" />
        {t("security.disclaimer")}
      </p>
    </div>
  );
}
