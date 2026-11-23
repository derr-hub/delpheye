import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { Check, LifeBuoy, Loader2, ShieldCheck, Settings2 } from "lucide-react";
import { Button, Switch } from "../components/ui";
import { relaunchElevated } from "../lib/app";

interface Point {
  seq: number;
  description: string;
  created: string;
}
interface Status {
  elevated: boolean;
  protection: boolean | null;
  points: Point[];
  auto: boolean;
}

/** Windows restore points: whether they can be made, the latest ones, and one made now. */
export function RestorePoints() {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const load = () => invoke<Status>("restore_status").then(setStatus).catch(() => {});
  useEffect(() => {
    load();
  }, []);

  const make = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await invoke<string>("restore_create", { description: "DelphEye: manual" }));
    } catch (e) {
      setResult(String(e));
    }
    setBusy(false);
    load();
  };

  if (!status) return null;
  const when = (s: string) => new Intl.DateTimeFormat(i18n.language.startsWith("uk") ? "uk-UA" : "en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(s));
  const known = ["created", "skipped", "need-admin", "protection-off"];

  return (
    <section className="rounded-card border border-line bg-surface p-5" data-testid="restore-card">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
          <LifeBuoy size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-medium">{t("restore.title")}</h3>
          <p className="text-[12px] leading-relaxed text-muted">{t("restore.lead")}</p>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-3 text-[13px]">
        <div className="min-w-0 flex-1">
          <div>{t("restore.auto")}</div>
          <div className="text-[11px] leading-relaxed text-muted">{t("restore.autoText")}</div>
        </div>
        <Switch
          on={status.auto}
          onChange={() => {
            invoke("restore_auto", { on: !status.auto });
            setStatus({ ...status, auto: !status.auto });
          }}
          label={t("restore.auto")}
        />
      </div>

      {status.protection === false ? (
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-warn/10 px-3 py-2.5 text-[12px] text-warn">
          <span className="min-w-0 flex-1">{t("restore.protectionOff")}</span>
          <Button icon={<Settings2 size={14} />} onClick={() => invoke("restore_open_settings").catch(() => {})}>
            {t("restore.openSettings")}
          </Button>
        </div>
      ) : !status.elevated ? (
        <div className="mt-4 flex items-center gap-3 rounded-lg bg-raised/60 px-3 py-2.5 text-[12px] text-muted">
          <span className="min-w-0 flex-1">{t("restore.needAdmin")}</span>
          <Button icon={<ShieldCheck size={14} />} onClick={relaunchElevated}>
            {t("restore.asAdmin")}
          </Button>
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="primary" icon={busy ? <Loader2 size={14} className="animate-spin" /> : <LifeBuoy size={14} />} disabled={busy} onClick={make} data-testid="restore-create">
              {busy ? t("restore.creating") : t("restore.create")}
            </Button>
            {result && (
              <span className={`flex items-center gap-1.5 text-[12px] ${result === "created" ? "text-safe" : result === "skipped" ? "text-muted" : "text-risk"}`}>
                {result === "created" && <Check size={14} />}
                {known.includes(result) ? t(`restore.result.${result}`) : result}
              </span>
            )}
          </div>
          <ul className="mt-4 grid gap-1">
            {status.points.slice(0, 6).map((p) => (
              <li key={p.seq} className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-[12px] hover:bg-raised/50">
                <span className="min-w-0 flex-1 truncate">{p.description}</span>
                <span className="num shrink-0 text-[11px] text-muted">{p.created ? when(p.created) : ""}</span>
              </li>
            ))}
            {status.points.length === 0 && <li className="px-2 text-[12px] text-muted">{t("restore.none")}</li>}
          </ul>
          {status.points.length > 0 && <p className="mt-2 text-[11px] leading-relaxed text-muted">{t("restore.howBack")}</p>}
        </>
      )}
    </section>
  );
}
