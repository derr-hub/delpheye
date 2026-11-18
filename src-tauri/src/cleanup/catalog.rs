//! Everything DelphEye knows how to clean, resolved against one machine's folders.
//!
//! The catalog only describes *where* to look and under which rule. It never deletes;
//! that is the engine's job, and the engine re-checks every path it is handed.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rayon::prelude::*;
use serde::Serialize;

use super::engine::{Location, Matcher, is_reparse};
use crate::system::Dirs;

const DAY: Duration = Duration::from_secs(24 * 3600);

/// Cache folders Chromium keeps inside each profile.
const PROFILE_CACHES: &[&str] = &[
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
];
/// Cache folders Chromium shares between profiles.
const SHARED_CACHES: &[&str] = &["ShaderCache", "GrShaderCache", "GraphiteDawnCache"];

/// How many folders deep below `AppData\Local` or `\Roaming` an app's profile may sit.
const APP_SEARCH_DEPTH: usize = 4;
/// Places under `AppData` the app-cache search stays out of: browsers and tools that have
/// their own category, Windows' own folders, and this app itself.
const APP_SEARCH_SKIP: &[&str] = &[
    "temp",
    "packages",
    "microsoft\\windows",
    "microsoft\\windowsapps",
    "google\\chrome",
    "microsoft\\edge",
    "bravesoftware\\brave-browser",
    "vivaldi",
    "opera software",
    "mozilla",
    "npm-cache",
    "pnpm-cache",
    "yarn",
    "pip",
    "nuget",
    "go-build",
    "d3dscache",
    "crashdumps",
    "com.delpheye.app",
];
/// Folder names not worth descending into at any depth.
const APP_SEARCH_PRUNE: &[&str] = &["node_modules", ".git", "site-packages"];
/// `AppData` folders that hold several vendors' apps, so the app is one level further down.
const VENDOR_FOLDERS: &[&str] = &["microsoft", "google", "programs"];

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    System,
    Browsers,
    Apps,
    Dev,
}

/// How much thought a category deserves before it is cleaned.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    /// Nothing will be missed.
    Safe,
    /// Harmless to the system, but with a side effect worth knowing about first.
    Caution,
}

pub enum Source {
    Locations(Vec<Location>),
    RecycleBin,
}

/// One selectable line inside a category: a browser profile, an app, a kind of dump.
pub struct Target {
    pub id: String,
    pub label: String,
    /// Set when the label is a phrase the UI should translate rather than a proper name.
    pub label_key: Option<&'static str>,
    pub needs_admin: bool,
    pub source: Source,
}

impl Target {
    fn new(id: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            label_key: None,
            needs_admin: false,
            source: Source::Locations(Vec::new()),
        }
    }

    /// A target whose name the UI translates, using `key` for both id and label.
    fn keyed(key: &'static str) -> Self {
        Self {
            label_key: Some(key),
            ..Self::new(key, key)
        }
    }

    fn admin(mut self) -> Self {
        self.needs_admin = true;
        self
    }

    fn add(mut self, path: PathBuf, matcher: Matcher) -> Self {
        if let Source::Locations(locations) = &mut self.source {
            locations.push(Location { path, matcher });
        }
        self
    }

    /// Everything inside `dir`, if the folder exists.
    fn contents(self, dir: PathBuf) -> Self {
        if dir.is_dir() { self.add(dir, Matcher::Contents) } else { self }
    }

    /// Files named `prefix…suffix` directly inside `dir`, if the folder exists.
    fn files(self, dir: PathBuf, prefix: &'static str, suffix: &'static str) -> Self {
        if dir.is_dir() { self.add(dir, Matcher::FilesNamed { prefix, suffix }) } else { self }
    }

    /// One file, if it exists.
    fn file(self, path: PathBuf) -> Self {
        if path.is_file() { self.add(path, Matcher::SingleFile) } else { self }
    }

    /// The Chromium cache folder `name` inside `profile`, if it really is one.
    fn chromium(self, profile: &Path, name: &str) -> Self {
        let dir = profile.join(name);
        if is_chromium_cache(&dir, name) { self.add(dir, Matcher::Contents) } else { self }
    }

    fn is_empty(&self) -> bool {
        matches!(&self.source, Source::Locations(locations) if locations.is_empty())
    }
}

pub struct Category {
    pub id: String,
    /// A product name shown as is; categories without one are named by the UI from `id`.
    pub title: Option<String>,
    pub group: Group,
    pub risk: Risk,
    /// Only files left alone for at least this long are cleaned.
    pub min_age: Option<Duration>,
    /// The program that keeps these files open while it runs.
    pub running_exe: Option<&'static str>,
    pub targets: Vec<Target>,
}

impl Category {
    fn new(id: &str, group: Group, risk: Risk) -> Self {
        Self {
            id: id.to_string(),
            title: None,
            group,
            risk,
            min_age: None,
            running_exe: None,
            targets: Vec::new(),
        }
    }

    fn titled(mut self, title: &str) -> Self {
        self.title = Some(title.to_string());
        self
    }

    fn older_than(mut self, age: Duration) -> Self {
        self.min_age = Some(age);
        self
    }

    fn used_by(mut self, exe: &'static str) -> Self {
        self.running_exe = Some(exe);
        self
    }

    /// Adds the target unless it found nothing on this machine.
    fn with(mut self, target: Target) -> Self {
        if !target.is_empty() {
            self.targets.push(target);
        }
        self
    }
}

/// Lists the categories that exist on this machine, each with the targets found for it.
pub fn build(dirs: &Dirs) -> Vec<Category> {
    use Group::{Apps, Dev, System};
    use Risk::{Caution, Safe};

    let (local, win, data) = (&dirs.local, &dirs.windows, &dirs.program_data);
    let ms_windows = |base: &Path| base.join("Microsoft").join("Windows");
    let explorer = ms_windows(local).join("Explorer");
    let wer = |base: &Path| ms_windows(base).join("WER");
    let delivery_cache = win
        .join("ServiceProfiles")
        .join("NetworkService")
        .join("AppData")
        .join("Local")
        .join("Microsoft")
        .join("Windows")
        .join("DeliveryOptimization")
        .join("Cache");

    let mut categories = vec![
        Category::new("user_temp", System, Safe)
            .older_than(DAY)
            .with(Target::new("temp", "Temp").contents(dirs.temp.clone())),
        Category::new("windows_temp", System, Safe)
            .older_than(DAY)
            .with(Target::new("temp", "Windows\\Temp").admin().contents(win.join("Temp"))),
        Category::new("inet_cache", System, Safe)
            .with(Target::new("inetcache", "INetCache").contents(ms_windows(local).join("INetCache"))),
        Category::new("thumbnails", System, Safe).with(
            Target::new("explorer", "Explorer")
                .files(explorer.clone(), "thumbcache_", ".db")
                .files(explorer, "iconcache_", ".db"),
        ),
        Category::new("shader_cache", System, Safe)
            .with(Target::new("directx", "DirectX").contents(local.join("D3DSCache")))
            .with(
                Target::new("nvidia", "NVIDIA")
                    .contents(local.join("NVIDIA").join("DXCache"))
                    .contents(local.join("NVIDIA").join("GLCache")),
            )
            .with(
                Target::new("amd", "AMD")
                    .contents(local.join("AMD").join("DxCache"))
                    .contents(local.join("AMD").join("DxcCache"))
                    .contents(local.join("AMD").join("GLCache"))
                    .contents(local.join("AMD").join("VkCache")),
            )
            .with(Target::new("intel", "Intel").contents(local.join("Intel").join("ShaderCache"))),
        Category::new("error_reports", System, Safe)
            .with(
                Target::keyed("user_reports")
                    .contents(wer(local).join("ReportArchive"))
                    .contents(wer(local).join("ReportQueue"))
                    .contents(wer(local).join("Temp")),
            )
            .with(Target::keyed("app_dumps").contents(local.join("CrashDumps")))
            .with(
                Target::keyed("system_reports")
                    .admin()
                    .contents(wer(data).join("ReportArchive"))
                    .contents(wer(data).join("ReportQueue"))
                    .contents(wer(data).join("Temp")),
            ),
        Category::new("memory_dumps", System, Safe)
            .with(Target::new("memory", "MEMORY.DMP").admin().file(win.join("MEMORY.DMP")))
            .with(Target::new("minidump", "Minidump").admin().contents(win.join("Minidump")))
            .with(
                Target::new("live", "LiveKernelReports")
                    .admin()
                    .contents(win.join("LiveKernelReports")),
            ),
        Category::new("windows_update", System, Caution).with(
            Target::new("download", "SoftwareDistribution\\Download")
                .admin()
                .contents(win.join("SoftwareDistribution").join("Download")),
        ),
        Category::new("delivery_optimization", System, Safe)
            .with(Target::new("cache", "DeliveryOptimization").admin().contents(delivery_cache)),
        Category::new("windows_logs", System, Caution)
            .older_than(DAY * 7)
            .with(Target::new("logs", "Windows\\Logs").admin().contents(win.join("Logs"))),
    ];

    // The Recycle Bin belongs to the real shell; a fake tree has none.
    if dirs.sandbox.is_none() {
        categories.push(Category::new("recycle_bin", System, Caution).with(Target {
            source: Source::RecycleBin,
            ..Target::keyed("recycle_bin")
        }));
    }

    categories.extend(browsers(dirs));

    let mut apps = Category::new("app_cache", Apps, Safe);
    apps.targets = app_caches(dirs);
    categories.push(apps);

    categories.push(
        Category::new("dev_cache", Dev, Caution)
            .with(
                Target::new("npm", "npm")
                    .contents(local.join("npm-cache").join("_cacache"))
                    .contents(local.join("npm-cache").join("_logs")),
            )
            .with(Target::new("yarn", "Yarn").contents(local.join("Yarn").join("Cache")))
            .with(Target::new("pnpm", "pnpm").contents(local.join("pnpm-cache")))
            .with(Target::new("pip", "pip").contents(local.join("pip").join("Cache")))
            .with(
                Target::new("nuget", "NuGet")
                    .contents(local.join("NuGet").join("v3-cache"))
                    .contents(local.join("NuGet").join("plugins-cache")),
            )
            .with(Target::new("go", "Go build").contents(local.join("go-build"))),
    );

    categories.retain(|category| !category.targets.is_empty());
    categories
}

fn browsers(dirs: &Dirs) -> Vec<Category> {
    let (local, roaming) = (&dirs.local, &dirs.roaming);
    let user_data = |vendor: &str, product: &str| local.join(vendor).join(product).join("User Data");
    let opera = |product: &str| {
        // Opera splits one profile between Roaming (settings) and Local (cache).
        let folder = Path::new("Opera Software").join(product);
        vec![roaming.join(&folder), local.join(&folder)]
    };

    vec![
        chromium_browser("browser_chrome", "Google Chrome", "chrome.exe", &[user_data("Google", "Chrome")]),
        chromium_browser("browser_edge", "Microsoft Edge", "msedge.exe", &[user_data("Microsoft", "Edge")]),
        chromium_browser(
            "browser_brave",
            "Brave",
            "brave.exe",
            &[user_data("BraveSoftware", "Brave-Browser")],
        ),
        chromium_browser(
            "browser_vivaldi",
            "Vivaldi",
            "vivaldi.exe",
            &[local.join("Vivaldi").join("User Data")],
        ),
        chromium_browser("browser_opera", "Opera", "opera.exe", &opera("Opera Stable")),
        chromium_browser("browser_opera_gx", "Opera GX", "opera.exe", &opera("Opera GX Stable")),
        firefox(dirs),
    ]
}

/// A Chromium-family browser. Only its caches are listed: history, cookies, sign-ins,
/// site storage and extensions live in other folders and are never part of a target.
fn chromium_browser(id: &str, title: &str, exe: &'static str, roots: &[PathBuf]) -> Category {
    let mut profiles: BTreeMap<String, Target> = BTreeMap::new();
    let mut add_profile = |name: &str, dir: &Path| {
        let target = profiles.remove(name).unwrap_or_else(|| Target::new(name, name));
        let target = PROFILE_CACHES.iter().fold(target, |t, cache| t.chromium(dir, cache));
        profiles.insert(name.to_string(), target);
    };

    let mut shared = Target::keyed("browser_shared");
    for root in roots {
        // Opera keeps its single profile in the root itself; the others use sub-folders.
        add_profile("Default", root);
        for (name, dir) in subfolders(root) {
            if name == "Default" || name.starts_with("Profile ") || name == "Guest Profile" {
                add_profile(&name, &dir);
            }
        }
        shared = SHARED_CACHES.iter().fold(shared, |t, cache| t.chromium(root, cache));
    }

    let category = Category::new(id, Group::Browsers, Risk::Safe).titled(title).used_by(exe);
    profiles.into_values().fold(category, Category::with).with(shared)
}

fn firefox(dirs: &Dirs) -> Category {
    let profiles = dirs.local.join("Mozilla").join("Firefox").join("Profiles");
    let category = Category::new("browser_firefox", Group::Browsers, Risk::Safe)
        .titled("Mozilla Firefox")
        .used_by("firefox.exe");

    subfolders(&profiles).into_iter().fold(category, |category, (name, profile)| {
        let cache = profile.join("cache2");
        let is_cache = cache.join("entries").is_dir() || cache.join("index").is_file();
        let target = Target::new(name.clone(), name);
        let target = if is_cache { target.contents(cache) } else { target };
        category.with(target.contents(profile.join("startupCache")).contents(profile.join("shader-cache")))
    })
}

/// Finds the web caches of desktop apps built on Chromium (Electron, WebView2, CEF).
///
/// These apps keep a browser-style profile somewhere under `AppData`. Rather than list
/// every such app by name, look for the cache folders themselves and accept only those
/// with Chromium's own on-disk layout.
fn app_caches(dirs: &Dirs) -> Vec<Target> {
    let top_level: Vec<(String, PathBuf)> = [&dirs.roaming, &dirs.local]
        .into_iter()
        .flat_map(|base| subfolders(base))
        .collect();
    let found: Vec<(String, PathBuf)> = top_level
        .into_par_iter()
        .flat_map_iter(|(name, dir)| {
            let mut found = Vec::new();
            find_app_caches(&dir, &[name], &mut found);
            found
        })
        .collect();

    // One target per app, whichever AppData folders its caches turned up in.
    let mut apps: BTreeMap<String, Target> = BTreeMap::new();
    for (label, cache) in found {
        let key = label.to_lowercase();
        let target = apps.remove(&key).unwrap_or_else(|| Target::new(key.clone(), label));
        apps.insert(key, target.add(cache, Matcher::Contents));
    }
    apps.into_values().collect()
}

/// Collects `(app name, cache folder)` pairs below `dir`, which sits at `trail` under AppData.
fn find_app_caches(dir: &Path, trail: &[String], found: &mut Vec<(String, PathBuf)>) {
    let relative = trail.join("\\").to_lowercase();
    if APP_SEARCH_SKIP.contains(&relative.as_str()) {
        return;
    }
    for (name, path) in subfolders(dir) {
        if PROFILE_CACHES.contains(&name.as_str()) || SHARED_CACHES.contains(&name.as_str()) {
            if is_chromium_cache(&path, &name) {
                found.push((app_label(trail), path));
            }
        } else if trail.len() < APP_SEARCH_DEPTH
            && !APP_SEARCH_PRUNE.contains(&name.to_lowercase().as_str())
        {
            let mut deeper = trail.to_vec();
            deeper.push(name);
            find_app_caches(&path, &deeper, found);
        }
    }
}

/// The app's name: its top folder under AppData, or the next one inside a vendor's folder.
fn app_label(trail: &[String]) -> String {
    let in_vendor_folder = VENDOR_FOLDERS.contains(&trail[0].to_lowercase().as_str());
    let at = usize::from(in_vendor_folder && trail.len() > 1);
    trail[at].clone()
}

/// Whether `dir`, named `name`, has the on-disk layout Chromium gives that cache.
///
/// The name alone proves nothing — plenty of programs have a folder called `Cache` holding
/// things they need. The layout is what makes it safe to treat as disposable.
pub fn is_chromium_cache(dir: &Path, name: &str) -> bool {
    let has = |file: &str| dir.join(file).is_file();
    let block_file = || has("index") && (has("data_0") || has("data_1"));
    match name {
        "Cache" => dir.join("Cache_Data").join("index").is_file() || block_file(),
        "Code Cache" => dir.join("js").is_dir() || dir.join("wasm").is_dir(),
        _ => block_file(),
    }
}

/// The real sub-folders of `dir` (links excluded), as `(name, path)`.
fn subfolders(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.metadata().is_ok_and(|md| md.is_dir() && !is_reparse(&md)))
        .map(|entry| (entry.file_name().to_string_lossy().into_owned(), entry.path()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::engine::testing::{Sandbox, write};
    use super::*;

    /// Lays down a Chromium profile's caches the way Chromium does.
    fn chromium_profile(profile: &Path) {
        write(&profile.join("Cache").join("Cache_Data").join("index"), 10);
        write(&profile.join("Cache").join("Cache_Data").join("f_000001"), 500);
        write(&profile.join("Code Cache").join("js").join("index"), 10);
        for file in ["index", "data_0", "data_1"] {
            write(&profile.join("GPUCache").join(file), 10);
        }
    }

    fn paths(target: &Target) -> Vec<&Path> {
        match &target.source {
            Source::Locations(locations) => locations.iter().map(|l| l.path.as_path()).collect(),
            Source::RecycleBin => Vec::new(),
        }
    }

    fn category<'a>(catalog: &'a [Category], id: &str) -> &'a Category {
        catalog.iter().find(|c| c.id == id).unwrap_or_else(|| panic!("no {id} category"))
    }

    #[test]
    fn a_folder_named_cache_is_not_enough() {
        let sandbox = Sandbox::new();
        let app = sandbox.dirs.roaming.join("Notes");
        write(&app.join("Cache").join("my-unsaved-draft.txt"), 10);
        write(&app.join("GPUCache").join("index"), 10);

        assert!(!is_chromium_cache(&app.join("Cache"), "Cache"));
        assert!(!is_chromium_cache(&app.join("GPUCache"), "GPUCache"), "index alone is not the layout");
        assert!(build(&sandbox.dirs).iter().all(|c| c.id != "app_cache"));
    }

    #[test]
    fn app_caches_are_found_and_named_after_the_app() {
        let sandbox = Sandbox::new();
        let (roaming, local) = (&sandbox.dirs.roaming, &sandbox.dirs.local);
        chromium_profile(&roaming.join("discord"));
        chromium_profile(&local.join("discord")); // same app, second AppData folder
        chromium_profile(&roaming.join("Microsoft").join("Teams"));
        chromium_profile(&local.join("Acme").join("Studio").join("EBWebView").join("Default"));
        // Browsers and this app have their own handling and must not show up here.
        chromium_profile(&local.join("Google").join("Chrome").join("User Data").join("Default"));
        chromium_profile(&local.join("com.delpheye.app").join("EBWebView").join("Default"));
        // Too deep to be an app profile.
        chromium_profile(&local.join("a").join("b").join("c").join("d").join("e"));

        let catalog = build(&sandbox.dirs);
        let apps = category(&catalog, "app_cache");
        let labels: Vec<&str> = apps.targets.iter().map(|t| t.label.as_str()).collect();
        assert_eq!(labels, ["Acme", "discord", "Teams"]);

        let discord = &apps.targets[1];
        assert_eq!(paths(discord).len(), 6, "three caches in each of two folders");
        assert!(paths(discord).iter().all(|p| p.ends_with("Cache") || p.ends_with("Code Cache") || p.ends_with("GPUCache")));
    }

    #[test]
    fn browser_targets_cover_caches_and_nothing_else() {
        let sandbox = Sandbox::new();
        let user_data = sandbox.dirs.local.join("Google").join("Chrome").join("User Data");
        for profile in ["Default", "Profile 1"] {
            chromium_profile(&user_data.join(profile));
            write(&user_data.join(profile).join("History"), 10);
            write(&user_data.join(profile).join("Network").join("Cookies"), 10);
            write(&user_data.join(profile).join("Local Storage").join("leveldb").join("000003.log"), 10);
        }
        for file in ["index", "data_0"] {
            write(&user_data.join("ShaderCache").join(file), 10);
        }
        chromium_profile(&user_data.join("Crashpad")); // not a profile folder

        let catalog = build(&sandbox.dirs);
        let chrome = category(&catalog, "browser_chrome");
        let ids: Vec<&str> = chrome.targets.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["Default", "Profile 1", "browser_shared"]);
        assert_eq!(chrome.running_exe, Some("chrome.exe"));

        for target in &chrome.targets {
            for path in paths(target) {
                let name = path.file_name().unwrap().to_str().unwrap();
                assert!(
                    PROFILE_CACHES.contains(&name) || SHARED_CACHES.contains(&name),
                    "{} is not a cache folder",
                    path.display()
                );
            }
        }
    }

    #[test]
    fn opera_profile_in_the_root_is_one_target() {
        let sandbox = Sandbox::new();
        let folder = Path::new("Opera Software").join("Opera Stable");
        chromium_profile(&sandbox.dirs.local.join(&folder));
        write(&sandbox.dirs.roaming.join(&folder).join("GPUCache").join("index"), 10);
        write(&sandbox.dirs.roaming.join(&folder).join("GPUCache").join("data_0"), 10);

        let catalog = build(&sandbox.dirs);
        let opera = category(&catalog, "browser_opera");
        assert_eq!(opera.targets.len(), 1);
        assert_eq!(paths(&opera.targets[0]).len(), 4);
    }

    #[test]
    fn only_what_exists_is_listed() {
        let sandbox = Sandbox::new();
        let dirs = &sandbox.dirs;
        // A bare machine: just the temp folder made by the sandbox.
        let ids: Vec<String> = build(dirs).into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["user_temp"]);

        write(&dirs.windows.join("MEMORY.DMP"), 10);
        write(&dirs.windows.join("Temp").join("x.tmp"), 10);
        write(&dirs.local.join("npm-cache").join("_cacache").join("index-v5").join("aa"), 10);
        write(&dirs.local.join("Microsoft").join("Windows").join("Explorer").join("thumbcache_32.db"), 10);

        let catalog = build(dirs);
        let ids: Vec<&str> = catalog.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["user_temp", "windows_temp", "thumbnails", "memory_dumps", "dev_cache"]);

        assert!(category(&catalog, "windows_temp").targets[0].needs_admin);
        assert!(!category(&catalog, "user_temp").targets[0].needs_admin);
        assert_eq!(category(&catalog, "user_temp").min_age, Some(DAY));
        assert!(catalog.iter().all(|c| c.id != "recycle_bin"), "a fake tree has no recycle bin");
    }
}
