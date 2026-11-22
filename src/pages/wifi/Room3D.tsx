import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * A small room seen from above at an angle: four walls, a person with a laptop in the middle who
 * turns to face `facing` (degrees clockwise from wall 1), the wall or corner to face lit up, and —
 * once known — an arrow on the floor towards the router.
 */
export default function Room3D({ facing, highlight, result, labels }: { facing: number; highlight: number | null; result: number | null; labels: string[] }) {
  const host = useRef<HTMLDivElement>(null);
  const state = useRef({ facing, highlight, result });
  state.current = { facing, highlight, result };

  useEffect(() => {
    const el = host.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 9.5, 7.5);
    camera.lookAt(0, 0, 0.4);
    scene.add(new THREE.AmbientLight(0xffffff, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(3, 8, 5);
    scene.add(sun);
    const own: { dispose: () => void }[] = [];
    const keep = <T extends { dispose: () => void }>(x: T) => (own.push(x), x);

    const S = 3; // half the room size
    const floor = new THREE.Mesh(keep(new THREE.PlaneGeometry(S * 2, S * 2)), keep(new THREE.MeshStandardMaterial({ color: "#1b232d" })));
    floor.rotation.x = -Math.PI / 2;
    scene.add(floor);
    const grid = new THREE.GridHelper(S * 2, 6, "#2c3a49", "#24303c");
    grid.position.y = 0.01;
    scene.add(grid);

    // Walls: 0 = wall 1 (ahead at the start, -z), then clockwise seen from above.
    const wallMat = keep(new THREE.MeshStandardMaterial({ color: "#2b3947", transparent: true, opacity: 0.55 }));
    const litMat = keep(new THREE.MeshStandardMaterial({ color: "#4cc2ff", emissive: "#1a6a99", transparent: true, opacity: 0.85 }));
    const walls: THREE.Mesh[] = [];
    for (let k = 0; k < 4; k++) {
      const w = new THREE.Mesh(keep(new THREE.BoxGeometry(S * 2, 1.1, 0.12)), wallMat);
      const a = (k * Math.PI) / 2;
      w.position.set(Math.sin(a) * S, 0.55, -Math.cos(a) * S);
      w.rotation.y = -a;
      scene.add(w);
      walls.push(w);
    }
    const corners: THREE.Mesh[] = [];
    for (let k = 0; k < 4; k++) {
      const c = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.14, 0.14, 1.3, 16)), wallMat);
      const a = ((k + 0.5) * Math.PI) / 2;
      c.position.set(Math.sin(a) * S * Math.SQRT2, 0.65, -Math.cos(a) * S * Math.SQRT2);
      scene.add(c);
      corners.push(c);
    }

    // The person: body, head and a laptop held in front.
    const person = new THREE.Group();
    const body = new THREE.Mesh(keep(new THREE.CapsuleGeometry(0.32, 0.7, 6, 16)), keep(new THREE.MeshStandardMaterial({ color: "#d9e4ee" })));
    body.position.y = 0.75;
    const head = new THREE.Mesh(keep(new THREE.SphereGeometry(0.24, 24, 16)), keep(new THREE.MeshStandardMaterial({ color: "#f0d2b5" })));
    head.position.y = 1.5;
    const laptop = new THREE.Mesh(keep(new THREE.BoxGeometry(0.55, 0.04, 0.38)), keep(new THREE.MeshStandardMaterial({ color: "#4cc2ff", emissive: "#0e3d57" })));
    laptop.position.set(0, 0.95, -0.45);
    const screen = new THREE.Mesh(keep(new THREE.BoxGeometry(0.55, 0.36, 0.03)), keep(new THREE.MeshStandardMaterial({ color: "#7fd6ff", emissive: "#2a7fb0" })));
    screen.position.set(0, 1.13, -0.27);
    screen.rotation.x = -0.25;
    const nose = new THREE.Mesh(keep(new THREE.ConeGeometry(0.16, 0.4, 16)), keep(new THREE.MeshStandardMaterial({ color: "#f5a35c" })));
    nose.rotation.x = -Math.PI / 2;
    nose.position.set(0, 0.05, -0.75);
    // Where the person looks: a beam along the floor to the wall or corner.
    const beam = new THREE.Mesh(keep(new THREE.PlaneGeometry(0.5, S * 1.35)), keep(new THREE.MeshBasicMaterial({ color: "#4cc2ff", transparent: true, opacity: 0.35, depthWrite: false })));
    beam.rotation.x = -Math.PI / 2;
    beam.position.set(0, 0.02, -(S * 1.35) / 2 - 0.3);
    person.add(body, head, laptop, screen, nose, beam);
    person.scale.setScalar(1.45);
    scene.add(person);

    // The answer: an arrow on the floor.
    const arrow = new THREE.Group();
    const shaft = new THREE.Mesh(keep(new THREE.BoxGeometry(0.16, 0.04, 2)), keep(new THREE.MeshStandardMaterial({ color: "#6ccb5f", emissive: "#2e6b27" })));
    shaft.position.set(0, 0.04, -1.6);
    const tip = new THREE.Mesh(keep(new THREE.ConeGeometry(0.34, 0.7, 24)), keep(new THREE.MeshStandardMaterial({ color: "#6ccb5f", emissive: "#2e6b27" })));
    tip.rotation.x = -Math.PI / 2;
    tip.position.set(0, 0.06, -2.85);
    arrow.add(shaft, tip);
    arrow.visible = false;
    scene.add(arrow);

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let raf = 0;
    let yaw = 0;
    const clock = new THREE.Clock();
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      const t = clock.elapsedTime;
      const { facing, highlight, result } = state.current;
      // Turn the short way round towards the target.
      const target = (-facing * Math.PI) / 180;
      let d = target - yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      yaw += d * (1 - Math.exp(-dt * 4));
      person.rotation.y = yaw;
      beam.visible = highlight !== null;
      (beam.material as THREE.MeshBasicMaterial).opacity = 0.25 + Math.sin(t * 4) * 0.1;
      walls.forEach((w, k) => (w.material = highlight === k * 90 ? litMat : wallMat));
      corners.forEach((c, k) => (c.material = highlight === k * 90 + 45 ? litMat : wallMat));
      if (result !== null) {
        arrow.visible = true;
        arrow.rotation.y = (-result * Math.PI) / 180;
        arrow.scale.setScalar(1 + Math.sin(t * 3) * 0.04);
      } else arrow.visible = false;
      renderer.render(scene, camera);
    };
    frame();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      own.forEach((o) => o.dispose());
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  // Wall names drawn as HTML around the scene, in the same clockwise order.
  const pos = ["left-1/2 top-1 -translate-x-1/2", "right-1 top-1/2 -translate-y-1/2", "bottom-1 left-1/2 -translate-x-1/2", "left-1 top-1/2 -translate-y-1/2"];
  return (
    <div className="relative h-[300px] w-full overflow-hidden rounded-xl bg-[#0d1218]">
      <div ref={host} className="absolute inset-0" />
      {labels.map((l, k) => (
        <span key={k} className={`pointer-events-none absolute rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-[#c8d3de] ${pos[k]}`}>
          {l}
        </span>
      ))}
    </div>
  );
}
