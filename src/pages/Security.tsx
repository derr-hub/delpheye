import { useState, type ReactNode } from "react";
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
  ShieldQuestion,
  Skull,
  Square,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { Button, Modal, Ring, Switch } from "../components/ui";
import { relaunchElevated } from "../lib/app";
import {
  AREAS,
  act,
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

function SeverityBadge({ severity }: { severity: Severity }) {
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

function Hardening() {
  const { t } = useTranslation();
  const report = useSecurity((s) => s.report)!;
  const { score, tests } = report.hardening;
  const color = score >= 85 ? "var(--color-safe)" : score >= 60 ? "var(--color-warn)" : "var(--color-risk)";
  const sorted = [...tests].sort((a, b) => ["fail", "unknown", "pass"].indexOf(a.outcome) - ["fail", "unknown", "pass"].indexOf(b.outcome) || b.weight - a.weight);
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-6 rounded-card border border-line bg-surface px-5 py-4">
        <Ring value={score} color={color} size={110} stroke={8}>
          <span className="font-display text-[30px] font-semibold leading-none" data-testid="hardening-score">
            {score}
          </span>
          <span className="text-[11px] text-muted">/ 100</span>
        </Ring>
        <div className="min-w-0 flex-1">
          <div className="font-display text-[20px] font-semibold">{t(score >= 85 ? "security.scoreGood" : score >= 60 ? "security.scoreFair" : "security.scorePoor")}</div>
          <p className="mt-1 max-w-[70ch] text-[12px] leading-relaxed text-muted">{t("security.scoreHint")}</p>
        </div>
      </div>
      <ul className="overflow-hidden rounded-card border border-line bg-surface">
        {sorted.map((test) => {
          const Icon = OUTCOME_ICON[test.outcome];
          return (
            <li key={test.id} className="flex items-start gap-3.5 border-b border-line px-5 py-3 last:border-b-0" data-testid={`test-${test.id}`}>
              <Icon size={18} className={`mt-0.5 shrink-0 ${OUTCOME_TONE[test.outcome]}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 text-[14px] font-medium">
                  {t(`security.test.${test.id}.name`)}
                  {test.detail && <span className="truncate text-[12px] font-normal text-muted">{test.detail}</span>}
                </div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-muted">{t(`security.test.${test.id}.${test.outcome}`, { defaultValue: t(`security.outcome.${test.outcome}`) })}</p>
              </div>
              {test.fix && test.outcome !== "pass" && (
                <Button onClick={() => openUrl(test.fix!).catch(console.error)}>{t("security.openSettings")}</Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Verdict() {
  const { t } = useTranslation();
  const report = useSecurity((s) => s.report)!;
  const high = report.findings.filter((f) => f.severity === "high").length;
  const medium = report.findings.filter((f) => f.severity === "medium").length;
  const [Icon, tone, key]: [LucideIcon, string, string] = high
    ? [Skull, "text-risk", "security.verdictBad"]
    : medium
      ? [ShieldQuestion, "text-warn", "security.verdictWarn"]
      : [ShieldCheck, "text-safe", "security.verdictGood"];
  return (
    <div className="flex items-center gap-4 rounded-card border border-line bg-surface px-5 py-4">
      <Icon size={30} className={tone} />
      <div className="min-w-0 flex-1">
        <div className="font-display text-[20px] font-semibold" data-testid="security-verdict">
          {t(key)}
        </div>
        <div className="text-[12px] text-muted">
          {t("security.summary", { high, medium, low: report.findings.filter((f) => f.severity === "low").length, seconds: (report.durationMs / 1000).toFixed(1) })}
        </div>
      </div>
      <Button icon={<RefreshCw size={15} />} onClick={scan}>
        {t("security.rescan")}
      </Button>
    </div>
  );
}

export function Security() {
  const { t } = useTranslation();
  const { phase, report, tab, error } = useSecurity();
  const [declined, setDeclined] = useState(false);

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
      <div className="flex h-full flex-col items-center justify-center text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-2xl border border-line bg-surface text-accent">
          <ShieldCheck size={36} strokeWidth={1.4} />
        </div>
        <h2 className="font-display text-[20px] font-semibold">{t("security.introTitle")}</h2>
        <p className="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-muted">{t("security.introText")}</p>
        <Button variant="primary" className="mt-6 !h-10 !px-7" onClick={scan} data-testid="security-scan">
          {t("security.scan")}
        </Button>
        {error && <p className="mt-4 text-[12px] text-risk">{t("cleanup.error.other", { message: error })}</p>}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 pb-2">
      <Verdict />
      {!report.elevated && (
        <div className="flex items-center gap-4 rounded-card border border-warn/25 bg-warn/[0.06] px-5 py-3">
          <ShieldAlert size={18} className="shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">{declined ? t("cleanup.adminDeclined") : t("security.adminText")}</p>
          <Button onClick={async () => setDeclined(!(await relaunchElevated()))}>{t("cleanup.adminAction")}</Button>
        </div>
      )}
      <div className="flex gap-1 rounded-lg border border-line p-0.5 text-[13px]" role="tablist">
        {(["findings", "hardening"] as const).map((id) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => useSecurity.setState({ tab: id })}
            data-testid={`security-tab-${id}`}
            className={`relative h-8 flex-1 rounded-md transition-colors duration-150 ${tab === id ? "text-fg" : "text-muted hover:text-fg"}`}
          >
            {tab === id && <motion.span layoutId="security-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: "spring", stiffness: 420, damping: 34 }} />}
            <span className="relative">
              {t(`security.tab.${id}`)}
              <span className="num ml-1.5 text-muted">{id === "hardening" ? report.hardening.score : report.findings.filter((f) => f.severity !== "info").length}</span>
            </span>
          </button>
        ))}
      </div>
      {tab === "findings" ? (
        <div className="space-y-4">
          <ReputationCard />
          {AREAS.map((area) => (
            <AreaSection key={area} area={area} findings={report.findings.filter((f) => f.area === area)} />
          ))}
          <p className="flex items-start gap-2 px-1 text-[11px] leading-relaxed text-muted/80">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            {t("security.disclaimer")}
          </p>
        </div>
      ) : (
        <Hardening />
      )}
    </div>
  );
}
