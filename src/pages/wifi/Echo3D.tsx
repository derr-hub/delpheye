import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Building2, Crosshair, Info, Pause, Play, RotateCcw, Waves, X } from "lucide-react";
import { BAND_COLORS, nameOf, useWifi, type Band, type Bss } from "../../lib/wifi";
import { useRouter } from "../../lib/router";
import { idw, loadPlans, locate, type Saved } from "./Plan";
import { guessNow } from "./Whereami";
import { live as phoneLive, usePhone, usePhoneMap } from "../../lib/phone";

/** Distance in metres → radius in the scene: logarithmic, so 1 m and 50 m both fit. */
const radius = (m: number) => 6 * Math.log(1 + m);
const RINGS = [1, 2, 5, 10, 20, 50];
const LAYER: Record<Band, number> = { "2.4": 1.2, "5": 4.4, "6": 7.6 };
const OWN = new THREE.Color("#4CC2FF");

type ColorMode = "band" | "security" | "gen";
const SECURITY_COLOURS: Record<string, string> = {
  open: "#ff6b7a",
  wep: "#ff6b7a",
  wpa: "#ff8f5a",
  tkip: "#fce100",
  wpa2: "#4CC2FF",
  "wpa2-wpa3": "#6ccb5f",
  wpa3: "#6ccb5f",
  owe: "#5ed6d0",
  enterprise: "#B48CFF",
};
const GEN_COLOURS: Record<number, string> = { 0: "#8b95a5", 4: "#F5A35C", 5: "#4CC2FF", 6: "#6ccb5f", 7: "#B48CFF" };

function colourOf(b: Bss, mode: ColorMode): THREE.Color {
  if (mode === "security") return new THREE.Color(SECURITY_COLOURS[b.tkip && b.security === "wpa2" ? "tkip" : b.security] ?? "#8b95a5");
  if (mode === "gen") return new THREE.Color(GEN_COLOURS[b.generation] ?? "#8b95a5");
  return b.connected ? OWN.clone() : new THREE.Color(BAND_COLORS[b.band]);
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Where the user's own router really is, when DelphEye knows: from the home map, else from direction finding. */
interface OwnPlace {
  angle: number;
  distM: number;
  source: "map" | "direction";
}

function ownPlacement(own: Bss | undefined): OwnPlace | null {
  if (!own) return null;
  const key = own.hidden ? own.bssid : own.ssid;
  const plan = loadPlans()[key];
  if (plan) {
    const fit = plan.router ?? (plan.points.length >= 3 ? locate(plan.points, plan.w, plan.d, plan.walls ?? []) : null);
    const me = guessNow(key);
    if (fit && me && me.confidence !== "unsure" && me.place.x !== undefined && me.place.y !== undefined) {
      const dx = fit.x - me.place.x;
      const dz = fit.y - me.place.y;
      return { angle: Math.atan2(dz, dx), distM: Math.max(0.5, Math.hypot(dx, dz)), source: "map" };
    }
  }
  try {
    const d = JSON.parse(localStorage.getItem("wifi.direction") ?? "null");
    if (d && d.bssid === own.bssid && Date.now() - d.at < 30 * 86_400_000) {
      // Direction finding counts clockwise from "wall 1", which faces away from the camera here.
      return { angle: Math.PI * 1.5 + (d.angle * Math.PI) / 180, distM: own.distanceM, source: "direction" };
    }
  } catch {
    /* no direction kept */
  }
  return null;
}

/** Where an access point sits: the angle is symbolic (a network's radios stay together) unless known. */
function place(b: Bss, ownAt: OwnPlace | null): { angle: number; r: number; y: number } {
  if (b.connected && ownAt) return { angle: ownAt.angle, r: radius(ownAt.distM), y: LAYER[b.band] };
  const base = hash(b.hidden ? b.bssid : b.ssid) * Math.PI * 2;
  const spread = (hash(b.bssid) - 0.5) * 0.5;
  return { angle: b.connected ? Math.PI * 1.5 : base + spread, r: radius(b.distanceM), y: LAYER[b.band] };
}

interface Node {
  data: Bss;
  group: THREE.Group;
  orb: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  hit: THREE.Mesh;
  wave: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  stem: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  foot: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  halo?: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  angle: number;
  target: THREE.Vector3;
  size: number;
  flash: number;
  phase: number;
  alive: number;
  dying: boolean;
  label: HTMLDivElement;
}

const strength = (rssi: number) => Math.max(0, Math.min(1, (rssi + 95) / 60));

/** Signal → colour for the floor heat map (red weak, yellow fair, green strong). */
function heatRgb(rssi: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, (rssi + 88) / 40));
  const lerp = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number];
  const risk = [255, 153, 164];
  const warn = [252, 225, 0];
  const safe = [108, 203, 95];
  return k < 0.5 ? lerp(risk, warn, k * 2) : lerp(warn, safe, (k - 0.5) * 2);
}

export default function Echo3D({ onHunt }: { onHunt?: (bssid: string) => void }) {
  const { t } = useTranslation();
  const mount = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Bss | null>(null);
  const [hoverAt, setHoverAt] = useState({ x: 0, y: 0 });
  const [selected, setSelected] = useState<Bss | null>(null);
  const [rotate, setRotate] = useState(true);
  const [waves, setWaves] = useState(true);
  const [bands, setBands] = useState<Record<Band, boolean>>({ "2.4": true, "5": true, "6": true });
  const [mode, setMode] = useState<ColorMode>("band");
  const [home, setHome] = useState(false);
  const snap = useWifi((s) => s.snap);
  const overview = useRouter((s) => s.overview);
  const own = snap?.networks.find((n) => n.connected);
  const ownAt = useMemo(() => ownPlacement(own), [own?.bssid, snap?.at]);
  const plan: Saved | null = useMemo(() => {
    if (!own) return null;
    const p = loadPlans()[own.hidden ? own.bssid : own.ssid];
    return p && (p.points.length || (p.walls ?? []).length || p.image || p.router) ? p : null;
  }, [own?.bssid, home]);
  const opts = useRef({ rotate, waves, bands, mode, ownAt, home, selected: selected?.bssid ?? null });
  opts.current = { rotate, waves, bands, mode, ownAt, home, selected: selected?.bssid ?? null };
  const api = useRef<{ reset: () => void; apartment: (on: boolean) => void } | null>(null);

  useEffect(() => {
    const host = mount.current!;
    const labelHost = labels.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#080b10");
    scene.fog = new THREE.FogExp2("#080b10", 0.012);
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
    const homeCam = new THREE.Vector3(0, 30, 46);
    camera.position.copy(homeCam);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 6;
    controls.maxDistance = 110;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.target.set(0, 2.5, 0);
    controls.autoRotateSpeed = 0.35;

    // A smooth flight of the camera to a point of interest.
    let fly: { fromT: THREE.Vector3; toT: THREE.Vector3; fromC: THREE.Vector3; toC: THREE.Vector3; t0: number } | null = null;
    const flyTo = (target: THREE.Vector3, distance: number) => {
      const dir = camera.position.clone().sub(controls.target).normalize();
      fly = { fromT: controls.target.clone(), toT: target.clone(), fromC: camera.position.clone(), toC: target.clone().add(dir.multiplyScalar(distance)).setY(target.y + distance * 0.55), t0: performance.now() };
    };

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.12);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);

    // Everything of the "air" view lives in one group, hidden in the apartment view.
    const air = new THREE.Group();
    scene.add(air);

    // ── ground: soft disc, distance rings, spokes ──
    const maxR = radius(60);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 256;
    const g2 = canvas.getContext("2d")!;
    const grad = g2.createRadialGradient(128, 128, 0, 128, 128, 128);
    grad.addColorStop(0, "rgba(76,194,255,0.16)");
    grad.addColorStop(0.6, "rgba(76,194,255,0.04)");
    grad.addColorStop(1, "rgba(76,194,255,0)");
    g2.fillStyle = grad;
    g2.fillRect(0, 0, 256, 256);
    const disc = new THREE.Mesh(keep(new THREE.CircleGeometry(maxR, 96)), keep(new THREE.MeshBasicMaterial({ map: keep(new THREE.CanvasTexture(canvas)), transparent: true, depthWrite: false })));
    disc.rotation.x = -Math.PI / 2;
    air.add(disc);

    const ringLabels: { el: HTMLDivElement; pos: THREE.Vector3; air: boolean }[] = [];
    const addLabel = (text: string, pos: THREE.Vector3, className: string, inAir = true) => {
      const el = document.createElement("div");
      el.className = `pointer-events-none absolute whitespace-nowrap ${className}`;
      el.textContent = text;
      labelHost.appendChild(el);
      const item = { el, pos, air: inAir };
      ringLabels.push(item);
      return item;
    };
    for (const m of RINGS) {
      const r = radius(m);
      const pts = new THREE.EllipseCurve(0, 0, r, r).getPoints(128).map((p) => new THREE.Vector3(p.x, 0.02, p.y));
      air.add(new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineBasicMaterial({ color: "#2d4a63", transparent: true, opacity: 0.8 }))));
      addLabel(`${m} ${t("wifi.m")}`, new THREE.Vector3(r * 0.71, 0.05, r * 0.71), "num text-[10px] text-[#5d7a92]");
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      air.add(
        new THREE.Line(
          keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(Math.cos(a) * 1.5, 0.02, Math.sin(a) * 1.5), new THREE.Vector3(Math.cos(a) * maxR, 0.02, Math.sin(a) * maxR)])),
          keep(new THREE.LineBasicMaterial({ color: "#1d3144", transparent: true, opacity: 0.7 })),
        ),
      );
    }
    // Band layers: faint rings at their heights, each with its name.
    for (const band of ["2.4", "5", "6"] as Band[]) {
      const pts = new THREE.EllipseCurve(0, 0, maxR * 0.98, maxR * 0.98).getPoints(160).map((p) => new THREE.Vector3(p.x, LAYER[band], p.y));
      air.add(new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineBasicMaterial({ color: BAND_COLORS[band], transparent: true, opacity: 0.16 }))));
      const label = addLabel(`${band.replace(".", ",")} ${t("wifi.ghz")}`, new THREE.Vector3(-maxR * 0.98, LAYER[band], 0), "rounded px-1.5 py-0.5 text-[11px] font-medium");
      label.el.style.color = BAND_COLORS[band];
      label.el.style.background = "rgba(8,11,16,0.7)";
    }

    // ── you ──
    const you = new THREE.Mesh(keep(new THREE.SphereGeometry(0.7, 32, 16)), keep(new THREE.MeshBasicMaterial({ color: "#e8f6ff" })));
    you.position.y = 0.7;
    air.add(you);
    const pings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    const pingGeo = keep(new THREE.RingGeometry(0.96, 1, 96));
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(pingGeo, keep(new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));
      p.rotation.x = -Math.PI / 2;
      p.position.y = 0.05;
      air.add(p);
      pings.push(p);
    }

    // ── radar sweep ──
    const sweep = new THREE.Group();
    const fan = new THREE.Mesh(keep(new THREE.CircleGeometry(maxR, 64, 0, 0.55)), keep(new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0.08, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));
    fan.rotation.x = -Math.PI / 2;
    fan.position.y = 0.04;
    sweep.add(fan);
    sweep.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.06, 0), new THREE.Vector3(maxR, 0.06, 0)])), keep(new THREE.LineBasicMaterial({ color: "#9fdcff", transparent: true, opacity: 0.7 }))));
    air.add(sweep);

    // ── dust ──
    const dustGeo = keep(new THREE.BufferGeometry());
    const dust = new Float32Array(900 * 3);
    for (let i = 0; i < 900; i++) {
      const r = Math.sqrt(Math.random()) * maxR * 1.1;
      const a = Math.random() * Math.PI * 2;
      dust.set([Math.cos(a) * r, Math.random() * 14, Math.sin(a) * r], i * 3);
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dust, 3));
    const dustPts = new THREE.Points(dustGeo, keep(new THREE.PointsMaterial({ color: "#6fb8e6", size: 0.07, transparent: true, opacity: 0.45, depthWrite: false })));
    scene.add(dustPts);

    // ── access points ──
    const nodes = new Map<string, Node>();
    const orbGeo = keep(new THREE.SphereGeometry(1, 32, 16));
    const hitGeo = keep(new THREE.SphereGeometry(1.7, 12, 8));
    const waveGeo = keep(new THREE.SphereGeometry(1, 32, 16));
    const footGeo = keep(new THREE.RingGeometry(0.35, 0.5, 32));
    const haloGeo = keep(new THREE.TorusGeometry(1.7, 0.06, 8, 64));
    const hitMat = keep(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));

    const sync = (list: Bss[]) => {
      const seen = new Set<string>();
      for (const b of list) {
        seen.add(b.bssid);
        const { angle, r, y } = place(b, opts.current.ownAt);
        const target = new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r);
        const size = 0.32 + strength(b.rssi) * 0.75 + (b.connected ? 0.25 : 0);
        let n = nodes.get(b.bssid);
        if (!n) {
          const group = new THREE.Group();
          group.position.copy(target).setY(0);
          const c = colourOf(b, opts.current.mode);
          const orb = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: c.clone(), transparent: true }));
          const hit = new THREE.Mesh(hitGeo, hitMat);
          hit.userData.bssid = b.bssid;
          const wave = new THREE.Mesh(waveGeo, new THREE.MeshBasicMaterial({ color: c.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
          const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]), new THREE.LineBasicMaterial({ color: c.clone(), transparent: true, opacity: 0.35 }));
          const foot = new THREE.Mesh(footGeo, new THREE.MeshBasicMaterial({ color: c.clone(), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
          foot.rotation.x = -Math.PI / 2;
          group.add(orb, hit, wave, stem, foot);
          let halo: Node["halo"];
          if (b.connected) {
            halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0.9 }));
            halo.rotation.x = Math.PI / 2;
            group.add(halo);
          }
          air.add(group);
          const label = document.createElement("div");
          label.className = "pointer-events-none absolute whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] backdrop-blur-sm transition-opacity";
          labelHost.appendChild(label);
          n = { data: b, group, orb, hit, wave, stem, foot, halo, angle, target, size, flash: 0, phase: Math.random() * 3, alive: 0, dying: false, label };
          nodes.set(b.bssid, n);
        }
        n.data = b;
        n.angle = angle;
        n.target = target;
        n.size = size;
        n.dying = false;
        n.label.textContent = `${nameOf(b, t("wifi.hidden"))} · ${b.rssi}`;
        n.label.style.color = b.connected ? "#e6f6ff" : "#aab6c4";
        n.label.style.background = b.connected ? "rgba(76,194,255,0.22)" : "rgba(12,16,22,0.55)";
      }
      for (const [id, n] of nodes) if (!seen.has(id)) n.dying = true;
    };
    sync(useWifi.getState().snap?.networks ?? []);
    const unsub = useWifi.subscribe((s, prev) => s.snap !== prev.snap && s.snap && sync(s.snap.networks));

    // ── the network's own devices, round the user's router (from Professional mode) ──
    interface Dev {
      mac: string;
      name: string;
      angle: number;
      r: number;
      dot: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
      line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
      label: HTMLDivElement;
    }
    const devs = new Map<string, Dev>();
    const devGeo = keep(new THREE.SphereGeometry(0.28, 16, 12));
    const syncDevices = () => {
      const o = useRouter.getState().overview;
      const want = new Set<string>();
      for (const c of o?.clients ?? []) {
        if (!c.online || c.rssi === null) continue;
        want.add(c.mac);
        const distM = Math.min(40, Math.max(0.5, 10 ** ((-40 - c.rssi) / 30)));
        let d = devs.get(c.mac);
        if (!d) {
          const dot = new THREE.Mesh(devGeo, new THREE.MeshBasicMaterial({ color: "#d6f1ff" }));
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: "#7fd6ff", transparent: true, opacity: 0.35 }));
          air.add(dot, line);
          const label = document.createElement("div");
          label.className = "pointer-events-none absolute whitespace-nowrap rounded px-1 text-[10px] text-[#bfe9ff] transition-opacity";
          label.style.background = "rgba(8,11,16,0.6)";
          labelHost.appendChild(label);
          d = { mac: c.mac, name: "", angle: hash(c.mac) * Math.PI * 2, r: 0, dot, line, label };
          devs.set(c.mac, d);
        }
        d.name = c.name || c.vendor || c.mac;
        d.r = Math.max(1.2, radius(distM) * 0.55);
        d.label.textContent = `${d.name} · ~${distM < 10 ? distM.toFixed(1) : Math.round(distM)} ${t("wifi.m")}`;
      }
      for (const [mac, d] of devs)
        if (!want.has(mac)) {
          air.remove(d.dot, d.line);
          d.dot.material.dispose();
          d.line.geometry.dispose();
          d.line.material.dispose();
          d.label.remove();
          devs.delete(mac);
        }
    };
    syncDevices();
    const unsubRouter = useRouter.subscribe((s, prev) => s.overview !== prev.overview && syncDevices());

    // ── the apartment view: the home map as a floor with walls, the router, the user ──
    let apt: {
      group: THREE.Group;
      dispose: () => void;
      labels: { el: HTMLDivElement; pos: THREE.Vector3 }[];
      router: THREE.Vector3 | null;
      you: THREE.Object3D | null;
      wave: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null;
      phone: { obj: THREE.Group; key: string; X: (x: number) => number; Z: (y: number) => number; s: number };
    } | null = null;
    const buildApartment = (plan: Saved, key: string) => {
      const group = new THREE.Group();
      const own: { dispose: () => void }[] = [];
      const k = <T extends { dispose: () => void }>(x: T) => (own.push(x), x);
      const s = 28 / Math.max(plan.w, plan.d);
      const X = (x: number) => (x - plan.w / 2) * s;
      const Z = (y: number) => (y - plan.d / 2) * s;
      const aptLabels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
      const label = (text: string, pos: THREE.Vector3, colour: string) => {
        const el = document.createElement("div");
        el.className = "pointer-events-none absolute whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium";
        el.style.color = colour;
        el.style.background = "rgba(8,11,16,0.7)";
        el.textContent = text;
        labelHost.appendChild(el);
        aptLabels.push({ el, pos });
      };

      // Floor: the plan photo, the heat map and a metre grid, painted on one texture.
      const cw = 1024;
      const ch = Math.max(64, Math.round((cw * plan.d) / plan.w));
      const cnv = document.createElement("canvas");
      cnv.width = cw;
      cnv.height = ch;
      const ctx = cnv.getContext("2d")!;
      const tex = k(new THREE.CanvasTexture(cnv));
      tex.colorSpace = THREE.SRGBColorSpace;
      const paint = (img?: HTMLImageElement) => {
        ctx.fillStyle = "#0d1218";
        ctx.fillRect(0, 0, cw, ch);
        if (img) {
          ctx.globalAlpha = (plan.imageOpacity ?? 0.6) * 0.8;
          ctx.drawImage(img, 0, 0, cw, ch);
          ctx.globalAlpha = 1;
        }
        if (plan.points.length >= 2) {
          const step = 0.25;
          for (let x = 0; x < plan.w; x += step)
            for (let y = 0; y < plan.d; y += step) {
              const [r, g, b] = heatRgb(idw(plan.points, x + step / 2, y + step / 2));
              ctx.fillStyle = `rgba(${r},${g},${b},${img ? 0.28 : 0.42})`;
              ctx.fillRect((x / plan.w) * cw, (y / plan.d) * ch, (step / plan.w) * cw + 1, (step / plan.d) * ch + 1);
            }
        }
        ctx.strokeStyle = "rgba(120,150,180,0.18)";
        ctx.lineWidth = 1;
        for (let x = 0; x <= plan.w; x++) {
          ctx.beginPath();
          ctx.moveTo((x / plan.w) * cw, 0);
          ctx.lineTo((x / plan.w) * cw, ch);
          ctx.stroke();
        }
        for (let y = 0; y <= plan.d; y++) {
          ctx.beginPath();
          ctx.moveTo(0, (y / plan.d) * ch);
          ctx.lineTo(cw, (y / plan.d) * ch);
          ctx.stroke();
        }
        tex.needsUpdate = true;
      };
      paint();
      if (plan.image) {
        const img = new Image();
        img.onload = () => paint(img);
        img.src = plan.image;
      }
      const floor = new THREE.Mesh(k(new THREE.PlaneGeometry(plan.w * s, plan.d * s)), k(new THREE.MeshBasicMaterial({ map: tex })));
      floor.rotation.x = -Math.PI / 2;
      group.add(floor);

      // Walls cut away at about knee height (like a doll's house), so every room stays in view.
      const wallMat = k(new THREE.MeshBasicMaterial({ color: "#7f93a8", transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide }));
      const edgeMat = k(new THREE.LineBasicMaterial({ color: "#b9cde0", transparent: true, opacity: 0.55 }));
      const H = 0.9 * s;
      for (const w of plan.walls ?? []) {
        const len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1) * s;
        const box = k(new THREE.BoxGeometry(len, H, 0.12 * s));
        const mesh = new THREE.Mesh(box, wallMat);
        mesh.position.set((X(w.x1) + X(w.x2)) / 2, H / 2, (Z(w.y1) + Z(w.y2)) / 2);
        mesh.rotation.y = -Math.atan2(Z(w.y2) - Z(w.y1), X(w.x2) - X(w.x1));
        const edges = new THREE.LineSegments(k(new THREE.EdgesGeometry(box)), edgeMat);
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        group.add(mesh, edges);
      }

      // Measurements: small pillars, as tall as the signal is strong.
      for (const p of plan.points) {
        const h = (0.3 + strength(p.rssi) * 1.2) * s;
        const [r, g, b] = heatRgb(p.rssi);
        const pillar = new THREE.Mesh(k(new THREE.CylinderGeometry(0.1 * s, 0.1 * s, h, 16)), k(new THREE.MeshBasicMaterial({ color: new THREE.Color(`rgb(${r},${g},${b})`) })));
        pillar.position.set(X(p.x), h / 2, Z(p.y));
        group.add(pillar);
      }

      // The router: marked by hand, or where the measurements put it.
      const fit = plan.router ?? (plan.points.length >= 3 ? locate(plan.points, plan.w, plan.d, plan.walls ?? []) : null);
      let routerPos: THREE.Vector3 | null = null;
      let wave: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial> | null = null;
      if (fit) {
        routerPos = new THREE.Vector3(X(fit.x), 1.2 * s, Z(fit.y));
        const orb = new THREE.Mesh(k(new THREE.SphereGeometry(0.32 * s, 32, 16)), k(new THREE.MeshBasicMaterial({ color: OWN })));
        orb.position.copy(routerPos);
        wave = new THREE.Mesh(k(new THREE.SphereGeometry(1, 32, 16)), k(new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false })));
        wave.position.copy(routerPos);
        const stem = new THREE.Line(k(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(routerPos.x, 0, routerPos.z), routerPos])), k(new THREE.LineBasicMaterial({ color: OWN, transparent: true, opacity: 0.5 })));
        group.add(orb, wave, stem);
        label(plan.router ? t("wifi.echo.routerHere") : t("wifi.echo.routerLikely"), routerPos.clone().add(new THREE.Vector3(0, 0.6 * s, 0)), "#9fdcff");
        // The network's devices as rings on the floor round the router, at their estimated distances.
        const n: number = "n" in fit ? (fit.n as number) : 3;
        const p0: number = "p0" in fit ? (fit.p0 as number) : -40;
        for (const c of useRouter.getState().overview?.clients ?? []) {
          if (!c.online || c.rssi === null) continue;
          const r = Math.min(30, Math.max(0.5, 10 ** ((p0 - c.rssi) / (10 * n)))) * s;
          const ring = new THREE.Mesh(k(new THREE.RingGeometry(r - 0.04, r + 0.04, 96)), k(new THREE.MeshBasicMaterial({ color: "#7fd6ff", transparent: true, opacity: 0.45, side: THREE.DoubleSide })));
          ring.rotation.x = -Math.PI / 2;
          ring.position.set(routerPos.x, 0.03, routerPos.z);
          group.add(ring);
          const a = hash(c.mac) * Math.PI * 2;
          label(c.name || c.vendor || c.mac, new THREE.Vector3(routerPos.x + Math.cos(a) * r, 0.1, routerPos.z + Math.sin(a) * r), "#bfe9ff");
        }
      }

      // You, from "Where am I".
      let youObj: THREE.Object3D | null = null;
      const me = guessNow(key);
      if (me && me.confidence !== "unsure" && me.place.x !== undefined && me.place.y !== undefined) {
        const yo = new THREE.Group();
        const body = new THREE.Mesh(k(new THREE.CapsuleGeometry(0.18 * s, 0.6 * s, 6, 16)), k(new THREE.MeshBasicMaterial({ color: "#F5A35C" })));
        body.position.y = 0.5 * s;
        const ring = new THREE.Mesh(k(new THREE.RingGeometry(0.4 * s, 0.48 * s, 48)), k(new THREE.MeshBasicMaterial({ color: "#F5A35C", transparent: true, side: THREE.DoubleSide })));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.03;
        yo.add(body, ring);
        yo.position.set(X(me.place.x), 0, Z(me.place.y));
        group.add(yo);
        youObj = ring;
        label(`${t("wifi.echo.you")} · ${me.place.name}`, new THREE.Vector3(X(me.place.x), 1.4 * s, Z(me.place.y)), "#F5A35C");
      }

      // The phone (DelphEye Companion), moved each frame from its tracked position.
      const phoneObj = new THREE.Group();
      const pBody = new THREE.Mesh(k(new THREE.BoxGeometry(0.16 * s, 0.32 * s, 0.03 * s)), k(new THREE.MeshBasicMaterial({ color: "#5ed6d0" })));
      pBody.position.y = 1.1 * s;
      const pRing = new THREE.Mesh(k(new THREE.RingGeometry(0.3 * s, 0.38 * s, 48)), k(new THREE.MeshBasicMaterial({ color: "#5ed6d0", transparent: true, opacity: 0.8, side: THREE.DoubleSide })));
      pRing.rotation.x = -Math.PI / 2;
      pRing.position.y = 0.04;
      const pDir = new THREE.Mesh(k(new THREE.ConeGeometry(0.12 * s, 0.4 * s, 16)), k(new THREE.MeshBasicMaterial({ color: "#5ed6d0" })));
      pDir.rotation.x = -Math.PI / 2;
      pDir.position.set(0, 0.06, -0.55 * s);
      phoneObj.add(pBody, pRing, pDir);
      phoneObj.visible = false;
      group.add(phoneObj);

      scene.add(group);
      return {
        group,
        labels: aptLabels,
        router: routerPos,
        you: youObj,
        wave,
        phone: { obj: phoneObj, key, X, Z, s },
        dispose: () => {
          scene.remove(group);
          own.forEach((o) => o.dispose());
          aptLabels.forEach((l) => l.el.remove());
        },
      };
    };

    const setApartment = (on: boolean) => {
      apt?.dispose();
      apt = null;
      air.visible = !on;
      for (const d of devs.values()) d.label.style.display = on ? "none" : "";
      for (const n of nodes.values()) n.label.style.display = on ? "none" : "";
      for (const l of ringLabels) l.el.style.display = on ? "none" : "";
      bloom.strength = on ? 0.12 : 0.85;
      scene.fog = on ? null : new THREE.FogExp2("#080b10", 0.012);
      if (on) {
        const o = useWifi.getState().snap?.networks.find((n) => n.connected);
        const key = o ? (o.hidden ? o.bssid : o.ssid) : "";
        const plan = loadPlans()[key];
        if (plan) apt = buildApartment(plan, key);
        fly = null;
        camera.position.set(0, 34, 36);
        controls.target.set(0, 0, 1);
      } else {
        camera.position.copy(homeCam);
        controls.target.set(0, 2.5, 0);
      }
    };
    api.current = {
      reset: () => {
        fly = null;
        if (opts.current.home) {
          camera.position.set(0, 34, 36);
          controls.target.set(0, 0, 1);
        } else {
          camera.position.copy(homeCam);
          controls.target.set(0, 2.5, 0);
        }
      },
      apartment: setApartment,
    };

    // ── interaction ──
    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2(9, 9);
    let hovered: string | null = null;
    let down = { x: 0, y: 0 };
    const onMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      setHoverAt({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const onLeave = () => pointer.set(9, 9);
    const onDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY };
      fly = null;
    };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      const n = hovered ? nodes.get(hovered) : null;
      setSelected(n?.data ?? null);
      if (n) flyTo(new THREE.Vector3(n.group.position.x, n.orb.position.y, n.group.position.z), 14);
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerleave", onLeave);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    const resize = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloom.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // ── frame loop ──
    const clock = new THREE.Clock();
    const v = new THREE.Vector3();
    let raf = 0;
    const toScreen = (p: THREE.Vector3, w: number, h: number) => {
      v.copy(p).project(camera);
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h, front: v.z < 1 };
    };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const time = clock.elapsedTime;
      const { rotate, waves, bands, mode, home } = opts.current;
      controls.autoRotate = rotate && !fly;
      if (fly) {
        const k = Math.min(1, (performance.now() - fly.t0) / 1100);
        const e = 1 - Math.pow(1 - k, 3);
        controls.target.lerpVectors(fly.fromT, fly.toT, e);
        camera.position.lerpVectors(fly.fromC, fly.toC, e);
        if (k >= 1) fly = null;
      }
      controls.update();
      const w = host.clientWidth;
      const h = host.clientHeight;

      if (home && apt) {
        if (apt.wave && apt.router) {
          const k = (time / 2.2) % 1;
          apt.wave.scale.setScalar(1 + k * 14);
          apt.wave.material.opacity = (1 - k) * 0.18;
        }
        if (apt.you) apt.you.scale.setScalar(1 + Math.sin(time * 3) * 0.12);
        const pp = usePhoneMap.getState().pos[apt.phone.key];
        const on = !!pp && phoneLive(usePhone.getState());
        apt.phone.obj.visible = on;
        if (on && pp) {
          apt.phone.obj.position.lerp(new THREE.Vector3(apt.phone.X(pp.x), 0, apt.phone.Z(pp.y)), 1 - Math.exp(-dt * 6));
          if (pp.heading !== null) apt.phone.obj.rotation.y = (-pp.heading * Math.PI) / 180;
          // The ring shows how sure the particle filter is: wide when unsure.
          const ring = apt.phone.obj.children[1];
          const want = Math.max(1, Math.min(10, (pp.spread ?? 0) / 0.34));
          ring.scale.setScalar(ring.scale.x + (want - ring.scale.x) * (1 - Math.exp(-dt * 3)));
        }
        for (const l of apt.labels) {
          const p = toScreen(l.pos, w, h);
          l.el.style.opacity = p.front ? "1" : "0";
          l.el.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y}px)`;
        }
        composer.render();
        return;
      }

      const sweepAngle = (time * 0.9) % (Math.PI * 2);
      sweep.rotation.y = -sweepAngle;
      dustPts.rotation.y = time * 0.01;
      you.scale.setScalar(1 + Math.sin(time * 3) * 0.06);
      pings.forEach((p, i) => {
        const k = (time * 0.45 + i / 3) % 1;
        p.scale.setScalar(1 + k * maxR);
        p.material.opacity = (1 - k) * 0.35;
      });

      ray.setFromCamera(pointer, camera);
      const hits = ray.intersectObjects([...nodes.values()].filter((n) => n.group.visible).map((n) => n.hit), false);
      const now = hits[0]?.object.userData.bssid ?? null;
      if (now !== hovered) {
        hovered = now;
        setHover(now ? (nodes.get(now)?.data ?? null) : null);
        renderer.domElement.style.cursor = now ? "pointer" : "grab";
      }

      const ranked = [...nodes.values()].filter((n) => !n.dying).sort((a, b) => Number(b.data.connected) - Number(a.data.connected) || b.data.rssi - a.data.rssi);
      const labelled = new Set(ranked.slice(0, 10).map((n) => n.data.bssid));
      let ownNode: Node | null = null;

      for (const [id, n] of nodes) {
        n.alive = THREE.MathUtils.clamp(n.alive + (n.dying ? -dt : dt) * 1.5, 0, 1);
        if (n.dying && n.alive === 0) {
          air.remove(n.group);
          n.orb.material.dispose();
          n.wave.material.dispose();
          n.stem.material.dispose();
          n.stem.geometry.dispose();
          n.foot.material.dispose();
          n.halo?.material.dispose();
          n.label.remove();
          nodes.delete(id);
          continue;
        }
        if (n.data.connected) ownNode = n;
        const visible = bands[n.data.band];
        n.group.visible = visible;
        n.group.position.lerp(new THREE.Vector3(n.target.x, 0, n.target.z), 1 - Math.exp(-dt * 2.5));
        const y = n.target.y * (0.25 + 0.75 * n.alive);
        n.orb.position.y = y;
        n.hit.position.y = y;
        n.wave.position.y = y;
        n.halo?.position.setY(y);
        n.stem.scale.y = y;
        const a = (Math.atan2(n.group.position.z, n.group.position.x) + Math.PI * 2) % (Math.PI * 2);
        const behind = (sweepAngle - a + Math.PI * 2) % (Math.PI * 2);
        if (behind < 0.08) n.flash = 1;
        n.flash = Math.max(0, n.flash - dt * 1.4);
        const isHover = id === hovered || id === opts.current.selected;
        const pulse = 1 + Math.sin(time * 2 + n.phase) * 0.04;
        n.orb.scale.setScalar(n.size * pulse * (isHover ? 1.25 : 1) * (0.2 + 0.8 * n.alive));
        n.orb.material.opacity = n.alive;
        const base = colourOf(n.data, mode);
        n.orb.material.color.copy(base).multiplyScalar(1 + n.flash * 1.6 + (isHover ? 0.8 : 0));
        n.wave.material.color.copy(base);
        n.stem.material.color.copy(base);
        n.foot.material.color.copy(base);
        if (n.halo) {
          n.halo.rotation.z = time * 0.8;
          n.halo.scale.setScalar(n.size * 1.05);
        }
        if (waves) {
          const period = Math.max(1.2, (n.data.beaconMs || 102) / 40);
          const k = ((time + n.phase) / period) % 1;
          n.wave.visible = true;
          n.wave.scale.setScalar(n.size * (1 + k * (2 + strength(n.data.rssi) * 9)));
          n.wave.material.opacity = (1 - k) * 0.16 * (0.4 + strength(n.data.rssi)) * n.alive;
        } else n.wave.visible = false;
        n.foot.material.opacity = 0.5 * n.alive;
        n.stem.material.opacity = 0.3 * n.alive;
        const p = toScreen(new THREE.Vector3(n.group.position.x, y + n.size + 0.9, n.group.position.z), w, h);
        n.label.dataset.x = String(p.x);
        n.label.dataset.y = String(p.y);
        n.label.dataset.ok = visible && (labelled.has(id) || isHover) && n.alive > 0.5 && p.front ? "1" : "";
      }

      // Devices circle the user's router, at the router's height.
      const ownRef: Node | null = ownNode;
      for (const d of devs.values()) {
        const show = !!ownRef && ownRef.group.visible;
        d.dot.visible = d.line.visible = show;
        if (!ownRef || !show) {
          d.label.style.opacity = "0";
          continue;
        }
        const cy = ownRef.orb.position.y;
        const ang = d.angle + time * 0.05;
        const pos = new THREE.Vector3(ownRef.group.position.x + Math.cos(ang) * d.r, cy, ownRef.group.position.z + Math.sin(ang) * d.r);
        d.dot.position.copy(pos);
        d.line.geometry.setFromPoints([new THREE.Vector3(ownRef.group.position.x, cy, ownRef.group.position.z), pos]);
        const p = toScreen(pos.clone().setY(cy + 0.6), w, h);
        d.label.style.opacity = p.front ? "0.9" : "0";
        d.label.style.transform = `translate(-50%, -100%) translate(${p.x}px, ${p.y}px)`;
      }

      const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
      const order = [...nodes.values()].sort(
        (a, b) => Number(b.data.bssid === hovered) - Number(a.data.bssid === hovered) || Number(b.data.connected) - Number(a.data.connected) || b.data.rssi - a.data.rssi,
      );
      for (const n of order) {
        const x = Number(n.label.dataset.x);
        const y = Number(n.label.dataset.y);
        const lw = n.label.offsetWidth || 80;
        const r = { x0: x - lw / 2 - 3, x1: x + lw / 2 + 3, y0: y - 22, y1: y };
        const free = !placed.some((p) => p.x0 < r.x1 && r.x0 < p.x1 && p.y0 < r.y1 && r.y0 < p.y1);
        if (n.label.dataset.ok && free) {
          placed.push(r);
          n.label.style.opacity = "1";
          n.label.style.transform = `translate(-50%, -100%) translate(${x}px, ${y}px)`;
        } else n.label.style.opacity = "0";
      }
      for (const r of ringLabels) {
        const p = toScreen(r.pos, w, h);
        r.el.style.transform = `translate(-50%, -50%) translate(${p.x}px, ${p.y}px)`;
        r.el.style.opacity = p.front ? "1" : "0";
      }
      composer.render();
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      unsubRouter();
      ro.disconnect();
      controls.dispose();
      apt?.dispose();
      for (const n of nodes.values()) {
        n.orb.material.dispose();
        n.wave.material.dispose();
        n.stem.material.dispose();
        n.stem.geometry.dispose();
        n.foot.material.dispose();
        n.halo?.material.dispose();
      }
      for (const d of devs.values()) {
        d.dot.material.dispose();
        d.line.geometry.dispose();
        d.line.material.dispose();
      }
      disposables.forEach((d) => d.dispose());
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelHost.replaceChildren();
    };
  }, [t]);

  // The scene reacts to the apartment switch without being rebuilt.
  useEffect(() => api.current?.apartment(home), [home]);
  // A new placement of the user's router moves it at the next scan; nudge it now.
  useEffect(() => {
    const s = useWifi.getState().snap;
    if (s) useWifi.setState({ snap: { ...s } });
  }, [ownAt?.angle, ownAt?.distM]);

  const counts = (["2.4", "5", "6"] as Band[]).map((b) => [b, snap?.networks.filter((n) => n.band === b).length ?? 0] as const);
  const shown = selected ? (snap?.networks.find((n) => n.bssid === selected.bssid) ?? selected) : null;
  const legend: [string, string][] =
    mode === "security"
      ? [
          [t("wifi.echo.legend.risky"), "#ff6b7a"],
          [t("wifi.echo.legend.tkip"), "#fce100"],
          ["WPA2", "#4CC2FF"],
          ["WPA3", "#6ccb5f"],
          [t("wifi.echo.legend.enterprise"), "#B48CFF"],
        ]
      : mode === "gen"
        ? [
            ["Wi-Fi 4", "#F5A35C"],
            ["Wi-Fi 5", "#4CC2FF"],
            ["Wi-Fi 6", "#6ccb5f"],
            ["Wi-Fi 7", "#B48CFF"],
            [t("wifi.legacy"), "#8b95a5"],
          ]
        : [];

  return (
    <div className="grid gap-3" data-testid="wifi-echo">
      <div className="relative h-[600px] overflow-hidden rounded-card border border-line">
        <div ref={mount} className="absolute inset-0" />
        <div ref={labels} className="pointer-events-none absolute inset-0 overflow-hidden" />

        {!home && (
          <div className="absolute left-3 top-3 grid gap-1.5 rounded-xl border border-white/5 bg-black/40 p-3 text-[11px] backdrop-blur-md">
            <div className="flex gap-1 rounded-lg bg-black/30 p-0.5">
              {(["band", "security", "gen"] as ColorMode[]).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={`rounded-md px-2 py-0.5 ${mode === m ? "bg-[#4CC2FF]/25 text-[#cfeeff]" : "text-[#8ea3b6] hover:text-white"}`} data-testid={`echo-mode-${m}`}>
                  {t(`wifi.echo.mode.${m}`)}
                </button>
              ))}
            </div>
            <div className="mt-1 text-[10px] uppercase tracking-wider text-[#7d93a8]">{t("wifi.echo.layers")}</div>
            {counts.map(([b, c]) => (
              <label key={b} className="flex cursor-pointer items-center gap-2 text-[#c8d3de]">
                <input type="checkbox" checked={bands[b]} onChange={() => setBands({ ...bands, [b]: !bands[b] })} className="accent-[#4CC2FF]" />
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: mode === "band" ? BAND_COLORS[b] : "#5d7a92", boxShadow: mode === "band" ? `0 0 8px ${BAND_COLORS[b]}` : undefined }} />
                {b} {t("wifi.ghz")}
                <span className="num ml-auto pl-3 text-[#7d93a8]">{c}</span>
              </label>
            ))}
            {legend.length > 0 && (
              <div className="mt-1 grid gap-1 border-t border-white/5 pt-1.5">
                {legend.map(([l, c]) => (
                  <div key={l} className="flex items-center gap-2 text-[#c8d3de]">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: c, boxShadow: `0 0 8px ${c}` }} />
                    {l}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-1 flex items-center gap-2 text-[#c8d3de]">
              <span className="h-2.5 w-2.5 rounded-full border-2 border-[#4CC2FF]" />
              {t("wifi.echo.yours")}
              {ownAt && <span className="text-[#6ccb5f]">· {t(`wifi.echo.placed.${ownAt.source}`)}</span>}
            </div>
            {overview && (
              <div className="flex items-center gap-2 text-[#c8d3de]">
                <span className="h-2 w-2 rounded-full bg-[#d6f1ff]" />
                {t("wifi.echo.devices", { count: overview.clients.filter((c) => c.online && c.rssi !== null).length })}
              </div>
            )}
          </div>
        )}
        <div className="absolute right-3 top-3 flex gap-1.5">
          {(
            [
              [home, () => setHome(!home), Building2, t("wifi.echo.apartment"), !plan],
              [rotate, () => setRotate(!rotate), rotate ? Pause : Play, t("wifi.echo.rotate"), false],
              [waves, () => setWaves(!waves), Waves, t("wifi.echo.waves"), home],
              [false, () => api.current?.reset(), RotateCcw, t("wifi.echo.reset"), false],
            ] as const
          ).map(([on, act, Icon, label, disabled]) => (
            <button
              key={label}
              onClick={act}
              disabled={disabled}
              title={disabled && Icon === Building2 ? t("wifi.echo.apartmentNeedsMap") : label}
              aria-label={label}
              data-testid={Icon === Building2 ? "echo-apartment" : undefined}
              className={`flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/5 px-2 backdrop-blur-md transition-colors disabled:opacity-35 ${on ? "bg-[#4CC2FF]/20 text-[#9fdcff]" : "bg-black/40 text-[#aab6c4] hover:text-white"}`}
            >
              <Icon size={14} />
              {Icon === Building2 && <span className="text-[11px]">{label}</span>}
            </button>
          ))}
        </div>

        {home && (
          <div className="absolute left-3 top-3 max-w-[300px] rounded-xl border border-white/5 bg-black/45 p-3 text-[11px] leading-relaxed text-[#c8d3de] backdrop-blur-md" data-testid="echo-apartment-legend">
            <div className="mb-1 text-[12px] font-medium text-white">{t("wifi.echo.apartment")}</div>
            {t("wifi.echo.apartmentText")}
          </div>
        )}

        {!home && hover && !shown && (
          <div className="pointer-events-none absolute z-10 rounded-lg border border-white/10 bg-black/70 px-2.5 py-1.5 text-[11px] text-[#dce6ef] backdrop-blur-md" style={{ left: hoverAt.x + 14, top: hoverAt.y + 10 }}>
            <div className="font-medium">{nameOf(hover, t("wifi.hidden"))}</div>
            <div className="num text-[#8ea3b6]">
              {hover.rssi} dBm · {hover.band} {t("wifi.ghz")} · {t("wifi.channelN", { n: hover.channel })} · ~{hover.distanceM < 10 ? hover.distanceM.toFixed(1) : Math.round(hover.distanceM)} {t("wifi.m")}
            </div>
            <div className="text-[#6f8496]">{t("wifi.echo.clickHint")}</div>
          </div>
        )}

        {!home && shown && (
          <div className="absolute bottom-3 right-3 w-[270px] rounded-xl border border-white/10 bg-black/65 p-4 text-[12px] text-[#dce6ef] backdrop-blur-md" data-testid="echo-card">
            <button onClick={() => setSelected(null)} className="absolute right-2 top-2 text-[#8ea3b6] hover:text-white" aria-label={t("wifi.echo.close")}>
              <X size={14} />
            </button>
            <div className="pr-5 text-[14px] font-semibold">{nameOf(shown, t("wifi.hidden"))}</div>
            <div className="num text-[11px] text-[#8ea3b6]">{shown.bssid}</div>
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-[#8ea3b6]">{t("wifi.col.signal")}</dt>
              <dd className="num">{shown.rssi} dBm</dd>
              <dt className="text-[#8ea3b6]">{t("wifi.col.distance")}</dt>
              <dd className="num">
                ~{shown.distanceM < 10 ? shown.distanceM.toFixed(1) : Math.round(shown.distanceM)} {t("wifi.m")}{" "}
                <span className="text-[#6f8496]">({t("wifi.echo.range", { lo: Math.max(0.5, shown.distanceM / 2).toFixed(shown.distanceM < 4 ? 1 : 0), hi: Math.round(shown.distanceM * 2) })})</span>
              </dd>
              <dt className="text-[#8ea3b6]">{t("wifi.col.channel")}</dt>
              <dd className="num">
                {shown.band} {t("wifi.ghz")} · {shown.channel} · {shown.width} {t("wifi.mhz")}
              </dd>
              <dt className="text-[#8ea3b6]">{t("wifi.col.standard")}</dt>
              <dd>{shown.generation ? `Wi-Fi ${shown.generation}` : t("wifi.legacy")}</dd>
              <dt className="text-[#8ea3b6]">{t("wifi.col.security")}</dt>
              <dd>{t(`wifi.security.${shown.security}`)}</dd>
              {shown.stations !== null && (
                <>
                  <dt className="text-[#8ea3b6]">{t("wifi.col.stations")}</dt>
                  <dd className="num">{shown.stations}</dd>
                </>
              )}
            </dl>
            {onHunt && (
              <button onClick={() => onHunt(shown.bssid)} className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#4CC2FF]/20 py-1.5 text-[#9fdcff] hover:bg-[#4CC2FF]/30" data-testid="echo-hunt">
                <Crosshair size={13} />
                {t("wifi.echo.hunt")}
              </button>
            )}
          </div>
        )}
      </div>
      <p className="flex gap-2 text-[12px] leading-relaxed text-muted">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        {home ? t("wifi.echo.apartmentHonest") : t("wifi.echo.honest")}
      </p>
    </div>
  );
}
