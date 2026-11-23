import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import QRCode from "qrcode";
import { Check, Copy, Eye, EyeOff, Loader2, Printer, QrCode, X } from "lucide-react";
import { Button, Modal } from "../../components/ui";

interface Share {
  ssid: string;
  password: string;
  kind: "WPA" | "SAE" | "WEP" | "nopass";
  hidden: boolean;
  qr: string;
}

/** A button that opens the guest card: a QR code that joins this Wi-Fi with one tap. */
export function ShareWifi() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState("");
  const [show, setShow] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShare(null);
    setError(null);
    setShow(false);
    invoke<Share>("wifi_share")
      .then(async (s) => {
        setShare(s);
        setSvg(await QRCode.toString(s.qr, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#0f1216", light: "#ffffff" } }));
      })
      .catch((e) => setError(String(e)));
  }, [open]);

  const print = () => {
    if (!share) return;
    // A clean card in its own window, so only it gets printed.
    const w = window.open("", "_blank", "width=480,height=640");
    if (!w) return;
    w.document.write(`<!doctype html><meta charset="utf-8"><title>Wi-Fi</title>
      <body style="font-family:Segoe UI,system-ui,sans-serif;text-align:center;padding:32px;color:#111">
      <div style="font-size:14px;color:#666">${t("share.cardTitle")}</div>
      <div style="font-size:26px;font-weight:600;margin:6px 0 18px">${share.ssid.replace(/</g, "&lt;")}</div>
      <div style="width:280px;margin:0 auto">${svg}</div>
      ${share.kind !== "nopass" ? `<div style="margin-top:18px;font-size:13px;color:#666">${t("share.password")}</div><div style="font-size:20px;font-family:Consolas,monospace">${share.password.replace(/</g, "&lt;")}</div>` : ""}
      <div style="margin-top:18px;font-size:12px;color:#888">${t("share.cardHint")}</div>
      <script>window.onload=()=>{window.print();}</script></body>`);
    w.document.close();
  };

  return (
    <>
      <Button icon={<QrCode size={14} />} onClick={() => setOpen(true)} data-testid="share-wifi">
        {t("share.button")}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} width="max-w-[420px]">
        <div className="text-center" data-testid="share-card">
          <div className="flex items-start">
            <div className="min-w-0 flex-1 text-left">
              <h2 className="font-display text-[17px] font-semibold">{t("share.title")}</h2>
              <p className="text-[12px] leading-relaxed text-muted">{t("share.lead")}</p>
            </div>
            <button onClick={() => setOpen(false)} className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg" aria-label={t("feedback.close")}>
              <X size={16} />
            </button>
          </div>
          {error ? (
            <p className="mt-6 rounded-lg bg-warn/10 px-3 py-3 text-[12px] leading-relaxed text-warn">{t(`share.error.${error}`, { defaultValue: t("share.error.other") })}</p>
          ) : !share ? (
            <div className="flex h-[300px] items-center justify-center">
              <Loader2 className="animate-spin text-accent" />
            </div>
          ) : (
            <>
              <div className="mx-auto mt-5 h-[240px] w-[240px] overflow-hidden rounded-2xl bg-white p-3 shadow-[0_8px_30px_-10px_rgba(11,111,176,0.45)] [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} data-testid="share-qr" />
              <div className="mt-4 text-[18px] font-semibold">{share.ssid}</div>
              {share.kind !== "nopass" && (
                <div className="mt-2 flex items-center justify-center gap-2">
                  <span className="num rounded-lg bg-raised px-3 py-1.5 text-[14px]">{show ? share.password : "•".repeat(Math.min(14, share.password.length))}</span>
                  <button onClick={() => setShow(!show)} className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg" aria-label={t("share.show")}>
                    {show ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(share.password);
                      setCopied(true);
                      window.setTimeout(() => setCopied(false), 1500);
                    }}
                    className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg"
                    aria-label={t("share.copy")}
                  >
                    {copied ? <Check size={15} className="text-safe" /> : <Copy size={15} />}
                  </button>
                </div>
              )}
              <p className="mt-3 text-[11px] leading-relaxed text-muted">{t(share.kind === "SAE" ? "share.hintWpa3" : "share.hint")}</p>
              <Button className="mt-4" icon={<Printer size={14} />} onClick={print}>
                {t("share.print")}
              </Button>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
