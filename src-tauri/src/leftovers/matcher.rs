//! Deciding whether a folder still belongs to something on this machine.
//!
//! Every rule here leans the same way: when in doubt, a folder counts as owned. A folder
//! wrongly called owned is simply not shown; one wrongly called a leftover is offered for
//! removal. Only the first mistake is cheap.

use std::path::Path;

use super::installed::Installed;

/// Names that belong to Windows, or to housekeeping folders every machine has.
const RESERVED_PREFIXES: &[&str] = &[
    "microsoft",
    "windows",
    "common files",
    "internet explorer",
    "msbuild",
    "reference assemblies",
    "uninstall information",
    "package cache",
    "packages",
    "modifiablewindowsapps",
    "dotnet",
    "temp",
    "tmp",
    "crashdumps",
    "d3dscache",
    "virtualstore",
    "connecteddevicesplatform",
    "comms",
    "publishers",
    "history",
    "application data",
    "elevateddiagnostics",
    "placeholdertilelogofolder",
    "peerdistrepub",
    "programs",
    "regid.",
    "ssh",
    "usoshared",
    "usoprivate",
    "softwaredistribution",
    "desktop",
    "documents",
    "start menu",
    "templates",
    "favorites",
    "dbg",
    "assembly",
    "identities",
    "fontcache",
];

/// Words that say what kind of company a publisher is, not which one.
const COMPANY_WORDS: &[&str] = &[
    "inc", "llc", "ltd", "limited", "corporation", "corp", "co", "gmbh", "ag", "sa", "srl", "bv", "plc", "pty", "oy",
    "ab", "as", "kg", "sro",
];

/// DelphEye's own folders: skipped by exact name, so other apps starting the same way are not.
const OWN_FOLDERS: &[&str] = &["delpheye", "com.delpheye.app"];

pub fn is_reserved(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower.starts_with(['.', '{', '$'])
        || OWN_FOLDERS.contains(&lower.as_str())
        || RESERVED_PREFIXES.iter().any(|prefix| lower.starts_with(prefix))
}

/// Letters and digits only, lower-cased: "Riot Games, Inc." becomes "riotgamesinc".
pub fn norm(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// A publisher name without its legal form: "Riot Games, Inc." becomes "riotgames".
fn publisher_norm(text: &str) -> String {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty() && !COMPANY_WORDS.contains(&word.to_lowercase().as_str()))
        .map(norm)
        .collect()
}

fn without_digits(text: &str) -> String {
    text.chars().filter(|c| !c.is_ascii_digit()).collect()
}

/// Whether the folder name `folder` and the program name `name` (both normalised) agree.
fn names_agree(folder: &str, name: &str) -> bool {
    if folder.is_empty() || name.is_empty() {
        return false;
    }
    let (short_folder, short_name) = (without_digits(folder), without_digits(name));
    folder == name
        || (folder.len() >= 4 && name.contains(folder))
        || (name.len() >= 5 && folder.contains(name))
        || (short_folder.len() >= 3 && short_folder == short_name)
}

/// Lower-cased, without a trailing backslash, for comparing paths as text.
fn path_key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().trim_end_matches('\\').to_string()
}

/// `inner` is `outer` or lies somewhere inside it.
fn within(inner: &str, outer: &str) -> bool {
    inner == outer || (inner.len() > outer.len() && inner.starts_with(outer) && inner.as_bytes()[outer.len()] == b'\\')
}

/// Everything known to be in use: names and folders of installed and running programs.
#[derive(Default)]
pub struct Owners {
    names: Vec<String>,
    paths: Vec<String>,
}

impl Owners {
    pub fn new(installed: &[Installed], folders: &[std::path::PathBuf], running_names: &[String]) -> Self {
        let mut owners = Self::default();
        for program in installed {
            owners.names.push(norm(&program.name));
            owners.names.push(publisher_norm(&program.publisher));
            for path in &program.paths {
                owners.add_path(path);
            }
        }
        for folder in folders {
            owners.add_path(folder);
        }
        owners.names.extend(running_names.iter().map(|name| norm(name)));
        owners.names.retain(|name| !name.is_empty());
        owners.names.sort_unstable();
        owners.names.dedup();
        owners
    }

    fn add_path(&mut self, path: &Path) {
        let key = path_key(path);
        // A path naming a whole drive would make everything on it "owned"; it says nothing.
        if key.matches('\\').count() >= 1 {
            self.names.extend(path.file_name().map(|name| norm(&name.to_string_lossy())));
            self.paths.push(key);
        }
    }

    /// Whether the folder at `path` belongs to something installed or running.
    pub fn owns(&self, path: &Path) -> bool {
        let folder = path_key(path);
        if self.paths.iter().any(|owned| within(owned, &folder) || within(&folder, owned)) {
            return true;
        }
        let name = path.file_name().map(|n| norm(&n.to_string_lossy())).unwrap_or_default();
        self.names.iter().any(|known| names_agree(&name, known))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn program(name: &str, publisher: &str, paths: &[&str]) -> Installed {
        Installed { name: name.into(), publisher: publisher.into(), paths: paths.iter().map(PathBuf::from).collect() }
    }

    fn owners() -> Owners {
        Owners::new(
            &[
                program("Call to Arms - Gates of Hell", "Digitalmindsoft", &[r"C:\Program Files (x86)\Steam\steamapps\common\Call to Arms - Gates of Hell"]),
                program("Riot Client", "Riot Games, Inc.", &[r"C:\Riot Games\Riot Client"]),
                program("Telegram Desktop 5.2", "Telegram FZ-LLC", &[r"C:\Users\me\AppData\Roaming\Telegram Desktop"]),
                program("7-Zip 24.08 (x64)", "Igor Pavlov", &[r"C:\Program Files\7-Zip"]),
                program("Bad entry", "", &[r"C:\"]),
            ],
            &[PathBuf::from(r"C:\Program Files\Vendor\Service")],
            &["discord.exe".to_string()],
        )
    }

    #[test]
    fn folders_of_installed_and_running_programs_are_owned() {
        let owners = owners();
        let owned = [
            r"C:\Program Files\7-Zip",
            r"C:\Users\me\AppData\Roaming\Telegram Desktop",
            r"C:\Users\me\AppData\Local\Riot Games",
            r"C:\Users\me\AppData\Local\Gates of Hell",
            r"C:\Users\me\AppData\Local\digitalmindsoft",
            r"C:\Program Files\Vendor",
            r"C:\Users\me\AppData\Roaming\discord",
            r"C:\Users\me\AppData\Roaming\Telegram",
        ];
        for path in owned {
            assert!(owners.owns(Path::new(path)), "{path} should be owned");
        }
    }

    #[test]
    fn unrelated_folders_are_not_owned() {
        let owners = owners();
        let free = [
            r"C:\Users\me\AppData\Roaming\OldPhotoEditor",
            r"C:\Program Files\Some Removed Tool",
            r"C:\ProgramData\Acme",
            r"C:\Users\me\AppData\Local\Unzipper",
            r"C:\Users\me\AppData\Local\Arms Dealer",
        ];
        for path in free {
            assert!(!owners.owns(Path::new(path)), "{path} should not be owned");
        }
    }

    #[test]
    fn names_are_compared_without_punctuation_or_legal_forms() {
        assert_eq!(norm("Riot Games, Inc."), "riotgamesinc");
        assert_eq!(publisher_norm("Riot Games, Inc."), "riotgames");
        assert_eq!(publisher_norm("JetBrains s.r.o."), "jetbrainssro");
        assert_eq!(norm("Ступінь 2"), "ступінь2");
        assert!(names_agree("foo", "foo2"), "a version number does not make it another program");
        assert!(!names_agree("", "foo"));
    }

    #[test]
    fn windows_and_housekeeping_folders_are_reserved() {
        for name in ["Microsoft", "WindowsPowerShell", "Common Files", "Packages", "Temp", "{F1A2}", ".cache", "DelphEye"] {
            assert!(is_reserved(name), "{name}");
        }
        for name in ["Acme", "Riot Games", "Steam", "DelphEyeTestLeftover"] {
            assert!(!is_reserved(name), "{name}");
        }
    }
}
