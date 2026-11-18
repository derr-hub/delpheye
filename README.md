# DelphEye

**A Windows checkup that explains what it finds — and lets you decide.**

DelphEye looks first and changes nothing until you choose. Every finding comes with a plain
explanation of what it is, why it matters and what to do about it. Interface in Ukrainian and
English.

## What it does

- **Overview** — a short summary of what is fine and what is not.
- **Cleanup** — temporary files and caches, with a report before anything is deleted.
- **App leftovers** — folders and registry keys left behind by uninstalled programs; moved to a
  quarantine for 7 days, so anything can be put back.
- **Startup** — programs, scheduled tasks and services that start with Windows, how much each
  slows the boot, and whether it is safe to turn off. Every change can be undone.
- **Disk** — instant search through the NTFS file table, "time layers" (which data has not been
  touched for years), duplicates, Recycle Bin.
- **Monitoring** — sensors, throttling measured without drivers, a stress test for the processor,
  memory and graphics card with error checking, a cooling profile compared run to run, and the
  crash record explained incident by incident.
- **Processes** — a process tree with what each one is and what ending it would do.
- **Network** — who talks to which servers, traffic per program, open ports, suspicious
  connections and a connection check (router, internet, DNS).
- **Protection** — places malware hides, signs of tampering, a Windows security score and
  optional online file reputation (only file hashes are sent).
- **Journal** — everything DelphEye changed, with the means to restore it.

## Install

Download `DelphEye_x.y.z_x64-setup.exe` from [Releases](../../releases/latest) and run it. No
administrator rights are needed to install. Windows may show "Windows protected your PC"
because the app is not commercially signed: choose *More info → Run anyway*. Installed copies
update themselves from this repository's releases.

Requires Windows 10 or 11 (64-bit).

## Building

Rust (stable), Node.js 20+, and the .NET 9 SDK for the sensor helper.

```powershell
npm install
npm run tauri dev                              # development
scripts\release.ps1 -Notes "What changed"      # signed release + latest.json
```

The release script expects the update signing key at `%USERPROFILE%\.tauri\delpheye.key`; it is
never part of this repository.

Built with Tauri 2, Rust, React and TypeScript; hardware sensors through LibreHardwareMonitor.
