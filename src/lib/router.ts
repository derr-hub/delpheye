import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface LoginInfo {
  errors: number;
  captcha: boolean;
  lockedFor: number | null;
}

export interface Found {
  host: string | null;
  vendor: "asus" | "keenetic" | "mikrotik" | "openwrt" | "unknown";
  model: string | null;
  login: LoginInfo | null;
  saved: boolean;
  connected: boolean;
}

export interface Radio {
  unit: number;
  band: "2.4" | "5" | "6";
  ssid: string;
  enabled: boolean;
  channel: number | null;
  auto: boolean;
  width: number | null;
  security: string;
  tkip: boolean;
  hidden: boolean;
  /** The router's own channel setting ("0" = auto). */
  spec: string;
}

export interface Client {
  mac: string;
  name: string;
  ip: string;
  vendor: string;
  link: "wired" | "2.4" | "5" | "6";
  rssi: number | null;
  online: boolean;
  connectedSecs: number | null;
  txMbps: number | null;
  rxMbps: number | null;
  randomMac: boolean;
  guest: boolean;
}

export interface Overview {
  vendor: string;
  model: string;
  firmware: string;
  host: string;
  uptimeSecs: number | null;
  radios: Radio[];
  guests: { id: string; band: string; ssid: string }[];
  clients: Client[];
  checks: { id: string; level: "ok" | "info" | "warn" | "risk"; values: Record<string, unknown> }[];
  traffic: { internetRx: number; internetTx: number; wiredRx: number; wiredTx: number; wirelessRx: number; wirelessTx: number };
  ports: { name: string; external: string; ip: string; internal: string; protocol: string; upnp: boolean }[];
  blocked: string[];
  allowList: boolean;
}

export interface RouterEvent {
  at: string;
  mac: string;
  kind: "join" | "leave";
}

interface RouterStore {
  found: Found | null;
  overview: Overview | null;
  busy: boolean;
  error: string | null;
  /** Devices the user marked as theirs, per router. */
  known: Record<string, string[]>;
  /** Every device seen before this session, per router: anything else is new. */
  seen: Record<string, string[]>;
  /** Devices first seen in this session. */
  fresh: string[];
  /** A change being applied now. */
  applying: string | null;
  /** Each device's signal at the router over this session, by MAC. */
  signal: Record<string, { t: number; rssi: number }[]>;
  /** Internet speed from the router's counters, bytes per second. */
  rate: { down: number; up: number } | null;
  last: { t: number; rx: number; tx: number } | null;
  events: RouterEvent[];
  /** Changes made in this session, newest first, each with its way back. */
  done: Done[];
}

export interface Done {
  action: string;
  guest: string | null;
  /** The change that puts it back. */
  back: { action: string; guest: string | null };
  /** What it was about, for the message (e.g. the guest network's name). */
  label: string;
  /** The router shows the change took effect. */
  confirmed: boolean;
  undone: boolean;
}

const REVERSE: Record<string, string> = { "wps-off": "wps-on", "guest-off": "guest-on", "upnp-off": "upnp-on" };

/** Whether the router's settings show the action took effect. */
function took(o: Overview, action: string, guest: string | null): boolean {
  if (action.startsWith("block:")) return o.blocked.includes(action.slice(6).toUpperCase());
  if (action.startsWith("unblock:")) return !o.blocked.includes(action.slice(8).toUpperCase());
  if (action.startsWith("channel:")) {
    const [, unit, spec] = action.split(":");
    return o.radios.some((r) => String(r.unit) === unit && r.spec === spec);
  }
  switch (action) {
    case "wps-off":
      return !o.checks.some((c) => c.id === "wps-on");
    case "upnp-off":
      return !o.checks.some((c) => c.id === "upnp-on");
    case "guest-off":
      return !o.guests.some((g) => g.id === guest);
    case "wps-on":
      return o.checks.some((c) => c.id === "wps-on");
    case "upnp-on":
      return o.checks.some((c) => c.id === "upnp-on");
    case "guest-on":
      return o.guests.some((g) => g.id === guest);
  }
  return false;
}

/** Applies one change the user confirmed; `undo` turns an earlier change back. `back` is the change
 * that would undo this one (the opposite switch, or the previous channel). */
export async function applyRouter(action: string, guest: string | null, label: string, undo = false, back?: { action: string; guest: string | null }) {
  useRouter.setState({ applying: action + (guest ?? ""), error: null });
  try {
    const o = await invoke<Overview>("router_apply", { action, guest });
    absorb(o);
    useRouter.setState((s) => ({
      done: undo
        ? s.done.map((d) => (d.back.action === action && d.back.guest === guest && !d.undone ? { ...d, undone: took(o, action, guest) } : d))
        : [{ action, guest, label, back: back ?? { action: REVERSE[action], guest }, confirmed: took(o, action, guest), undone: false }, ...s.done],
    }));
  } catch (e) {
    useRouter.setState({ error: String(e) });
  }
  useRouter.setState({ applying: null });
}

export const reverseOf = (action: string) => REVERSE[action];

const load = (key: string) => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
};
const save = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* this session only */
  }
};

export const useRouter = create<RouterStore>(() => ({
  found: null,
  overview: null,
  busy: false,
  error: null,
  known: load("router.known"),
  seen: load("router.seen"),
  fresh: [],
  applying: null,
  done: [],
  signal: {},
  rate: null,
  last: null,
  events: [],
}));

export async function loadLog() {
  try {
    useRouter.setState({ events: await invoke<RouterEvent[]>("router_log") });
  } catch {
    /* the log is a nice-to-have */
  }
}

function absorb(o: Overview) {
  useRouter.setState((s) => {
    const before = s.seen[o.host];
    const macs = o.clients.map((c) => c.mac);
    // The first visit has nothing to compare with: nothing is "new" then.
    const fresh = before ? [...new Set([...s.fresh, ...macs.filter((m) => !before.includes(m))])] : s.fresh;
    const seen = { ...s.seen, [o.host]: [...new Set([...(before ?? []), ...macs])] };
    save("router.seen", seen);
    const t = Date.now();
    const signal = { ...s.signal };
    for (const c of o.clients) if (c.rssi !== null && c.online) signal[c.mac] = [...(signal[c.mac] ?? []).filter((x) => t - x.t < 30 * 60_000), { t, rssi: c.rssi }];
    const now = { t, rx: o.traffic.internetRx, tx: o.traffic.internetTx };
    const dt = s.last ? (t - s.last.t) / 1000 : 0;
    const rate = s.last && dt > 1 && now.rx >= s.last.rx && now.tx >= s.last.tx ? { down: (now.rx - s.last.rx) / dt, up: (now.tx - s.last.tx) / dt } : s.rate;
    return { overview: o, seen, fresh, error: null, signal, rate, last: now };
  });
}

export async function findRouter() {
  try {
    useRouter.setState({ found: await invoke<Found>("router_find") });
  } catch (e) {
    useRouter.setState({ error: String(e) });
  }
}

export async function connectRouter(user: string | null, password: string | null, remember: boolean) {
  useRouter.setState({ busy: true, error: null });
  try {
    absorb(await invoke<Overview>("router_connect", { user, password, remember }));
  } catch (e) {
    useRouter.setState({ error: String(e) });
    findRouter();
  }
  useRouter.setState({ busy: false });
}

export async function refreshRouter() {
  try {
    absorb(await invoke<Overview>("router_read"));
  } catch (e) {
    if (String(e) === "expired" || String(e) === "not-connected") useRouter.setState({ overview: null });
    useRouter.setState({ error: String(e) });
  }
}

export async function disconnectRouter(forget: boolean) {
  await invoke("router_disconnect", { forget }).catch(console.error);
  useRouter.setState({ overview: null });
  findRouter();
}

export function toggleKnown(host: string, mac: string) {
  useRouter.setState((s) => {
    const list = s.known[host] ?? [];
    const known = { ...s.known, [host]: list.includes(mac) ? list.filter((m) => m !== mac) : [...list, mac] };
    save("router.known", known);
    return { known };
  });
}
