import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { Crosshair, Info, Pause, Play, RotateCcw, Waves, X } from "lucide-react";
import { BAND_COLORS, nameOf, useWifi, type Band, type Bss } from "../../lib/wifi";

/** Distance in metres → radius in the scene: logarithmic, so 1 m and 50 m both fit. */
const radius = (m: number) => 6 * Math.log(1 + m);
const RINGS = [1, 2, 5, 10, 20, 50];
const LAYER: Record<Band, number> = { "2.4": 1.2, "5": 4.4, "6": 7.6 };
const OWN = new THREE.Color("#4CC2FF");

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** Where an access point sits: the angle is symbolic (a network's radios stay together). */
function place(b: Bss): { angle: number; r: number; y: number } {
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
  const opts = useRef({ rotate, waves, bands });
  opts.current = { rotate, waves, bands };
  const api = useRef<{ reset: () => void } | null>(null);
  const snap = useWifi((s) => s.snap);

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
    const home = new THREE.Vector3(0, 30, 46);
    camera.position.copy(home);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.06;
    controls.minDistance = 10;
    controls.maxDistance = 110;
    controls.maxPolarAngle = Math.PI * 0.47;
    controls.target.set(0, 2.5, 0);
    controls.autoRotateSpeed = 0.35;
    api.current = {
      reset: () => {
        camera.position.copy(home);
        controls.target.set(0, 2.5, 0);
      },
    };

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.85, 0.55, 0.12);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);

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
    const disc = new THREE.Mesh(
      keep(new THREE.CircleGeometry(maxR, 96)),
      keep(new THREE.MeshBasicMaterial({ map: keep(new THREE.CanvasTexture(canvas)), transparent: true, depthWrite: false })),
    );
    disc.rotation.x = -Math.PI / 2;
    scene.add(disc);

    const ringLabels: { el: HTMLDivElement; pos: THREE.Vector3 }[] = [];
    for (const m of RINGS) {
      const r = radius(m);
      const pts = new THREE.EllipseCurve(0, 0, r, r).getPoints(128).map((p) => new THREE.Vector3(p.x, 0.02, p.y));
      const ring = new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineBasicMaterial({ color: "#2d4a63", transparent: true, opacity: 0.8 })));
      scene.add(ring);
      const el = document.createElement("div");
      el.className = "num pointer-events-none absolute text-[10px] text-[#5d7a92]";
      el.textContent = `${m} ${t("wifi.m")}`;
      labelHost.appendChild(el);
      ringLabels.push({ el, pos: new THREE.Vector3(r * 0.71, 0.05, r * 0.71) });
    }
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      const spoke = new THREE.Line(
        keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(Math.cos(a) * 1.5, 0.02, Math.sin(a) * 1.5), new THREE.Vector3(Math.cos(a) * maxR, 0.02, Math.sin(a) * maxR)])),
        keep(new THREE.LineBasicMaterial({ color: "#1d3144", transparent: true, opacity: 0.7 })),
      );
      scene.add(spoke);
    }
    // band layers: faint rings at their heights
    for (const band of ["2.4", "5", "6"] as Band[]) {
      const pts = new THREE.EllipseCurve(0, 0, maxR * 0.98, maxR * 0.98).getPoints(160).map((p) => new THREE.Vector3(p.x, LAYER[band], p.y));
      const layer = new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineBasicMaterial({ color: BAND_COLORS[band], transparent: true, opacity: 0.12 })));
      scene.add(layer);
    }

    // ── you ──
    const you = new THREE.Mesh(keep(new THREE.SphereGeometry(0.7, 32, 16)), keep(new THREE.MeshBasicMaterial({ color: "#e8f6ff" })));
    you.position.y = 0.7;
    scene.add(you);
    const pings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
    const pingGeo = keep(new THREE.RingGeometry(0.96, 1, 96));
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(pingGeo, keep(new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })));
      p.rotation.x = -Math.PI / 2;
      p.position.y = 0.05;
      scene.add(p);
      pings.push(p);
    }

    // ── radar sweep ──
    const sweep = new THREE.Group();
    const fan = new THREE.Mesh(
      keep(new THREE.CircleGeometry(maxR, 64, 0, 0.55)),
      keep(new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0.08, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })),
    );
    fan.rotation.x = -Math.PI / 2;
    fan.position.y = 0.04;
    sweep.add(fan);
    const edge = new THREE.Line(
      keep(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.06, 0), new THREE.Vector3(maxR, 0.06, 0)])),
      keep(new THREE.LineBasicMaterial({ color: "#9fdcff", transparent: true, opacity: 0.7 })),
    );
    sweep.add(edge);
    scene.add(sweep);

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
        const { angle, r, y } = place(b);
        const target = new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r);
        const colour = b.connected ? OWN : new THREE.Color(BAND_COLORS[b.band]);
        const size = 0.32 + strength(b.rssi) * 0.75 + (b.connected ? 0.25 : 0);
        let n = nodes.get(b.bssid);
        if (!n) {
          const group = new THREE.Group();
          group.position.copy(target).setY(0);
          const orb = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({ color: colour.clone(), transparent: true }));
          const hit = new THREE.Mesh(hitGeo, hitMat);
          hit.userData.bssid = b.bssid;
          const wave = new THREE.Mesh(waveGeo, new THREE.MeshBasicMaterial({ color: colour.clone(), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
          const stem = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)]),
            new THREE.LineBasicMaterial({ color: colour.clone(), transparent: true, opacity: 0.35 }),
          );
          const foot = new THREE.Mesh(footGeo, new THREE.MeshBasicMaterial({ color: colour.clone(), transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
          foot.rotation.x = -Math.PI / 2;
          group.add(orb, hit, wave, stem, foot);
          let halo: Node["halo"];
          if (b.connected) {
            halo = new THREE.Mesh(haloGeo, new THREE.MeshBasicMaterial({ color: OWN, transparent: true, opacity: 0.9 }));
            halo.rotation.x = Math.PI / 2;
            group.add(halo);
          }
          scene.add(group);
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
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY });
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
      setSelected(hovered ? (nodes.get(hovered)?.data ?? null) : null);
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
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (document.hidden) return;
      const dt = Math.min(clock.getDelta(), 0.05);
      const time = clock.elapsedTime;
      const { rotate, waves, bands } = opts.current;
      controls.autoRotate = rotate;
      controls.update();

      const sweepAngle = (time * 0.9) % (Math.PI * 2);
      sweep.rotation.y = -sweepAngle;
      dustPts.rotation.y = time * 0.01;
      you.scale.setScalar(1 + Math.sin(time * 3) * 0.06);
      pings.forEach((p, i) => {
        const k = ((time * 0.45 + i / 3) % 1);
        p.scale.setScalar(1 + k * maxR);
        p.material.opacity = (1 - k) * 0.35;
      });

      // hover
      ray.setFromCamera(pointer, camera);
      const hits = ray.intersectObjects([...nodes.values()].filter((n) => n.group.visible).map((n) => n.hit), false);
      const now = hits[0]?.object.userData.bssid ?? null;
      if (now !== hovered) {
        hovered = now;
        setHover(now ? (nodes.get(now)?.data ?? null) : null);
        renderer.domElement.style.cursor = now ? "pointer" : "grab";
      }

      // ranks for labels
      const ranked = [...nodes.values()].filter((n) => !n.dying).sort((a, b) => Number(b.data.connected) - Number(a.data.connected) || b.data.rssi - a.data.rssi);
      const labelled = new Set(ranked.slice(0, 10).map((n) => n.data.bssid));
      const w = host.clientWidth;
      const h = host.clientHeight;

      for (const [id, n] of nodes) {
        n.alive = THREE.MathUtils.clamp(n.alive + (n.dying ? -dt : dt) * 1.5, 0, 1);
        if (n.dying && n.alive === 0) {
          scene.remove(n.group);
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
        const visible = bands[n.data.band];
        n.group.visible = visible;
        // glide to the new place; rise out of the ground when it first appears
        n.group.position.lerp(new THREE.Vector3(n.target.x, 0, n.target.z), 1 - Math.exp(-dt * 2.5));
        const y = n.target.y * (0.25 + 0.75 * n.alive);
        n.orb.position.y = y;
        n.hit.position.y = y;
        n.wave.position.y = y;
        n.halo?.position.setY(y);
        n.stem.scale.y = y;
        // the sweep lights up whatever it passes
        const a = (Math.atan2(n.group.position.z, n.group.position.x) + Math.PI * 2) % (Math.PI * 2);
        const behind = (sweepAngle - a + Math.PI * 2) % (Math.PI * 2);
        if (behind < 0.08) n.flash = 1;
        n.flash = Math.max(0, n.flash - dt * 1.4);
        const isHover = id === hovered;
        const pulse = 1 + Math.sin(time * 2 + n.phase) * 0.04;
        n.orb.scale.setScalar(n.size * pulse * (isHover ? 1.25 : 1) * (0.2 + 0.8 * n.alive));
        n.orb.material.opacity = n.alive;
        const base = n.data.connected ? OWN : new THREE.Color(BAND_COLORS[n.data.band]);
        n.orb.material.color.copy(base).multiplyScalar(1 + n.flash * 1.6 + (isHover ? 0.8 : 0));
        if (n.halo) {
          n.halo.rotation.z = time * 0.8;
          n.halo.scale.setScalar(n.size * 1.05);
        }
        // the echo: a sphere swelling out at a rate set by the beacon, as loud as the signal
        if (waves) {
          const period = Math.max(1.2, (n.data.beaconMs || 102) / 40);
          const k = ((time + n.phase) / period) % 1;
          n.wave.visible = true;
          n.wave.scale.setScalar(n.size * (1 + k * (2 + strength(n.data.rssi) * 9)));
          n.wave.material.opacity = (1 - k) * 0.16 * (0.4 + strength(n.data.rssi)) * n.alive;
        } else n.wave.visible = false;
        n.foot.material.opacity = 0.5 * n.alive;
        n.stem.material.opacity = 0.3 * n.alive;

        // label position; whether it shows is decided below, once overlaps are known
        v.set(n.group.position.x, y + n.size + 0.9, n.group.position.z).project(camera);
        n.label.dataset.x = String(((v.x + 1) / 2) * w);
        n.label.dataset.y = String(((1 - v.y) / 2) * h);
        n.label.dataset.ok = visible && (labelled.has(id) || isHover) && n.alive > 0.5 && v.z < 1 ? "1" : "";
      }
      // Labels in order of importance (hovered, yours, loudest); one that would cover an
      // earlier one stays hidden.
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
        v.copy(r.pos).project(camera);
        r.el.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
        r.el.style.opacity = v.z < 1 ? "1" : "0";
      }
      composer.render();
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      unsub();
      ro.disconnect();
      controls.dispose();
      for (const n of nodes.values()) {
        n.orb.material.dispose();
        n.wave.material.dispose();
        n.stem.material.dispose();
        n.stem.geometry.dispose();
        n.foot.material.dispose();
        n.halo?.material.dispose();
      }
      disposables.forEach((d) => d.dispose());
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelHost.replaceChildren();
    };
  }, [t]);

  const counts = (["2.4", "5", "6"] as Band[]).map((b) => [b, snap?.networks.filter((n) => n.band === b).length ?? 0] as const);
  const shown = selected ? (snap?.networks.find((n) => n.bssid === selected.bssid) ?? selected) : null;

  return (
    <div className="grid gap-3" data-testid="wifi-echo">
      <div className="relative h-[600px] overflow-hidden rounded-card border border-line">
        <div ref={mount} className="absolute inset-0" />
        <div ref={labels} className="pointer-events-none absolute inset-0 overflow-hidden" />

        {/* legend and controls */}
        <div className="absolute left-3 top-3 grid gap-1.5 rounded-xl border border-white/5 bg-black/40 p-3 text-[11px] backdrop-blur-md">
          <div className="text-[10px] uppercase tracking-wider text-[#7d93a8]">{t("wifi.echo.layers")}</div>
          {counts.map(([b, c]) => (
            <label key={b} className="flex cursor-pointer items-center gap-2 text-[#c8d3de]">
              <input type="checkbox" checked={bands[b]} onChange={() => setBands({ ...bands, [b]: !bands[b] })} className="accent-[#4CC2FF]" />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: BAND_COLORS[b], boxShadow: `0 0 8px ${BAND_COLORS[b]}` }} />
              {b} {t("wifi.ghz")}
              <span className="num ml-auto pl-3 text-[#7d93a8]">{c}</span>
            </label>
          ))}
          <div className="mt-1 flex items-center gap-2 text-[#c8d3de]">
            <span className="h-2.5 w-2.5 rounded-full bg-[#4CC2FF] shadow-[0_0_8px_#4CC2FF]" />
            {t("wifi.echo.yours")}
          </div>
        </div>
        <div className="absolute right-3 top-3 flex gap-1.5">
          {(
            [
              [rotate, () => setRotate(!rotate), rotate ? Pause : Play, t("wifi.echo.rotate")],
              [waves, () => setWaves(!waves), Waves, t("wifi.echo.waves")],
              [false, () => api.current?.reset(), RotateCcw, t("wifi.echo.reset")],
            ] as const
          ).map(([on, act, Icon, label]) => (
            <button
              key={label}
              onClick={act}
              title={label}
              aria-label={label}
              className={`flex h-8 w-8 items-center justify-center rounded-lg border border-white/5 backdrop-blur-md transition-colors ${on ? "bg-[#4CC2FF]/20 text-[#9fdcff]" : "bg-black/40 text-[#aab6c4] hover:text-white"}`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>

        {hover && !shown && (
          <div
            className="pointer-events-none absolute z-10 rounded-lg border border-white/10 bg-black/70 px-2.5 py-1.5 text-[11px] text-[#dce6ef] backdrop-blur-md"
            style={{ left: hoverAt.x + 14, top: hoverAt.y + 10 }}
          >
            <div className="font-medium">{nameOf(hover, t("wifi.hidden"))}</div>
            <div className="num text-[#8ea3b6]">
              {hover.rssi} dBm · {hover.band} {t("wifi.ghz")} · {t("wifi.channelN", { n: hover.channel })} · ~{hover.distanceM < 10 ? hover.distanceM.toFixed(1) : Math.round(hover.distanceM)} {t("wifi.m")}
            </div>
            <div className="text-[#6f8496]">{t("wifi.echo.clickHint")}</div>
          </div>
        )}

        {shown && (
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
              <button
                onClick={() => onHunt(shown.bssid)}
                className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#4CC2FF]/20 py-1.5 text-[#9fdcff] hover:bg-[#4CC2FF]/30"
                data-testid="echo-hunt"
              >
                <Crosshair size={13} />
                {t("wifi.echo.hunt")}
              </button>
            )}
          </div>
        )}
      </div>
      <p className="flex gap-2 text-[12px] leading-relaxed text-muted">
        <Info size={14} className="mt-0.5 shrink-0 text-accent" />
        {t("wifi.echo.honest")}
      </p>
    </div>
  );
}
