import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { open as pickFiles } from "@tauri-apps/plugin-dialog";
import { Bug, Check, FileVideo, ImageIcon, Lightbulb, Loader2, MessageSquareHeart, Paperclip, Send, X } from "lucide-react";
import { Button, Checkbox, Modal } from "./ui";
import { closeFeedback, useFeedback } from "../lib/feedback";
import { useFmt } from "../lib/format";
import { showOnboarding } from "./Onboarding";

interface Picked {
  path: string;
  name: string;
  size: number;
  video: boolean;
}

const LIMIT = 10 * 1024 * 1024;
const KINDS = [
  ["idea", Lightbulb],
  ["bug", Bug],
  ["other", MessageSquareHeart],
] as const;

/** Write to the developer: text, photos and videos, straight from the app. */
export function Feedback() {
  const { t } = useTranslation();
  const fmt = useFmt();
  const open = useFeedback((s) => s.open);
  const [kind, setKind] = useState<"idea" | "bug" | "other">("idea");
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [files, setFiles] = useState<Picked[]>([]);
  const [technical, setTechnical] = useState(true);
  const [phase, setPhase] = useState<"edit" | "sending" | "sent">("edit");
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    if (!open) return;
    invoke<boolean>("feedback_available").then(setAvailable).catch(() => setAvailable(false));
    if (phase === "sent") {
      setPhase("edit");
      setText("");
      setFiles([]);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const attach = async () => {
    const picked = await pickFiles({
      multiple: true,
      filters: [{ name: t("feedback.media"), extensions: ["png", "jpg", "jpeg", "gif", "webp", "mp4", "mov", "webm", "mkv"] }],
    });
    if (!picked) return;
    const paths = (Array.isArray(picked) ? picked : [picked]).filter((p) => !files.some((f) => f.path === p));
    const got = await invoke<Picked[]>("feedback_files", { paths });
    setFiles((f) => [...f, ...got].slice(0, 10));
  };

  const tooBig = files.filter((f) => f.size > LIMIT);
  const send = async () => {
    setPhase("sending");
    setError(null);
    try {
      await invoke("feedback_send", { feedback: { text, contact, kind, files: files.map((f) => f.path), technical } });
      setPhase("sent");
    } catch (e) {
      const s = String(e);
      setPhase("edit");
      setError(
        s.startsWith("too-big") ? t("feedback.error.tooBig") : s === "too-often" ? t("feedback.error.tooOften") : s === "not-configured" ? t("feedback.error.off") : s.startsWith("network") ? t("feedback.error.network") : `${t("feedback.error.other")} (${s})`,
      );
    }
  };

  return (
    <Modal open={open} onClose={() => phase !== "sending" && closeFeedback()} width="max-w-[33.75rem]">
      <div data-testid="feedback">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <MessageSquareHeart size={20} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="font-display text-[1.0625rem] font-semibold">{t("feedback.title")}</h2>
            <p className="text-[0.75rem] leading-relaxed text-muted">{t("feedback.lead")}</p>
          </div>
          <button onClick={closeFeedback} disabled={phase === "sending"} className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg" aria-label={t("feedback.close")}>
            <X size={16} />
          </button>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {phase === "sent" ? (
            <motion.div key="sent" initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="py-10 text-center" data-testid="feedback-sent">
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: "spring", stiffness: 400, damping: 18 }} className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-safe/15 text-safe">
                <Check size={28} />
              </motion.span>
              <div className="text-[0.9375rem] font-medium">{t("feedback.thanks")}</div>
              <p className="mt-1 text-[0.75rem] text-muted">{t("feedback.thanksText")}</p>
              <Button className="mt-5" onClick={closeFeedback}>
                {t("feedback.close")}
              </Button>
            </motion.div>
          ) : (
            <motion.div key="edit" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <div className="mt-4 flex gap-1.5">
                {KINDS.map(([k, Icon]) => (
                  <button
                    key={k}
                    onClick={() => setKind(k)}
                    className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg border py-2 text-[0.75rem] transition-colors ${kind === k ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-raised hover:text-fg"}`}
                    data-testid={`feedback-kind-${k}`}
                  >
                    <Icon size={14} />
                    {t(`feedback.kind.${k}`)}
                  </button>
                ))}
              </div>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={t(`feedback.placeholder.${kind}`)}
                rows={5}
                maxLength={3500}
                className="mt-3 w-full resize-none rounded-xl border border-line bg-bg px-3 py-2.5 text-[0.8125rem] leading-relaxed text-fg outline-none placeholder:text-muted/70 focus:border-accent"
                data-testid="feedback-text"
              />
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder={t("feedback.contact")}
                maxLength={200}
                className="mt-2 h-9 w-full rounded-lg border border-line bg-bg px-3 text-[0.8125rem] text-fg outline-none placeholder:text-muted/70 focus:border-accent"
              />

              {files.length > 0 && (
                <ul className="mt-3 grid gap-1.5">
                  {files.map((f) => (
                    <li key={f.path} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[0.75rem] ${f.size > LIMIT ? "border-risk/50 bg-risk/5" : "border-line bg-raised/40"}`}>
                      {f.video ? <FileVideo size={14} className="shrink-0 text-accent" /> : <ImageIcon size={14} className="shrink-0 text-accent" />}
                      <span className="min-w-0 flex-1 truncate">{f.name}</span>
                      <span className={`num shrink-0 text-[0.6875rem] ${f.size > LIMIT ? "text-risk" : "text-muted"}`}>{fmt.bytes(f.size)}</span>
                      <button onClick={() => setFiles(files.filter((x) => x.path !== f.path))} className="shrink-0 text-muted hover:text-risk" aria-label={t("feedback.remove")}>
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {tooBig.length > 0 && <p className="mt-1.5 text-[0.6875rem] text-risk">{t("feedback.error.tooBig")}</p>}

              <div className="mt-3 flex items-center gap-3">
                <Button onClick={attach} icon={<Paperclip size={14} />} disabled={files.length >= 10} data-testid="feedback-attach">
                  {t("feedback.attach")}
                </Button>
                <label className="flex cursor-pointer items-center gap-2 text-[0.75rem] text-muted">
                  <Checkbox state={technical} onChange={() => setTechnical(!technical)} label={t("feedback.technical")} />
                  {t("feedback.technical")}
                </label>
              </div>

              {!available && <p className="mt-3 rounded-lg bg-warn/10 px-3 py-2 text-[0.75rem] text-warn">{t("feedback.error.off")}</p>}
              {error && <p className="mt-3 rounded-lg bg-risk/10 px-3 py-2 text-[0.75rem] text-risk" data-testid="feedback-error">{error}</p>}

              <div className="mt-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[0.6875rem] leading-relaxed text-muted">{t("feedback.privacy")}</p>
                  <button
                    onClick={() => {
                      closeFeedback();
                      showOnboarding();
                    }}
                    className="mt-1 text-[0.6875rem] text-accent hover:underline"
                  >
                    {t("onboarding.again")}
                  </button>
                </div>
                <Button
                  variant="primary"
                  icon={phase === "sending" ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                  disabled={phase === "sending" || !available || tooBig.length > 0 || (!text.trim() && !files.length)}
                  onClick={send}
                  data-testid="feedback-send"
                >
                  {phase === "sending" ? t("feedback.sending") : t("feedback.send")}
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  );
}
