/** Compass heading and steps, from the phone's own motion sensors. */

type Listener = () => void;

export const sensors = {
  /** Degrees clockwise from north, or null before the compass reports. */
  heading: null as number | null,
  steps: 0,
};

const listeners = new Set<Listener>();
export const onSensors = (l: Listener) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
const notify = () => listeners.forEach((l) => l());

let started = false;
export function startSensors() {
  if (started) return;
  started = true;

  // Android reports an absolute (north-referenced) orientation as its own event.
  const orientation = (e: DeviceOrientationEvent & { webkitCompassHeading?: number }) => {
    if (typeof e.webkitCompassHeading === "number") sensors.heading = e.webkitCompassHeading;
    else if (e.absolute && e.alpha !== null) sensors.heading = (360 - e.alpha) % 360;
    else return;
    notify();
  };
  window.addEventListener("deviceorientationabsolute" as "deviceorientation", orientation as EventListener, true);
  window.addEventListener("deviceorientation", orientation as EventListener, true);

  // Steps: a smoothed acceleration magnitude crossing up through a threshold, at most ~3 a second.
  let smooth = 9.81;
  let above = false;
  let lastStep = 0;
  window.addEventListener("devicemotion", (e) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const mag = Math.hypot(a.x, a.y, a.z);
    smooth = smooth * 0.8 + mag * 0.2;
    const now = performance.now();
    if (!above && smooth > 11.0 && now - lastStep > 320) {
      above = true;
      lastStep = now;
      sensors.steps++;
      notify();
    } else if (above && smooth < 10.0) above = false;
  });
}
