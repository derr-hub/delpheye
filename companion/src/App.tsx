import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Format, scan as scanQr, checkPermissions, requestPermissions } from "@tauri-apps/plugin-barcode-scanner";
import { onSensors, sensors, startSensors } from "./sensors";

interface Link {
  host: string;
  port: number;
  token: string;
}
interface Heard {
  bssid: string;
  ssid: string;
  rssi: number;
  freq: number;
}

const KEY = "companion.link";
const loadLink = (): Link | null => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
};

/** "delpheye://pair?h=192.168.50.181,10.0.0.2&p=47811&c=123456" */
function parseLink(text: string): { hosts: string[]; port: number; code: string } | null {
  const m = text.match(/^delpheye:\/\/pair\?(.*)$/);
  if (!m) return null;
  const q = new URLSearchParams(m[1]);
  const hosts = (q.get("h") ?? "").split(",").filter(Boolean);
  const port = Number(q.get("p") ?? 47811);
  const code = q.get("c") ?? "";
  return hosts.length && code ? { hosts, port, code } : null;
}

/** The phone's name for DelphEye's screen, from Android (filled by the first Wi-Fi scan). */
let deviceName = "Android";

async function pair(hosts: string[], port: number, code: string): Promise<Link> {
  let last = "unreachable";
  for (const host of hosts) {
    try {
      await invoke("call", { url: `http://${host}:${port}/hello` });
      const r = await invoke<{ token: string }>("call", { url: `http://${host}:${port}/pair`, body: { code, device: deviceName } });
      return { host, port, token: r.token };
    } catch (e) {
      last = String(e);
    }
  }
  throw new Error(last);
}

function Compass({ heading }: { heading: number | null }) {
  return (
    <svg viewBox="-110 -110 220 220" className="compass">
      <circle r={100} className="ring" />
      {["N", "E", "S", "W"].map((l, i) => (
        <text key={l} x={Math.sin((i * Math.PI) / 2) * 82} y={-Math.cos((i * Math.PI) / 2) * 82 + 6} textAnchor="middle" transform={`rotate(${-(heading ?? 0)})`} className={l === "N" ? "north" : "mark"}>
          {l === "N" ? "Пн" : l === "E" ? "Сх" : l === "S" ? "Пд" : "Зх"}
        </text>
      ))}
      <path d="M 0 -70 L 10 0 L 0 -8 L -10 0 Z" className="needle" />
      <circle r={6} className="hub" />
    </svg>
  );
}

export function App() {
  const [link, setLink] = useState<Link | null>(loadLink);
  const [status, setStatus] = useState<"idle" | "pairing" | "live" | "lost">(link ? "live" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const [steps, setSteps] = useState(0);
  const [heard, setHeard] = useState<Heard[]>([]);
  const [linkRssi, setLinkRssi] = useState<number | null>(null);
  const [manual, setManual] = useState({ host: "", code: "" });
  const [permission, setPermission] = useState<string>("unknown");
  const scanAt = useRef<number | null>(null);
  const latest = useRef<{ scan: Heard[]; linkBssid: string | null; linkRssi: number | null }>({ scan: [], linkBssid: null, linkRssi: null });

  useEffect(() => {
    startSensors();
    return onSensors(() => {
      setHeading(sensors.heading);
      setSteps(sensors.steps);
    });
  }, []);

  // Location permission: Android shares Wi-Fi scans only with it.
  useEffect(() => {
    invoke<Record<string, string>>("wifi_permission")
      .then((r) => setPermission(r.location ?? "unknown"))
      .catch((e) => setPermission(String(e)));
  }, []);

  // Wi-Fi: ask for a scan every 4 s (Android may refuse and hand back the last results).
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await invoke<{ results: (Heard & { age?: number })[]; linkBssid?: string; linkRssi?: number; device?: string }>("wifi_scan");
        if (r.device) deviceName = r.device.slice(0, 60);
        const scan = (r.results ?? []).map((x) => ({ bssid: (x.bssid ?? "").toUpperCase(), ssid: x.ssid ?? "", rssi: x.rssi, freq: x.freq ?? 0 }));
        const newest = Math.min(...(r.results ?? []).map((x) => x.age ?? 0));
        scanAt.current = Number.isFinite(newest) ? Date.now() - newest : Date.now();
        latest.current = { scan, linkBssid: r.linkBssid?.toUpperCase() ?? null, linkRssi: r.linkRssi ?? null };
        setHeard(scan);
        setLinkRssi(r.linkRssi ?? null);
      } catch (e) {
        setError(String(e));
      }
    };
    tick();
    const id = window.setInterval(tick, 4000);
    return () => window.clearInterval(id);
  }, []);

  // Stream a frame to the computer every second while linked.
  useEffect(() => {
    if (!link) return;
    let alive = true;
    let failures = 0;
    const id = window.setInterval(async () => {
      const frame = {
        t: Date.now(),
        heading: sensors.heading,
        steps: sensors.steps,
        scan: latest.current.scan,
        scanAt: scanAt.current,
        linkBssid: latest.current.linkBssid,
        linkRssi: latest.current.linkRssi,
      };
      try {
        await invoke("call", { url: `http://${link.host}:${link.port}/frame`, body: { token: link.token, frame } });
        failures = 0;
        if (alive) setStatus("live");
      } catch (e) {
        failures++;
        if (String(e).includes("not-paired")) {
          localStorage.removeItem(KEY);
          setLink(null);
          setStatus("idle");
          setError("Комп'ютер забув цей телефон — під'єднайся знову.");
        } else if (failures >= 3 && alive) setStatus("lost");
      }
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [link]);

  const connect = async (hosts: string[], port: number, code: string) => {
    setStatus("pairing");
    setError(null);
    try {
      const l = await pair(hosts, port, code);
      localStorage.setItem(KEY, JSON.stringify(l));
      setLink(l);
      setStatus("live");
    } catch (e) {
      setStatus("idle");
      setError(String(e).includes("wrong-code") ? "Неправильний код. Подивись код на екрані комп'ютера." : `Не вдалося знайти комп'ютер. Телефон і комп'ютер мають бути в одній домашній мережі, а DelphEye — з відкритим під'єднанням телефона. (${String(e).replace(/^Error: /, "")})`);
    }
  };

  const scanCode = async () => {
    setError(null);
    try {
      let p = await checkPermissions();
      if (p !== "granted") p = await requestPermissions();
      if (p !== "granted") throw new Error("camera");
      const r = await scanQr({ formats: [Format.QRCode], windowed: false });
      const parsed = parseLink(r.content);
      if (!parsed) throw new Error("not-delpheye");
      await connect(parsed.hosts, parsed.port, parsed.code);
    } catch (e) {
      const s = String(e);
      setError(s.includes("camera") ? "Потрібен дозвіл на камеру, щоб прочитати QR-код. Або введи код вручну." : s.includes("not-delpheye") ? "Це не QR-код DelphEye." : s);
    }
  };

  const own = heard.find((h) => h.bssid === latest.current.linkBssid);
  return (
    <main>
      <header>
        <div className="logo">◉</div>
        <div>
          <h1>DelphEye Companion</h1>
          <p className={`status ${status}`}>
            {status === "live" ? `Під'єднано до комп'ютера ${link?.host}` : status === "lost" ? "Зв'язок із комп'ютером перервався…" : status === "pairing" ? "Під'єднуюсь…" : "Не під'єднано"}
          </p>
        </div>
      </header>

      {!link && (
        <section className="card">
          <h2>Під'єднати до комп'ютера</h2>
          <p className="muted">На комп'ютері: DelphEye → Wi-Fi → Розширений → «Телефон» → «Під'єднати телефон». Потім відскануй QR-код з екрана.</p>
          <button className="primary" onClick={scanCode} disabled={status === "pairing"}>
            Сканувати QR-код
          </button>
          <details>
            <summary>Ввести вручну</summary>
            <input placeholder="Адреса комп'ютера, напр. 192.168.50.181" value={manual.host} onChange={(e) => setManual({ ...manual, host: e.target.value.trim() })} inputMode="decimal" />
            <input placeholder="Код з екрана (6 цифр)" value={manual.code} onChange={(e) => setManual({ ...manual, code: e.target.value.replace(/\D/g, "").slice(0, 6) })} inputMode="numeric" />
            <button onClick={() => connect([manual.host], 47811, manual.code)} disabled={!manual.host || manual.code.length !== 6 || status === "pairing"}>
              Під'єднатися
            </button>
          </details>
        </section>
      )}
      {error && <p className="error">{error}</p>}

      <section className="card center">
        <Compass heading={heading} />
        <div className="row">
          <div>
            <b>{heading === null ? "—" : `${Math.round(heading)}°`}</b>
            <span>напрям</span>
          </div>
          <div>
            <b>{steps}</b>
            <span>кроків</span>
          </div>
          <div>
            <b>{heard.length}</b>
            <span>мереж чути</span>
          </div>
        </div>
        {heading === null && <p className="muted small">Компас ще не відповів. Покрути телефон «вісімкою» — це калібрує його.</p>}
      </section>

      <section className="card">
        <h2>Твоя мережа</h2>
        <p className="big">{own?.ssid || "—"}</p>
        <p className="muted">{linkRssi !== null ? `${linkRssi} dBm` : "Телефон не підключений до Wi-Fi"}</p>
      </section>

      {permission !== "granted" && (
        <p className="warn">Android показує мережі навколо лише з дозволом на місцезнаходження і з увімкненим GPS. Дозволь його в налаштуваннях застосунку.</p>
      )}
      <p className="muted small">
        Порада: Android дозволяє програмам сканувати Wi-Fi лише 4 рази на 2 хвилини. Для живого стеження вимкни обмеження: Налаштування → Параметри розробника → «Обмеження сканування Wi-Fi».
      </p>
      {link && (
        <button
          className="ghost"
          onClick={() => {
            localStorage.removeItem(KEY);
            setLink(null);
            setStatus("idle");
          }}
        >
          Від'єднати цей телефон
        </button>
      )}
    </main>
  );
}
