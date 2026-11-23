/** What a folder or file is for, from its name and place — the "zoning" of the file city. */
export type Role = "critical" | "apps" | "user" | "cache" | "dev" | "other";

export const ROLE_COLOURS: Record<Role, string> = {
  critical: "#f0574d",
  apps: "#a78bfa",
  user: "#3fb950",
  cache: "#e3b341",
  dev: "#4cc2ff",
  other: "#7d8a9c",
};

/** Names with their own explanation (lower case) → the key under disk.city.known. */
const KNOWN: Record<string, string> = {
  windows: "windows",
  system32: "system32",
  syswow64: "system32",
  winsxs: "winsxs",
  "program files": "programFiles",
  "program files (x86)": "programFiles",
  programdata: "programData",
  users: "users",
  appdata: "appdata",
  local: "appdataLocal",
  roaming: "appdataRoaming",
  temp: "temp",
  "pagefile.sys": "pagefile",
  "swapfile.sys": "pagefile",
  "hiberfil.sys": "hiberfil",
  "$recycle.bin": "recycle",
  "system volume information": "svi",
  recovery: "recovery",
  boot: "boot",
  downloads: "downloads",
  desktop: "desktop",
  documents: "documents",
  pictures: "pictures",
  videos: "videos",
  music: "music",
  onedrive: "onedrive",
  softwaredistribution: "softwareDistribution",
  installer: "installer",
  driverstore: "driverStore",
  node_modules: "nodeModules",
  ".git": "git",
  steamapps: "games",
  steam: "games",
  "epic games": "games",
  packages: "packages",
  "package cache": "cache",
  cache: "cache",
  crashdumps: "crashdumps",
  logs: "logs",
};

export function knownKey(name: string): string | null {
  return KNOWN[name.toLowerCase()] ?? null;
}

export function roleOf(path: string, name: string): Role {
  const p = `${path}\\${name}`.toLowerCase();
  const n = name.toLowerCase();
  if (/^(pagefile|swapfile|hiberfil)\.sys$|^bootmgr$|^\$recycle\.bin$|^system volume information$/.test(n)) return n === "$recycle.bin" ? "cache" : "critical";
  if (/\\(temp|tmp|cache|caches|code cache|gpucache|shadercache|crashdumps|logs|package cache|softwaredistribution\\download)(\\|$)/.test(p) || /cache/.test(n)) return "cache";
  if (/\\windows(\\|$)|\\boot(\\|$)|\\recovery(\\|$)/.test(p) && !/\\windows\\temp/.test(p)) return "critical";
  if (/node_modules|\\\.git(\\|$)|\\target\\(debug|release)|\\\.gradle|\\\.cargo|\\\.npm|\\\.nuget/.test(p)) return "dev";
  if (/\\program files|\\programdata|\\appdata\\local\\programs|steamapps|epic games/.test(p)) return "apps";
  if (/\\users\\[^\\]+\\(desktop|documents|pictures|videos|music|downloads|onedrive)/.test(p) || /\\users\\[^\\]+$/.test(p)) return "user";
  if (/\\appdata/.test(p)) return "apps";
  return "other";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap: rectangles for `sizes` inside `box`, keeping them close to squares. */
export function squarify(sizes: number[], box: Rect): Rect[] {
  const total = sizes.reduce((a, b) => a + b, 0);
  const out: Rect[] = new Array(sizes.length);
  if (!total) return sizes.map(() => ({ ...box, w: 0, h: 0 }));
  const order = sizes.map((s, i) => [s, i] as const).sort((a, b) => b[0] - a[0]);
  const scale = (box.w * box.h) / total;
  let rest = { ...box };
  let row: (readonly [number, number])[] = [];
  const worst = (r: (readonly [number, number])[], side: number) => {
    const areas = r.map(([s]) => s * scale);
    const sum = areas.reduce((a, b) => a + b, 0);
    const max = Math.max(...areas);
    const min = Math.min(...areas);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };
  const layout = (r: (readonly [number, number])[]) => {
    const sum = r.reduce((a, [s]) => a + s * scale, 0);
    if (rest.w >= rest.h) {
      const w = sum / rest.h;
      let y = rest.y;
      for (const [s, i] of r) {
        const h = (s * scale) / w;
        out[i] = { x: rest.x, y, w, h };
        y += h;
      }
      rest = { x: rest.x + w, y: rest.y, w: rest.w - w, h: rest.h };
    } else {
      const h = sum / rest.w;
      let x = rest.x;
      for (const [s, i] of r) {
        const w = (s * scale) / h;
        out[i] = { x, y: rest.y, w, h };
        x += w;
      }
      rest = { x: rest.x, y: rest.y + h, w: rest.w, h: rest.h - h };
    }
  };
  for (const item of order) {
    if (item[0] <= 0) {
      out[item[1]] = { x: rest.x, y: rest.y, w: 0, h: 0 };
      continue;
    }
    const side = Math.min(rest.w, rest.h);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else {
      layout(row);
      row = [item];
    }
  }
  if (row.length) layout(row);
  return out;
}
