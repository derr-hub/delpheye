import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Level } from "./processes";

export interface Adapter {
  index: number;
  name: string;
  description: string;
  kind: "ethernet" | "wifi" | "vpn" | "loopback" | "other";
  up: boolean;
  speed: number;
  mac: string;
  ipv4: string[];
  ipv6: string[];
  gateways: string[];
  dns: string[];
  received: number;
  sent: number;
}

export interface Wifi {
  interface: string;
  ssid: string;
  signal: number;
  rxMbps: number;
  txMbps: number;
  security: "open" | "wep" | "wpa" | "wpa2" | "wpa3" | "owe" | "other";
  generation: string;
}

export interface Conn {
  remote: string;
  ip: string;
  port: number;
  host: string | null;
  service: string | null;
  public: boolean;
  rx: number | null;
  tx: number | null;
}

export interface NetApp {
  pid: number;
  start: number;
  name: string;
  exe: string | null;
  description: string | null;
  company: string | null;
  level: Level;
  known: string | null;
  connections: Conn[];
  rx: number | null;
  tx: number | null;
  concerns: string[];
}

export interface Listener {
  pid: number;
  name: string;
  exe: string | null;
  port: number;
  exposed: boolean;
  level: Level;
}

export interface Snapshot {
  elevated: boolean;
  adapters: Adapter[];
  wifi: Wifi[];
  apps: NetApp[];
  listeners: Listener[];
}

export interface Probe {
  target: string;
  avgMs: number | null;
  loss: number;
}

export interface Check {
  gateway: Probe | null;
  internet: Probe[];
  dnsMs: number | null;
  verdict: "good" | "slow-local" | "slow-internet" | "no-internet" | "dns" | "no-network";
}

interface State {
  snapshot: Snapshot | null;
  error: string | null;
  checking: boolean;
  check: Check | null;
  open: Record<number, boolean>;
}

export const useNetwork = create<State>(() => ({ snapshot: null, error: null, checking: false, check: null, open: {} }));

export async function refreshNetwork() {
  try {
    useNetwork.setState({ snapshot: await invoke<Snapshot>("network_snapshot"), error: null });
  } catch (e) {
    useNetwork.setState({ error: String(e) });
  }
}

export function startNetworkPolling(): () => void {
  refreshNetwork();
  const timer = window.setInterval(refreshNetwork, 2000);
  return () => window.clearInterval(timer);
}

export async function runCheck() {
  if (useNetwork.getState().checking) return;
  useNetwork.setState({ checking: true });
  try {
    useNetwork.setState({ check: await invoke<Check>("network_check") });
  } catch (e) {
    console.error("network_check failed", e);
  }
  useNetwork.setState({ checking: false });
}

/** Well-known public DNS resolvers, so a bare address can be named. */
export const KNOWN_DNS: Record<string, string> = {
  "1.1.1.1": "Cloudflare",
  "1.0.0.1": "Cloudflare",
  "8.8.8.8": "Google",
  "8.8.4.4": "Google",
  "9.9.9.9": "Quad9",
  "149.112.112.112": "Quad9",
  "208.67.222.222": "OpenDNS",
  "208.67.220.220": "OpenDNS",
  "94.140.14.14": "AdGuard",
  "94.140.15.15": "AdGuard",
  "2606:4700:4700::1111": "Cloudflare",
  "2001:4860:4860::8888": "Google",
};
