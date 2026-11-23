import { useEffect, useRef } from "react";
import * as THREE from "three";

/** Which part of the disk a path belongs to, for the colour of the cells it lights. */
export function zoneOf(path: string): number {
  const p = path.toLowerCase();
  if (p.includes("\\windows\\")) return 0;
  if (p.includes("\\program files") || p.includes("\\programdata\\")) return 1;
  if (p.includes("\\users\\")) return p.includes("\\appdata\\") ? 3 : 2;
  return 3;
}
export const ZONE_COLOURS = ["#4cc2ff", "#a78bfa", "#3fb950", "#e3b341"];

/**
 * A drive built while it is indexed. An SSD is a crystal of memory layers whose cells light up as
 * files are found; a hard disk is a stack of glass platters whose tracks light up under a moving
 * head. `fill` (0–1) is how much of the used space has been seen; `zone` colours the newest cells.
 */
export default function DiskBuild3D({ kind, fill, zone }: { kind: "ssd" | "hdd"; fill: number; zone: number }) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef({ fill, zone });
  state.current = { fill, zone };

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    camera.position.set(0, 3.2, 8.6);
    camera.lookAt(0, -0.1, 0);
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, 6, 5);
    scene.add(key);
    const group = new THREE.Group();
    scene.add(group);
    const trash: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (trash.push(x), x);
    const colours = ZONE_COLOURS.map((c) => new THREE.Color(c));
    const dim = new THREE.Color("#1a2330");

    // The cells, in the order they light up, with the zone colour each got.
    let cells: THREE.InstancedMesh;
    let order: number[] = [];
    const lit: number[] = [];
    let head: THREE.Object3D | null = null;
    const m4 = new THREE.Matrix4();

    if (kind === "ssd") {
      // A crystal: 8 layers of 18×12 cells inside a glass block.
      const L = 8, X = 18, Z = 12, s = 0.2, gap = 0.035;
      const W = X * (s + gap), D = Z * (s + gap), H = L * (s + gap * 3);
      const glass = new THREE.Mesh(keep(new THREE.BoxGeometry(W + 0.3, H + 0.3, D + 0.3)), keep(new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.08, roughness: 0.1, metalness: 0, transmission: 0.6 })));
      group.add(glass);
      const edges = new THREE.LineSegments(keep(new THREE.EdgesGeometry(glass.geometry)), keep(new THREE.LineBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.45 })));
      group.add(edges);
      // Thin plates between the layers.
      for (let l = 0; l <= L; l++) {
        const plate = new THREE.Mesh(keep(new THREE.PlaneGeometry(W + 0.2, D + 0.2)), keep(new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.035, side: THREE.DoubleSide })));
        plate.rotation.x = -Math.PI / 2;
        plate.position.y = -H / 2 + l * (H / L);
        group.add(plate);
      }
      const n = L * X * Z;
      cells = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(s, s * 0.55, s)), keep(new THREE.MeshBasicMaterial({ toneMapped: false })), n);
      let i = 0;
      for (let l = 0; l < L; l++)
        for (let x = 0; x < X; x++)
          for (let z = 0; z < Z; z++) {
            m4.makeTranslation(-W / 2 + (x + 0.5) * (s + gap), -H / 2 + (l + 0.5) * (H / L), -D / 2 + (z + 0.5) * (s + gap));
            cells.setMatrixAt(i, m4);
            cells.setColorAt(i, dim);
            i++;
          }
      // Fill layer by layer from the bottom, each layer in a shuffled order — like pages being written.
      for (let l = 0; l < L; l++) {
        const layer = Array.from({ length: X * Z }, (_, k) => l * X * Z + k);
        for (let k = layer.length - 1; k > 0; k--) {
          const j = Math.floor(Math.random() * (k + 1));
          [layer[k], layer[j]] = [layer[j], layer[k]];
        }
        order.push(...layer);
      }
      group.add(cells);
      group.rotation.x = 0.05;
    } else {
      // A hard disk: 4 glass platters on a spindle, tracks of short arcs on each.
      const P = 4, rings = 7, perRing = 36;
      const spindle = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.22, 0.22, 3, 32)), keep(new THREE.MeshStandardMaterial({ color: 0x8aa0b6, metalness: 1, roughness: 0.25 })));
      group.add(spindle);
      for (let p = 0; p < P; p++) {
        const disc = new THREE.Mesh(keep(new THREE.CylinderGeometry(2.6, 2.6, 0.04, 96)), keep(new THREE.MeshPhysicalMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.12, roughness: 0.05, metalness: 0.2 })));
        disc.position.y = -1.05 + p * 0.7;
        group.add(disc);
        const rim = new THREE.Mesh(keep(new THREE.TorusGeometry(2.6, 0.012, 8, 128)), keep(new THREE.MeshBasicMaterial({ color: 0x4cc2ff, transparent: true, opacity: 0.5 })));
        rim.rotation.x = Math.PI / 2;
        rim.position.y = disc.position.y;
        group.add(rim);
      }
      const n = P * rings * perRing;
      cells = new THREE.InstancedMesh(keep(new THREE.BoxGeometry(0.28, 0.03, 0.09)), keep(new THREE.MeshBasicMaterial({ toneMapped: false })), n);
      let i = 0;
      const q = new THREE.Quaternion();
      for (let p = 0; p < P; p++)
        for (let r = 0; r < rings; r++)
          for (let a = 0; a < perRing; a++) {
            const ang = (a / perRing) * Math.PI * 2;
            const rad = 0.65 + r * 0.28;
            q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -ang);
            m4.compose(new THREE.Vector3(Math.cos(ang) * rad, -1.05 + p * 0.7 + 0.035, Math.sin(ang) * rad), q, new THREE.Vector3(1, 1, 1));
            cells.setMatrixAt(i, m4);
            cells.setColorAt(i, dim);
            i++;
          }
      // Data goes outer tracks first, the same track on every platter together (a "cylinder").
      for (let r = rings - 1; r >= 0; r--)
        for (let a = 0; a < perRing; a++) for (let p = 0; p < P; p++) order.push(p * rings * perRing + r * perRing + a);
      group.add(cells);
      // The head: a comb of arms that swings over the tracks.
      head = new THREE.Group();
      const armMat = keep(new THREE.MeshStandardMaterial({ color: 0xc9d6e3, metalness: 1, roughness: 0.3 }));
      for (let p = 0; p < P; p++) {
        const arm = new THREE.Mesh(keep(new THREE.BoxGeometry(2.4, 0.03, 0.12)), armMat);
        arm.position.set(-1.2, -1.05 + p * 0.7 + 0.09, 0);
        head.add(arm);
        const tip = new THREE.Mesh(keep(new THREE.SphereGeometry(0.06, 12, 8)), keep(new THREE.MeshBasicMaterial({ color: 0x4cc2ff })));
        tip.position.set(-2.4, -1.05 + p * 0.7 + 0.07, 0);
        head.add(tip);
      }
      head.position.set(3.4, 0, -0.6);
      group.add(head);
    }
    cells.instanceColor!.needsUpdate = true;

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

    const clock = new THREE.Clock();
    let raf = 0;
    const c = new THREE.Color();
    const flash: { i: number; t: number }[] = [];
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      if (document.hidden) return;
      const time = clock.elapsedTime;
      group.rotation.y += dt * (kind === "ssd" ? 0.18 : 0.12);
      // Light as many cells as the share of the disk seen so far, a few per frame so it flows.
      const want = Math.floor(Math.min(1, state.current.fill) * order.length);
      let step = Math.max(1, Math.ceil((want - lit.length) / 12));
      while (lit.length < want && step-- > 0) {
        const i = order[lit.length];
        lit.push(state.current.zone);
        flash.push({ i, t: time });
      }
      // New cells flash white, then settle into their zone colour.
      for (let k = flash.length - 1; k >= 0; k--) {
        const f = flash[k];
        const age = time - f.t;
        const zoneColour = colours[lit[order.indexOf(f.i)] ?? 0];
        c.copy(zoneColour).lerp(new THREE.Color(1, 1, 1), Math.max(0, 1 - age * 2.5));
        cells.setColorAt(f.i, c);
        if (age > 0.45) {
          cells.setColorAt(f.i, zoneColour);
          flash.splice(k, 1);
        }
      }
      cells.instanceColor!.needsUpdate = true;
      if (head) {
        // The head follows the track being written, with a little search jitter.
        const r = 1 - Math.min(1, state.current.fill);
        head.rotation.y = -0.35 + r * 0.55 + Math.sin(time * 9) * 0.02;
      }
      renderer.render(scene, camera);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const d of trash) d.dispose();
      cells.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [kind]);

  return <div ref={host} className="h-full w-full" data-testid="disk-3d" />;
}
