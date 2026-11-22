# 👁️ DelphEye

**A Windows checkup that explains what it finds — and lets you decide.**

DelphEye inspects your system first and changes nothing until you choose. Every finding comes with a plain explanation of what it is, why it matters, and what to do about it. 

🌐 **Interface:** Ukrainian & English | 💻 **OS:** Windows 10 / 11 (64-bit)

[![Download Latest Release](https://img.shields.io/github/v/release/derr-hub/delpheye?label=Download%20DelphEye&style=for-the-badge&color=2ea44f)](https://github.com/derr-hub/delpheye/releases/latest)

---

<!-- ВСТАВЬТЕ СЮДА 1-2 СКРИНШОТА ИНТЕРФЕЙСА -->
<!-- Пример: ![DelphEye Overview](screenshots/overview.png) -->

---

## ✨ Why DelphEye?
* **Safe by default:** Zero automatic changes. Everything can be reviewed first and rolled back later.
* **No admin rights required to install:** Runs cleanly in user space without cluttering the system.
* **Built-in auto-updates:** Installed copies automatically check and update from this repository's releases.
* **Privacy-first:** All diagnostics run locally. Online file reputation checks are optional and send **only file hashes**.

---

## 🛠️ What It Does

* **Overview** — A concise summary of what is healthy on your PC and what needs attention.
* **Cleanup** — Scans temporary files and caches, generating a clear report before anything is deleted.
* **App Leftovers** — Finds folders and registry keys left behind by uninstalled software. Items are moved to a **7-day quarantine**, so anything can be restored.
* **Startup** — Analyzes startup programs, scheduled tasks, and services, showing boot impact and whether disabling them is safe (with full undo support).
* **Disk** — Instant search directly through the NTFS file table (MFT), *"time layers"* (data untouched for years), duplicate finder, and Recycle Bin breakdown.
* **Monitoring** — Hardware sensors, throttling detection without extra drivers, CPU/RAM/GPU stress tests with error checking, run-to-run cooling profiles, and crash records explained incident by incident.
* **Processes** — Detailed process tree explaining what each process actually does and what happens if you terminate it.
* **Network** — Shows which apps talk to which servers, per-program traffic, open ports, suspicious connections, and a network health check (router, internet, DNS).
* **Wi-Fi** — Three levels in one place:
  * *Simple* — how good your connection is, how crowded your channel is, and plain advice.
  * *Advanced* — channel spectrum, signal over time, link quality (Wi-Fi vs. your provider), air history over days, a **3D echolocator** with a home view (floor plan, walls, heat map, router), a hunt mode with sonar, direction finding, and a **home map** that estimates where the router stands.
  * *Professional* — connects to an ASUS router (read-only by default): every device on the network and how loud it is, a connection log, traffic, open ports, security checks, and confirmed one-click fixes (channel, WPS, guest network, UPnP, blocking a device).
* **Updates** — Finds newer versions of installed programs through winget and updates one or all of them.
* **Camera & Mic** — Shows which programs used the camera, microphone and location — and which are using them right now.
* **Protection** — Scans common malware hiding spots, checks for signs of system tampering, calculates a Windows security score, and offers optional hash-based file reputation checks.
* **Journal** — A complete log of every change made by DelphEye with one-click restoration.
* **Watcher** — Runs from the tray and notifies you about new devices on your network, a copy of your Wi-Fi network ("evil twin"), overheating, a nearly full disk, new startup entries and crashes.
* **Why is it slow?** & **Help a relative** — A quick diagnosis of the moment, and a report file a relative can send you for a look from afar.

---

## 📥 Installation

1. Go to [**Releases**](https://github.com/derr-hub/delpheye/releases/latest) and download `DelphEye_x.y.z_x64-setup.exe`.
2. Run the installer (**no administrator rights required**).
3. *Note on Windows SmartScreen:* Because the app is open-source and not commercially signed, Windows may show *"Windows protected your PC"*. Click **More info → Run anyway**.

---

## 🔧 Building from Source

### Prerequisites
* **Rust** (stable)
* **Node.js** 20+
* **.NET 9 SDK** (required for the hardware sensor helper)

### Commands
```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri dev

# Build a signed release + latest.json
scripts\release.ps1 -Notes "What changed"
