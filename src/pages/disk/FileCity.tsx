import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { ArrowUp, Info, MapPin, Route, ShieldAlert, X } from "lucide-react";
import type { Ring } from "../../lib/disk";
import { useFmt } from "../../lib/format";
import { ROLE_COLOURS, knownKey, roleOf, type Role } from "./city";

interface Lot {
  ring: Ring;
  /** Path of the thing itself. */
  path: string;
  role: Role;
  /** The district (first level) it belongs to, its index. */
  district: number;
  /** Building (inside a district) or the district's own plot. */
  kind: "district" | "building";
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Districts: the angle range of their sector. Buildings: their facing. */
  a0: number;
  a1: number;
  rot: number;
}

interface Road {
  district: number;
  angle: number;
  width: number;
  life: number;
}

/** The ring city: a plaza in the middle, districts as sectors from R0 out to R1. */
const R0 = 4.2;
const R1 = 24;

const now = () => Date.now() / 1000;
const days = (mark: number) => (mark > 0 ? Math.max(0, (now() - mark) / 86400) : null);
/** How "alive" a branch is, 0–1: changed today → 1, untouched for two years → ~0. */
const life = (mark: number) => {
  const d = days(mark);
  return d === null ? 0.15 : Math.max(0.05, 1 - Math.log10(1 + d) / Math.log10(1 + 730));
};

const polar = (a: number, r: number) => ({ x: Math.sin(a) * r, z: -Math.cos(a) * r });

function plan(root: Ring, base: string): { lots: Lot[]; roads: Road[] } {
  const lots: Lot[] = [];
  const roads: Road[] = [];
  const kids = root.children.filter((c) => c.size > 0);
  const total = kids.reduce((a, k) => a + k.size, 0) + root.restSize;
  if (!total) return { lots, roads };
  // Each district gets a sector as wide as its share of the data, never thinner than a lane.
  const raw = kids.map((k) => Math.max(0.06, (k.size / total) * Math.PI * 2));
  const scale = (Math.PI * 2 * (1 - root.restSize / total)) / raw.reduce((a, b) => a + b, 0);
  const biggest = Math.max(1, ...kids.map((k) => k.size));
  const widths = kids.map((k) => 0.2 + 1.1 * Math.sqrt(k.size / biggest));
  let a = 0;
  kids.forEach((k, i) => {
    const span = raw[i] * scale;
    const a0 = a + 0.012;
    const a1 = a + span - 0.012;
    a += span;
    const path = `${base}\\${k.name}`;
    const role = roleOf(base, k.name);
    const mid = (a0 + a1) / 2;
    const c = polar(mid, (R0 + R1) / 2);
    lots.push({ ring: k, path, role, district: i, kind: "district", x: c.x, z: c.z, w: 0, d: 0, h: 0.1, a0, a1, rot: 0 });
    // The branch road runs along the district's leading edge, as wide as the data it carries.
    const width = widths[i];
    const nextWidth = widths[(i + 1) % kids.length];
    roads.push({ district: i, angle: a0, width, life: life(k.mark) });
    // Inside the sector: a slice per thing in the district, towers standing from the plaza outwards.
    const things = (k.isDir ? k.children : [k]).filter((t) => t.size > 0);
    const kTotal = things.reduce((s2, t) => s2 + t.size, 0) + (k.isDir ? k.restSize : 0) || 1;
    // Keep clear of the road: an angular margin at the middle radius.
    const margin = (width / 2 + 0.25) / ((R0 + R1) / 2);
    let b = a0 + margin;
    const room = Math.max(0.01, a1 - a0 - margin);
    for (const t of things) {
      const tSpan = (t.size / kTotal) * room;
      const b0 = b;
      const b1 = b + tSpan;
      b = b1;
      if (tSpan < 0.004) continue;
      const tPath = k.isDir ? `${path}\\${t.name}` : path;
      const tRole = k.isDir ? roleOf(path, t.name) : role;
      // Towers: what is inside this thing (one level further), largest nearest the plaza.
      const towers = (t.isDir ? t.children.filter((g) => g.size > 0) : []).sort((x, y) => y.size - x.size).slice(0, 14);
      const items: [Ring, string, Role][] = towers.length > 1 ? towers.map((g) => [g, `${tPath}\\${g.name}`, roleOf(tPath, g.name)]) : [[t, tPath, tRole]];
      // A polar grid over the whole slice: columns across it, rows from the plaza to the outskirts,
      // so a big district is a built-up block rather than one thin line of houses.
      const r0 = R0 + 0.9;
      const depth = R1 - 0.4 - r0;
      const span = b1 - b0;
      const cols = Math.max(1, Math.min(5, Math.round((span * (R0 + R1)) / 2 / 2.4)));
      const rows = Math.max(Math.round(depth / 2.6), Math.ceil(items.length / cols));
      const cells = cols * rows;
      // Each thing gets cells in proportion to its size, the largest nearest the plaza.
      const iSum = items.reduce((s, [g]) => s + g.size, 0) || 1;
      const list: [Ring, string, Role][] = [];
      // One each first, so nothing small is left out; the rest of the cells go by size.
      const spare = cells - items.length;
      const extra = items.map(([g]) => Math.floor((g.size / iSum) * spare));
      extra[0] += spare - extra.reduce((x, y) => x + y, 0);
      items.forEach((it, n) => {
        for (let m = 0; m <= extra[n]; m++) list.push(it);
      });
      const step = depth / rows;
      list.forEach(([g, gPath, gRole], n) => {
        const row = Math.floor(n / cols);
        const col = n % cols;
        const rc = r0 + (row + 0.5) * step;
        // The cell, clipped so nothing stands on this district's road or the next one's.
        const lo = Math.max(b0 + (col * span) / cols, a0 + (width / 2 + 0.2) / rc);
        const hi = Math.min(b0 + ((col + 1) * span) / cols, a1 + 0.024 - (nextWidth / 2 + 0.2) / rc);
        if (hi - lo <= 0.002) return;
        const ac = (lo + hi) / 2;
        const w = Math.max(0.05, Math.min((hi - lo) * rc * 0.74, 3.2));
        const d = Math.max(0.05, Math.min(step * 0.74, 3.2));
        // A little variety in height, the same every time for the same spot.
        const seed = Math.sin(n * 12.9898 + b0 * 78.233) * 43758.5453;
        const jitter = 0.75 + 0.5 * (seed - Math.floor(seed));
        const h = Math.min(0.25 + Math.log10(1 + g.size / 1e6) * 0.7, 0.4 + Math.sqrt(w * d) * 1.5) * jitter;
        const p = polar(ac, rc);
        lots.push({ ring: g, path: gPath, role: gRole, district: i, kind: "building", x: p.x, z: p.z, w, d, h, a0: b0, a1: b1, rot: -ac });
      });
    }
  });
  return { lots, roads };
}

/**
 * The file city: the folder as a town. Districts are its folders (area = size), buildings what is
 * inside them (height = how much data), lit windows how recently it changed, roads the branches
 * from the central plaza (width = how much data flows that way, traffic = how alive it is), and
 * red beacons the critical infrastructure Windows needs to run.
 */
export default function FileCity({ root, base, onOpen, onUp }: { root: Ring; base: string; onOpen: (id: number) => void; onUp: (() => void) | null }) {
  const { t, i18n } = useTranslation();
  const fmt = useFmt();
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef<HTMLDivElement>(null);
  const { lots, roads } = useMemo(() => plan(root, base), [root, base]);
  const [hover, setHover] = useState<Lot | null>(null);
  const [picked, setPicked] = useState<Lot | null>(null);
  const [legend, setLegend] = useState(() => {
    try {
      return localStorage.getItem("disk.cityLegend") === "1";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("disk.cityLegend", legend ? "1" : "0");
    } catch {
      /* this session only */
    }
  }, [legend]);
  const pickRef = useRef<Lot | null>(null);
  pickRef.current = picked;
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    setPicked(null);
    const el = host.current!;
    const labelHost = labels.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0b0f14, 55, 110);
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 300);
    camera.position.set(0, 56, 54);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.maxPolarAngle = Math.PI * 0.46;
    controls.minDistance = 8;
    controls.maxDistance = 90;
    controls.target.set(0, 0, 0);
    scene.add(new THREE.HemisphereLight(0xbcd7ff, 0x0b0f14, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(20, 40, 15);
    scene.add(sun);
    const trash: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (trash.push(x), x);

    // Ground and the central plaza (the folder itself), with a ring road around it.
    const ground = new THREE.Mesh(keep(new THREE.CircleGeometry(R1 + 4, 96)), keep(new THREE.MeshStandardMaterial({ color: 0x0f151d, roughness: 1 })));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    scene.add(ground);
    const grid = new THREE.PolarGridHelper(R1 + 3, 24, 8, 96, 0x1c2633, 0x141c26);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.55;
    scene.add(grid);
    const plaza = new THREE.Mesh(keep(new THREE.CylinderGeometry(R0 - 1.4, R0 - 1.2, 0.3, 64)), keep(new THREE.MeshStandardMaterial({ color: 0x4cc2ff, emissive: 0x4cc2ff, emissiveIntensity: 0.45, metalness: 0.5, roughness: 0.3 })));
    plaza.position.y = 0.15;
    scene.add(plaza);
    const ringRoad = new THREE.Mesh(keep(new THREE.RingGeometry(R0 - 1.0, R0 - 0.2, 96)), keep(new THREE.MeshStandardMaterial({ color: 0x2a3646, roughness: 0.9, side: THREE.DoubleSide })));
    ringRoad.rotation.x = -Math.PI / 2;
    ringRoad.position.y = 0.02;
    scene.add(ringRoad);

    // Roads: from the plaza out along each district's edge, width by data, plus moving traffic.
    const roadMat = keep(new THREE.MeshStandardMaterial({ color: 0x2a3646, roughness: 0.9 }));
    const lineMat = keep(new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.35 }));
    const traffic: { curve: THREE.Vector3[]; n: number; speed: number; colour: THREE.Color }[] = [];
    for (const r of roads) {
      const f = polar(r.angle, R0 - 0.6);
      const t2 = polar(r.angle, R1 + 0.5);
      const from = new THREE.Vector3(f.x, 0.03, f.z);
      const to = new THREE.Vector3(t2.x, 0.03, t2.z);
      const len = from.distanceTo(to);
      // A flat slab whose length runs along +z, turned about the vertical to point from the plaza outwards.
      const heading = Math.atan2(to.x - from.x, to.z - from.z);
      const road = new THREE.Mesh(keep(new THREE.BoxGeometry(r.width, 0.02, len)), roadMat);
      road.rotation.y = heading;
      road.position.set((from.x + to.x) / 2, 0.02, (from.z + to.z) / 2);
      scene.add(road);
      // A thin centre line, brighter on livelier branches.
      const centre = new THREE.Mesh(keep(new THREE.BoxGeometry(0.05, 0.01, len)), lineMat);
      centre.rotation.y = heading;
      centre.position.set(road.position.x, 0.04, road.position.z);
      scene.add(centre);
      traffic.push({ curve: [from, to], n: Math.max(1, Math.round(r.life * 9)), speed: 0.05 + r.life * 0.16, colour: new THREE.Color(ROLE_COLOURS[lots.find((l) => l.kind === "district" && l.district === r.district)?.role ?? "other"]) });
    }
    const carCount = traffic.reduce((a, x) => a + x.n, 0);
    const cars = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(0.09, 8, 6)), keep(new THREE.MeshBasicMaterial({ toneMapped: false })), Math.max(1, carCount));
    scene.add(cars);

    // District plots as sectors of the ring; buildings as one instanced mesh.
    const districts = lots.filter((l) => l.kind === "district");
    const buildings = lots.filter((l) => l.kind === "building");
    const plots: THREE.Mesh[] = [];
    for (const l of districts) {
      // RingGeometry's angles start at +x and run counter-clockwise; the city's run clockwise from north.
      const geo = keep(new THREE.RingGeometry(R0 + 0.2, R1, 48, 1, Math.PI / 2 - l.a1, l.a1 - l.a0));
      const plot = new THREE.Mesh(geo, keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(ROLE_COLOURS[l.role]).multiplyScalar(0.2), roughness: 0.9, side: THREE.DoubleSide })));
      plot.rotation.x = -Math.PI / 2;
      plot.position.y = 0.01;
      plot.userData.lot = l;
      scene.add(plot);
      plots.push(plot);
    }
    const houseGeo = keep(new THREE.BoxGeometry(1, 1, 1));
    houseGeo.translate(0, 0.5, 0);
    const houseMesh = new THREE.InstancedMesh(houseGeo, keep(new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.25 })), Math.max(1, buildings.length));
    const m = new THREE.Matrix4();
    const c = new THREE.Color();
    const q = new THREE.Quaternion();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const baseColour = (l: Lot) => c.set(ROLE_COLOURS[l.role]).multiplyScalar(0.35 + life(l.ring.mark) * 0.65);
    buildings.forEach((l, i) => {
      m.compose(new THREE.Vector3(l.x, 0.02, l.z), q.setFromAxisAngle(yAxis, l.rot), new THREE.Vector3(l.w, l.h, l.d));
      houseMesh.setMatrixAt(i, m);
      houseMesh.setColorAt(i, baseColour(l));
    });
    houseMesh.instanceColor!.needsUpdate = true;
    scene.add(houseMesh);

    // Critical infrastructure: a fence of light and a blinking beacon on top.
    const beacons: THREE.Mesh[] = [];
    for (const l of lots.filter((x) => x.role === "critical" && (x.kind === "district" || x.ring.size > root.size * 0.01))) {
      if (l.kind === "district") {
        // A red fence along the district's outer edge.
        const pts: THREE.Vector3[] = [];
        for (let k2 = 0; k2 <= 24; k2++) {
          const p = polar(l.a0 + ((l.a1 - l.a0) * k2) / 24, R1);
          pts.push(new THREE.Vector3(p.x, 0.25, p.z));
        }
        scene.add(new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineBasicMaterial({ color: 0xf0574d, transparent: true, opacity: 0.7 }))));
      }
      const beacon = new THREE.Mesh(keep(new THREE.SphereGeometry(0.18, 12, 8)), keep(new THREE.MeshBasicMaterial({ color: 0xff5a4f, toneMapped: false, transparent: true })));
      const at = l.kind === "district" ? polar((l.a0 + l.a1) / 2, R1 + 0.4) : { x: l.x, z: l.z };
      beacon.position.set(at.x, (l.kind === "building" ? l.h + 0.02 : 0.3) + 0.25, at.z);
      scene.add(beacon);
      beacons.push(beacon);
    }

    // The route to whatever is picked: a glowing line plaza → district → building.
    const routeMat = keep(new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.95 }));
    let route: THREE.Line | null = null;
    const showRoute = (l: Lot | null) => {
      if (route) {
        scene.remove(route);
        route.geometry.dispose();
        route = null;
      }
      if (!l) return;
      const d = districts.find((x) => x.district === l.district);
      const pts = [new THREE.Vector3(0, 0.35, 0)];
      if (d) {
        const r = l.kind === "building" ? Math.hypot(l.x, l.z) : (R0 + R1) / 2;
        const p0 = polar(d.a0, R0 - 0.6);
        const p1 = polar(d.a0, r);
        pts.push(new THREE.Vector3(p0.x, 0.35, p0.z), new THREE.Vector3(p1.x, 0.35, p1.z));
      }
      if (l.kind === "building") pts.push(new THREE.Vector3(l.x, 0.35, l.z), new THREE.Vector3(l.x, l.h + 0.4, l.z));
      else if (d) pts.push(new THREE.Vector3(d.x, 0.35, d.z));
      route = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), routeMat);
      scene.add(route);
    };

    // Labels for the larger districts.
    const shown = districts.filter((d) => d.a1 - d.a0 > 0.16).slice(0, 18);
    const labelEls = shown.map((d) => {
      const div = document.createElement("div");
      div.className = "pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[0.6875rem] font-medium";
      div.style.background = "rgba(8,11,16,0.72)";
      div.style.color = "#e6e9ee";
      div.style.border = `1px solid ${ROLE_COLOURS[d.role]}66`;
      div.textContent = d.ring.name;
      labelHost.appendChild(div);
      return { d, div };
    });

    const size = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    const ray = new THREE.Raycaster();
    const pointer = new THREE.Vector2(9, 9);
    let hovered: Lot | null = null;
    let downAt = { x: 0, y: 0 };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    const down = (e: PointerEvent) => (downAt = { x: e.clientX, y: e.clientY });
    const up = (e: PointerEvent) => {
      // A drag turns the camera; only a still click picks.
      if (Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) return;
      if (!hovered) {
        setPicked(null);
        showRoute(null);
        return;
      }
      setPicked(hovered);
      showRoute(hovered);
    };
    const dbl = () => {
      // A double click drives into a folder.
      const l = pickRef.current;
      if (l && l.ring.isDir && l.ring.id >= 0) openRef.current(l.ring.id);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointerup", up);
    el.addEventListener("dblclick", dbl);

    let visible = true;
    const io = new IntersectionObserver(([en]) => (visible = en.isIntersecting));
    io.observe(el);
    const clock = new THREE.Clock();
    let raf = 0;
    const v = new THREE.Vector3();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!visible || document.hidden) return;
      const time = clock.elapsedTime;
      controls.update();
      // Traffic flows along every road, more of it on the livelier branches.
      let k = 0;
      for (const tr of traffic) {
        for (let n = 0; n < tr.n; n++) {
          const s = (time * tr.speed + n / tr.n) % 1;
          v.lerpVectors(tr.curve[0], tr.curve[1], s);
          v.y = 0.12;
          m.makeTranslation(v.x, v.y, v.z);
          cars.setMatrixAt(k, m);
          cars.setColorAt(k, tr.colour);
          k++;
        }
      }
      cars.instanceMatrix.needsUpdate = true;
      if (cars.instanceColor) cars.instanceColor.needsUpdate = true;
      for (const b of beacons) (b.material as THREE.MeshBasicMaterial).opacity = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(time * 4));
      plaza.rotation.y += dt * 0.3;
      // Hover: buildings first, then district plots.
      ray.setFromCamera(pointer, camera);
      let now: Lot | null = null;
      const hb = ray.intersectObject(houseMesh, false)[0];
      if (hb?.instanceId !== undefined) now = buildings[hb.instanceId];
      else {
        const hp = ray.intersectObjects(plots, false)[0];
        if (hp) now = hp.object.userData.lot as Lot;
      }
      if (now !== hovered) {
        if (hovered?.kind === "building") houseMesh.setColorAt(buildings.indexOf(hovered), baseColour(hovered));
        hovered = now;
        if (now?.kind === "building") houseMesh.setColorAt(buildings.indexOf(now), c.set("#ffffff"));
        houseMesh.instanceColor!.needsUpdate = true;
        setHover(now);
        el.style.cursor = now ? "pointer" : "grab";
      }
      const w = el.clientWidth;
      const h = el.clientHeight;
      for (const { d, div } of labelEls) {
        const e = polar((d.a0 + d.a1) / 2, R1 + 1.6);
        v.set(e.x, 0.6, e.z).project(camera);
        div.style.transform = `translate(-50%, -50%) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
        div.style.opacity = v.z < 1 ? "1" : "0";
      }
      renderer.render(scene, camera);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("dblclick", dbl);
      controls.dispose();
      showRoute(null);
      for (const d of trash) d.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      houseMesh.dispose();
      cars.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labelHost.innerHTML = "";
    };
  }, [lots, roads, root]);

  const info = picked ?? hover;
  const age = info ? days(info.ring.mark) : null;
  const known = info ? knownKey(info.ring.name) : null;
  const share = info && root.size ? info.ring.size / root.size : 0;
  const ageText = (d: number | null) =>
    d === null ? t("disk.city.ageUnknown") : d < 1 ? t("disk.city.ageToday") : d < 30 ? t("disk.city.ageDays", { count: Math.round(d) }) : d < 365 ? t("disk.city.ageMonths", { count: Math.round(d / 30) }) : t("disk.city.ageYears", { count: Math.round((d / 365) * 10) / 10 });

  return (
    <div className="relative overflow-hidden rounded-card border border-line bg-[#0b0f14] text-[#e6e9ee]" data-testid="file-city">
      <div ref={host} className="h-[35rem] w-full" />
      <div ref={labels} className="pointer-events-none absolute inset-0" />

      {/* The legend: how to read the city. */}
      <div className={`absolute left-3 top-3 rounded-xl border border-white/10 bg-black/55 text-[0.6875rem] leading-relaxed backdrop-blur-md ${legend ? "w-[14.375rem] p-3" : "p-1.5"}`}>
        <button onClick={() => setLegend(!legend)} className="flex items-center gap-1.5 text-[0.75rem] font-medium" aria-expanded={legend}>
          <Info size={13} className="text-[#4cc2ff]" />
          {legend ? t("disk.city.legendTitle") : t("disk.city.legendShort")}
        </button>
        {legend && (
          <>
        <ul className="mt-1.5 grid gap-1 text-white/70">
          <li>▦ {t("disk.city.legend.district")}</li>
          <li>▮ {t("disk.city.legend.building")}</li>
          <li>✦ {t("disk.city.legend.windows")}</li>
          <li>═ {t("disk.city.legend.road")}</li>
          <li>• {t("disk.city.legend.traffic")}</li>
          <li className="text-[#ff8a80]">● {t("disk.city.legend.beacon")}</li>
        </ul>
        <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5">
          {(Object.keys(ROLE_COLOURS) as Role[]).map((r) => (
            <span key={r} className="flex items-center gap-1.5 text-white/75">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: ROLE_COLOURS[r] }} />
              {t(`disk.city.role.${r}`)}
            </span>
          ))}
        </div>
        <div className="mt-2 text-white/45">{t("disk.city.controls")}</div>
          </>
        )}
      </div>

      {onUp && (
        <button onClick={onUp} className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-3 py-1.5 text-[0.75rem] backdrop-blur-md hover:bg-black/70">
          <ArrowUp size={13} />
          {t("disk.city.up")}
        </button>
      )}

      {/* What is under the pointer or picked: what it is, where, why, and what to do. */}
      <AnimatePresence>
        {info && (
          <motion.div
            key={info.path}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-3 right-3 w-[20.625rem] rounded-xl border border-white/10 bg-black/70 p-4 text-[0.75rem] backdrop-blur-md"
            data-testid="city-info"
          >
            {picked && (
              <button onClick={() => setPicked(null)} className="absolute right-2 top-2 text-white/50 hover:text-white" aria-label={t("feedback.close")}>
                <X size={14} />
              </button>
            )}
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: ROLE_COLOURS[info.role] }} />
              <span className="truncate text-[0.875rem] font-semibold">{info.ring.name}</span>
              {info.role === "critical" && <ShieldAlert size={14} className="shrink-0 text-[#ff8a80]" />}
            </div>
            <div className="mt-1 flex items-start gap-1.5 text-[0.6875rem] text-white/55">
              <Route size={12} className="mt-0.5 shrink-0" />
              <span className="num break-all">{info.path}</span>
            </div>
            <dl className="mt-3 grid grid-cols-[6.875rem_1fr] gap-y-1 text-[0.75rem]">
              <dt className="text-white/50">{t("disk.city.size")}</dt>
              <dd className="num">
                {fmt.bytes(info.ring.size)} · {(share * 100).toFixed(share < 0.01 ? 2 : 1)}%
              </dd>
              <dt className="text-white/50">{t("disk.city.flow")}</dt>
              <dd>{t(`disk.city.flowLevel.${share > 0.25 ? "main" : share > 0.05 ? "big" : share > 0.005 ? "side" : "lane"}`)}</dd>
              <dt className="text-white/50">{t("disk.city.changed")}</dt>
              <dd>{ageText(age)}</dd>
              <dt className="text-white/50">{t("disk.city.zone")}</dt>
              <dd>{t(`disk.city.role.${info.role}`)}</dd>
            </dl>
            <p className="mt-3 leading-relaxed text-white/80">{known ? t(`disk.city.known.${known}`) : t(`disk.city.roleText.${info.role}`)}</p>
            <p className="mt-2 flex gap-1.5 leading-relaxed text-white/60">
              <MapPin size={12} className="mt-0.5 shrink-0 text-[#4cc2ff]" />
              {t(`disk.city.todo.${info.role}`)}
            </p>
            {info.ring.isDir && info.ring.id >= 0 && (
              <button onClick={() => onOpen(info.ring.id)} className="mt-3 w-full rounded-lg bg-white/10 py-1.5 text-[0.75rem] hover:bg-white/15">
                {t("disk.city.enter")}
              </button>
            )}
            {!picked && <div className="mt-2 text-center text-[0.625rem] text-white/40">{t("disk.city.clickHint", { lang: i18n.language })}</div>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
