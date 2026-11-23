import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export interface ShieldPart {
  id: string;
  title: string;
  /** 0–100, or null for a part that is a tool rather than a score. */
  score: number | null;
  status: string;
}

const GREEN = new THREE.Color("#3fb950");
const AMBER = new THREE.Color("#e3b341");
const RED = new THREE.Color("#f0574d");
const BLUE = new THREE.Color("#4cc2ff");
const colourOf = (score: number | null) => (score === null ? BLUE : score >= 85 ? GREEN : score >= 60 ? AMBER : RED);
const cssOf = (score: number | null) => `#${colourOf(score).getHexString()}`;

/** The outline of a heater shield, centred near the origin, as a closed polygon. */
function outline(): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  const W = 2.15;
  const top = 2.35;
  const shoulder = 0.35;
  const tip = -2.75;
  // Top edge, a gentle arch from left to right.
  for (let i = 0; i <= 24; i++) {
    const x = -W + (2 * W * i) / 24;
    pts.push(new THREE.Vector2(x, top + 0.22 * Math.cos((x / W) * (Math.PI / 2))));
  }
  // Right side down to the shoulder, then a curve to the tip.
  pts.push(new THREE.Vector2(W, shoulder));
  for (let i = 1; i <= 32; i++) {
    const t = i / 32;
    // Quadratic Bézier: (W, shoulder) → control (W, tip*0.55) → (0, tip).
    const x = (1 - t) * (1 - t) * W + 2 * (1 - t) * t * W * 0.92 + t * t * 0;
    const y = (1 - t) * (1 - t) * shoulder + 2 * (1 - t) * t * (tip * 0.62) + t * t * tip;
    pts.push(new THREE.Vector2(x, y));
  }
  // Mirror for the left half, back up to the start.
  for (let i = 31; i >= 0; i--) {
    const p = pts[25 + i];
    pts.push(new THREE.Vector2(-p.x, p.y));
  }
  return pts;
}

/** Where a ray from `c` at angle `a` leaves the polygon. */
function hit(poly: THREE.Vector2[], c: THREE.Vector2, a: number): THREE.Vector2 {
  const d = new THREE.Vector2(Math.cos(a), Math.sin(a));
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const e = new THREE.Vector2().subVectors(q, p);
    const den = d.x * e.y - d.y * e.x;
    if (Math.abs(den) < 1e-9) continue;
    const w = new THREE.Vector2().subVectors(p, c);
    const t = (w.x * e.y - w.y * e.x) / den;
    const u = (w.x * d.y - w.y * d.x) / den;
    if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return new THREE.Vector2(c.x + d.x * best, c.y + d.y * best);
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * A 3D shield made of one piece per protection area around a central seal with the overall
 * score. Hovering lifts a piece; clicking flies the camera into it and calls `onSelect`.
 */
export default function Shield3D({
  parts,
  score,
  selected,
  onSelect,
}: {
  parts: ShieldPart[];
  score: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const labelHost = useRef<HTMLDivElement>(null);
  const selectRef = useRef(selected);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [hover, setHover] = useState<string | null>(null);
  // Commands from React to the scene.
  const api = useRef<{ fly: (id: string | null) => void } | null>(null);

  useEffect(() => {
    if (selectRef.current !== selected) {
      selectRef.current = selected;
      api.current?.fly(selected);
    }
  }, [selected]);

  useEffect(() => {
    const el = host.current!;
    const labels = labelHost.current!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    scene.environmentIntensity = 0.32;
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
    const HOME = new THREE.Vector3(0, -0.1, 12.5);
    camera.position.copy(HOME);
    const lookAt = new THREE.Vector3(0, -0.1, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(3, 5, 7);
    scene.add(key);
    const rim = new THREE.PointLight(0x4cc2ff, 30, 30);
    rim.position.set(-5, 2, 4);
    scene.add(rim);
    const under = new THREE.PointLight(0xffffff, 8, 20);
    under.position.set(2, -4, 5);
    scene.add(under);

    const shield = new THREE.Group();
    scene.add(shield);
    const disposables: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);

    const poly = outline();
    const centre = new THREE.Vector2(0, 0.25);

    // The back plate: the whole shield, a little larger, dark metal with a glowing rim.
    const backShape = new THREE.Shape(poly.map((p) => new THREE.Vector2(p.x * 1.06, (p.y - centre.y) * 1.06 + centre.y)));
    const backGeo = keep(new THREE.ExtrudeGeometry(backShape, { depth: 0.34, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 6 }));
    backGeo.translate(0, 0, -0.56);
    const backMat = keep(new THREE.MeshStandardMaterial({ color: 0x151b24, metalness: 0.9, roughness: 0.32 }));
    shield.add(new THREE.Mesh(backGeo, backMat));
    // A raised frame around the pieces: the outline with the inside cut out.
    const scaleAround = (k: number) => poly.map((p) => new THREE.Vector2(p.x * k, (p.y - centre.y) * k + centre.y));
    const frameShape = new THREE.Shape(scaleAround(1.05));
    frameShape.holes.push(new THREE.Path([...scaleAround(0.965)].reverse()));
    const frameGeo = keep(new THREE.ExtrudeGeometry(frameShape, { depth: 0.36, bevelEnabled: true, bevelThickness: 0.08, bevelSize: 0.035, bevelSegments: 5, curveSegments: 6 }));
    frameGeo.translate(0, 0, -0.2);
    const frameMat = keep(new THREE.MeshStandardMaterial({ color: 0x2a3442, metalness: 0.95, roughness: 0.22 }));
    shield.add(new THREE.Mesh(frameGeo, frameMat));
    const rimLine = new THREE.LineSegments(keep(new THREE.EdgesGeometry(frameGeo, 50)), keep(new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.55 })));
    shield.add(rimLine);
    // Rivets along the frame.
    const rivetGeo = keep(new THREE.SphereGeometry(0.065, 16, 12));
    const rivetMat = keep(new THREE.MeshStandardMaterial({ color: 0x9fb3c8, metalness: 1, roughness: 0.25 }));
    const ring = scaleAround(1.008);
    let walked = 0;
    for (let i = 1; i < ring.length; i++) {
      walked += ring[i].distanceTo(ring[i - 1]);
      if (walked >= 0.62) {
        walked = 0;
        const r = new THREE.Mesh(rivetGeo, rivetMat);
        r.position.set(ring[i].x, ring[i].y, 0.24);
        r.scale.z = 0.6;
        shield.add(r);
      }
    }

    // One piece per area, as a wedge from the seal to the shield's edge.
    const R0 = 1.02;
    const gap = THREE.MathUtils.degToRad(2.4);
    const n = parts.length;
    type Piece = { id: string; mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; panel: THREE.MeshStandardMaterial; edges: THREE.LineSegments; base: THREE.Vector3; dir: THREE.Vector3; lift: number; fade: number; label: HTMLDivElement };
    const pieces: Piece[] = [];
    parts.forEach((part, i) => {
      // Clockwise from the top.
      const a0 = Math.PI / 2 - (i * 2 * Math.PI) / n - gap / 2;
      const a1 = Math.PI / 2 - ((i + 1) * 2 * Math.PI) / n + gap / 2;
      const pts: THREE.Vector2[] = [];
      const steps = 28;
      for (let k = 0; k <= steps; k++) {
        const a = a0 + ((a1 - a0) * k) / steps;
        pts.push(new THREE.Vector2(centre.x + Math.cos(a) * R0, centre.y + Math.sin(a) * R0));
      }
      for (let k = steps; k >= 0; k--) {
        const a = a0 + ((a1 - a0) * k) / steps;
        const p = hit(poly, centre, a);
        // Pull the outer edge in a touch, so the back plate's rim shows around the pieces.
        pts.push(new THREE.Vector2(centre.x + (p.x - centre.x) * 0.955, centre.y + (p.y - centre.y) * 0.955));
      }
      const geo = keep(new THREE.ExtrudeGeometry(new THREE.Shape(pts), { depth: 0.3, bevelEnabled: true, bevelThickness: 0.1, bevelSize: 0.06, bevelSegments: 6, curveSegments: 4 }));
      geo.computeBoundingBox();
      const mid = new THREE.Vector3();
      geo.boundingBox!.getCenter(mid);
      // The label sits at the middle of the wedge's span, not its box.
      const am = (a0 + a1) / 2;
      const outer = hit(poly, centre, am);
      const lx = centre.x + Math.cos(am) * (R0 + (outer.distanceTo(centre) - R0) * 0.55);
      const ly = centre.y + Math.sin(am) * (R0 + (outer.distanceTo(centre) - R0) * 0.55);
      geo.translate(-lx, -ly, -0.13);
      const colour = colourOf(part.score);
      const mat = keep(new THREE.MeshStandardMaterial({ color: colour.clone().multiplyScalar(0.42), metalness: 0.75, roughness: 0.3, emissive: colour, emissiveIntensity: 0.12, transparent: true }));
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(lx, ly, 0);
      mesh.userData.id = part.id;
      const edges = new THREE.LineSegments(keep(new THREE.EdgesGeometry(geo, 35)), keep(new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.5 })));
      mesh.add(edges);
      // A raised inner panel: the same wedge drawn in towards its middle, standing on the face.
      const inset = pts.map((p) => new THREE.Vector2(lx + (p.x - lx) * 0.78, ly + (p.y - ly) * 0.78));
      const panelGeo = keep(new THREE.ExtrudeGeometry(new THREE.Shape(inset), { depth: 0.05, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.04, bevelSegments: 4, curveSegments: 4 }));
      panelGeo.translate(-lx, -ly, 0.27);
      const panelMat = keep(new THREE.MeshStandardMaterial({ color: colour.clone().multiplyScalar(0.55), metalness: 0.7, roughness: 0.3, emissive: colour, emissiveIntensity: 0.1, transparent: true }));
      const panel = new THREE.Mesh(panelGeo, panelMat);
      mesh.add(panel);
      shield.add(mesh);
      const label = document.createElement("div");
      label.className = "pointer-events-none absolute left-0 top-0 select-none text-center transition-opacity duration-300";
      label.innerHTML = `<div style="font-size:12px;font-weight:600;color:#fff;text-shadow:0 1px 6px rgba(0,0,0,.85)">${part.title}</div>${
        part.score !== null ? `<div style="margin-top:2px;display:inline-block;min-width:34px;padding:1px 8px;border-radius:999px;font-size:13px;font-weight:700;color:#fff;background:rgba(8,11,16,.62);box-shadow:inset 0 0 0 1.5px ${cssOf(part.score)}, 0 0 12px ${cssOf(part.score)}66">${part.score}</div>` : ""
      }`;
      labels.appendChild(label);
      pieces.push({ id: part.id, mesh, mat, panel: panelMat, edges, base: new THREE.Vector3(lx, ly, 0), dir: new THREE.Vector3(Math.cos(am), Math.sin(am), 0), lift: 0, fade: 1, label });
    });

    // The seal in the middle: a raised disc with a glowing ring in the overall score's colour.
    const sealColour = colourOf(score);
    const seal = new THREE.Group();
    seal.position.set(centre.x, centre.y, 0);
    const disc = new THREE.Mesh(keep(new THREE.CylinderGeometry(R0 - 0.1, R0 - 0.06, 0.5, 64)), keep(new THREE.MeshStandardMaterial({ color: 0x1b222c, metalness: 0.9, roughness: 0.25 })));
    disc.rotation.x = Math.PI / 2;
    seal.add(disc);
    const dome = new THREE.Mesh(keep(new THREE.SphereGeometry(R0 - 0.2, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2)), keep(new THREE.MeshStandardMaterial({ color: 0x232c38, metalness: 0.9, roughness: 0.18 })));
    dome.rotation.x = Math.PI / 2;
    dome.scale.y = 0.28;
    dome.position.z = 0.2;
    seal.add(dome);
    const sealRing = new THREE.Mesh(keep(new THREE.TorusGeometry(R0 - 0.12, 0.05, 16, 96)), keep(new THREE.MeshStandardMaterial({ color: sealColour, emissive: sealColour, emissiveIntensity: 1.4 })));
    sealRing.position.z = 0.26;
    seal.add(sealRing);
    // An arc showing the score itself.
    const arc = new THREE.Mesh(
      keep(new THREE.TorusGeometry(R0 - 0.26, 0.03, 12, 96, (Math.PI * 2 * score) / 100)),
      keep(new THREE.MeshStandardMaterial({ color: sealColour, emissive: sealColour, emissiveIntensity: 2 })),
    );
    arc.position.z = 0.27;
    arc.rotation.z = Math.PI / 2;
    arc.scale.x = -1;
    seal.add(arc);
    shield.add(seal);
    const sealLabel = document.createElement("div");
    sealLabel.className = "pointer-events-none absolute left-0 top-0 select-none text-center transition-opacity duration-300";
    sealLabel.innerHTML = `<div style="font-size:34px;font-weight:700;line-height:1;color:#fff;text-shadow:0 2px 10px rgba(0,0,0,.8)">${score}</div><div style="font-size:11px;color:rgba(255,255,255,.65)">/ 100</div>`;
    labels.appendChild(sealLabel);

    // Glow on the bright parts.
    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.55, 0.6, 0.72);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const size = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      composer.setSize(w, h);
      bloom.resolution.set(w / 2, h / 2);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    // Pointer: tilt the shield towards it and find the piece under it.
    const pointer = new THREE.Vector2(9, 9);
    const tilt = new THREE.Vector2();
    const ray = new THREE.Raycaster();
    let hovered: string | null = null;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    const leave = () => pointer.set(9, 9);
    const click = () => {
      if (hovered && hovered !== selectRef.current) onSelectRef.current(hovered);
      else if (!hovered && selectRef.current) onSelectRef.current(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("click", click);

    // Flying: from wherever the camera is to the chosen piece (or home).
    let flight: { t0: number; fromP: THREE.Vector3; toP: THREE.Vector3; fromL: THREE.Vector3; toL: THREE.Vector3 } | null = null;
    let focus: string | null = selectRef.current;
    const fly = (id: string | null) => {
      focus = id;
      const p = pieces.find((x) => x.id === id);
      const toL = p ? p.base.clone().add(p.dir.clone().multiplyScalar(0.2)) : new THREE.Vector3(0, -0.1, 0);
      const toP = p ? new THREE.Vector3(toL.x * 0.55, toL.y * 0.55, 8.4) : HOME.clone();
      flight = { t0: performance.now(), fromP: camera.position.clone(), toP, fromL: lookAt.clone(), toL };
    };
    api.current = { fly };
    if (focus) fly(focus);

    // Drawn only while on screen and the window is shown: no GPU work while scrolled away.
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0.01 });
    io.observe(el);
    const clock = new THREE.Clock();
    let raf = 0;
    const project = new THREE.Vector3();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (!visible || document.hidden) return;
      const time = clock.elapsedTime;
      const w = el.clientWidth;
      const h = el.clientHeight;

      if (flight) {
        const k = Math.min(1, (performance.now() - flight.t0) / (reduce ? 200 : 950));
        const e = ease(k);
        camera.position.lerpVectors(flight.fromP, flight.toP, e);
        lookAt.lerpVectors(flight.fromL, flight.toL, e);
        if (k >= 1) flight = null;
      }
      camera.lookAt(lookAt);

      // A gentle tilt towards the pointer, calmer while zoomed in.
      const inside = Math.abs(pointer.x) <= 1 && Math.abs(pointer.y) <= 1;
      const k = focus ? 0.06 : 0.22;
      tilt.lerp(new THREE.Vector2(inside ? pointer.x * k : Math.sin(time * 0.4) * 0.05, inside ? pointer.y * k : Math.cos(time * 0.5) * 0.03), 1 - Math.exp(-dt * 4));
      shield.rotation.y = tilt.x - 0.08;
      shield.rotation.x = -tilt.y - 0.06;

      ray.setFromCamera(pointer, camera);
      const hits = inside ? ray.intersectObjects(pieces.map((p) => p.mesh), false) : [];
      const now = (hits[0]?.object.userData.id as string | undefined) ?? null;
      if (now !== hovered) {
        hovered = now;
        setHover(now);
        el.style.cursor = now ? "pointer" : focus ? "zoom-out" : "default";
      }

      for (const p of pieces) {
        const chosen = p.id === focus;
        const wantLift = chosen ? 0.55 : p.id === hovered ? 0.22 : 0;
        const wantFade = focus && !chosen ? 0.16 : 1;
        p.lift += (wantLift - p.lift) * (1 - Math.exp(-dt * 8));
        p.fade += (wantFade - p.fade) * (1 - Math.exp(-dt * 6));
        p.mesh.position.set(p.base.x + p.dir.x * p.lift * 0.35, p.base.y + p.dir.y * p.lift * 0.35, p.lift);
        p.mat.opacity = p.fade;
        p.panel.opacity = p.fade;
        p.panel.emissiveIntensity = 0.1 + (p.id === hovered || chosen ? 0.5 : 0);
        p.mat.emissiveIntensity = 0.12 + (p.id === hovered || chosen ? 0.45 : 0) + (chosen ? Math.sin(time * 3) * 0.08 : 0);
        (p.edges.material as THREE.LineBasicMaterial).opacity = 0.5 * p.fade + (chosen ? 0.4 : 0);
        p.mesh.getWorldPosition(project);
        project.z += 0.35;
        project.project(camera);
        p.label.style.transform = `translate(-50%, -50%) translate(${((project.x + 1) / 2) * w}px, ${((1 - project.y) / 2) * h}px)`;
        p.label.style.opacity = String(Math.max(0.12, p.fade));
      }
      seal.getWorldPosition(project);
      project.z += 0.3;
      project.project(camera);
      sealLabel.style.transform = `translate(-50%, -50%) translate(${((project.x + 1) / 2) * w}px, ${((1 - project.y) / 2) * h}px)`;
      sealLabel.style.opacity = focus ? "0.25" : "1";
      sealRing.scale.setScalar(1 + Math.sin(time * 2) * 0.012);
      rimLine.material.opacity = 0.4 + Math.sin(time * 1.5) * 0.15;
      composer.render();
    };
    frame();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      envTex.dispose();
      pmrem.dispose();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("click", click);
      api.current = null;
      for (const d of disposables) d.dispose();
      composer.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      labels.innerHTML = "";
    };
    // The scene is rebuilt when the parts or scores change.
  }, [parts.map((p) => `${p.id}:${p.score}:${p.title}`).join("|"), score]); // eslint-disable-line react-hooks/exhaustive-deps

  const hovered = parts.find((p) => p.id === hover);
  return (
    <div className="relative h-full w-full">
      <div ref={host} className="absolute inset-0" data-testid="shield-3d" />
      <div ref={labelHost} className="pointer-events-none absolute inset-0 overflow-hidden" />
      {hovered && !selected && (
        <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface/90 px-3 py-1 text-[12px] backdrop-blur" data-testid="shield-hover">
          <span className="font-medium">{hovered.title}</span>
          <span className="text-muted"> · {hovered.status}</span>
        </div>
      )}
    </div>
  );
}
