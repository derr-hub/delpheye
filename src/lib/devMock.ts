// Dev-only: simulated metrics so the UI can be previewed in a plain browser.
// Never loaded inside the real app (see main.tsx). All numbers here are fake.
import { mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { Snapshot, SystemInfo } from "./metrics";

const GB = 1024 ** 3;

export function installDevMock() {
  mockIPC(
    (cmd) => {
      if (cmd === "app_status") return { elevated: false, sandbox: true, version: "preview" };
      if (cmd === "journal_list" || cmd === "disk_drives" || cmd === "quarantine_list") return [];
      if (cmd === "cleanup_scan") return { scanId: 1, elevated: false, sandbox: true, durationMs: 0, categories: [] };
      if (cmd === "system_info") {
        return {
          osName: "Windows",
          osVersion: "11 (simulated)",
          hostName: "DEV-PREVIEW",
          cpuBrand: "Simulated CPU 8-Core",
          physicalCores: 8,
          logicalCores: 16,
          totalMemory: 32 * GB,
        } satisfies SystemInfo;
      }
    },
    { shouldMockEvents: true },
  );

  let t = 0;
  setInterval(() => {
    t += 1;
    const cpu = 22 + 16 * Math.sin(t / 7) + Math.random() * 10;
    const snapshot: Snapshot = {
      cpuUsage: cpu,
      cpuFrequency: 3600 + Math.round(Math.random() * 600),
      perCore: Array.from({ length: 16 }, () => Math.max(2, cpu + (Math.random() - 0.5) * 50)),
      memUsed: (17 + Math.sin(t / 15)) * GB,
      memTotal: 32 * GB,
      swapUsed: 2.1 * GB,
      swapTotal: 8 * GB,
      disks: [
        { name: "System", mount: "C:\\", fileSystem: "NTFS", kind: "SSD", total: 476 * GB, available: 58 * GB, removable: false },
        { name: "Data", mount: "D:\\", fileSystem: "NTFS", kind: "HDD", total: 931 * GB, available: 402 * GB, removable: false },
      ],
      uptime: 93_784 + t,
      processCount: 241 + (t % 5),
      netRx: Math.random() * 3_000_000,
      netTx: Math.random() * 400_000,
      topProcesses: [
        { count: 1, name: "browser.exe", cpu: 4.2, memory: 2.4 * GB },
        { count: 1, name: "editor.exe", cpu: 1.1, memory: 1.3 * GB },
        { count: 1, name: "chat.exe", cpu: 0.4, memory: 0.7 * GB },
        { count: 1, name: "explorer.exe", cpu: 0.2, memory: 0.3 * GB },
        { count: 1, name: "service-host.exe", cpu: 0.1, memory: 0.2 * GB },
        { count: 1, name: "indexer.exe", cpu: 0.0, memory: 0.15 * GB },
      ],
    };
    emit("metrics", snapshot);
  }, 1000);
}
