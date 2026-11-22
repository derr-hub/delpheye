import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface LoginInfo {
  errors: number;
  captcha: boolean;
  lockedFor: number | null;
}

export interface Found {
  host: string | null;
  vendor: "asus" | "unknown";
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
  guests: { band: string; ssid: string }[];
  clients: Client[];
  checks: { id: string; level: "ok" | "info" | "warn" | "risk"; values: Record<string, unknown> }[];
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
}

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
}));

function absorb(o: Overview) {
  useRouter.setState((s) => {
    const before = s.seen[o.host];
    const macs = o.clients.map((c) => c.mac);
    // The first visit has nothing to compare with: nothing is "new" then.
    const fresh = before ? [...new Set([...s.fresh, ...macs.filter((m) => !before.includes(m))])] : s.fresh;
    const seen = { ...s.seen, [o.host]: [...new Set([...(before ?? []), ...macs])] };
    save("router.seen", seen);
    return { overview: o, seen, fresh, error: null };
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
