//! Processes DelphEye can explain by name. The explanations themselves live in the UI's
//! translations under `processes.known.<id>`; this table only says which names belong to which
//! explanation, whether the real one lives in the Windows folder, and how dangerous ending it is.

use serde::Serialize;

/// What ending a process does to the machine.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    /// Windows cannot run without it: ending it crashes the system or signs the user out.
    Critical,
    /// A part of Windows: ending it breaks a feature until it restarts.
    Windows,
    /// An ordinary program: ending it closes the program and loses unsaved work.
    App,
    /// DelphEye itself or its sensor helper.
    Own,
}

pub struct Known {
    pub id: &'static str,
    /// The genuine file lives in the Windows folder; anywhere else it is an impostor.
    pub in_windows: bool,
    pub level: Level,
}

use Level::*;

/// (explanation id, executable names without ".exe", genuine file in the Windows folder, level)
const TABLE: &[(&str, &[&str], bool, Level)] = &[
    ("system", &["system"], false, Critical),
    ("registry", &["registry"], false, Critical),
    ("memcompression", &["memory compression"], false, Critical),
    ("securesystem", &["secure system"], false, Critical),
    ("smss", &["smss"], true, Critical),
    ("csrss", &["csrss"], true, Critical),
    ("wininit", &["wininit"], true, Critical),
    ("winlogon", &["winlogon"], true, Critical),
    ("services", &["services"], true, Critical),
    ("lsass", &["lsass", "lsaiso"], true, Critical),
    ("svchost", &["svchost"], true, Windows),
    ("fontdrvhost", &["fontdrvhost"], true, Windows),
    ("dwm", &["dwm"], true, Windows),
    ("explorer", &["explorer"], true, Windows),
    ("sihost", &["sihost"], true, Windows),
    ("taskhostw", &["taskhostw"], true, Windows),
    ("runtimebroker", &["runtimebroker"], true, Windows),
    ("searchhost", &["searchhost", "searchapp", "searchui"], true, Windows),
    ("searchindexer", &["searchindexer", "searchprotocolhost", "searchfilterhost"], true, Windows),
    ("startmenu", &["startmenuexperiencehost"], true, Windows),
    ("shellhost", &["shellexperiencehost", "shellhost"], true, Windows),
    ("textinput", &["textinputhost", "ctfmon"], true, Windows),
    ("conhost", &["conhost"], true, Windows),
    ("dllhost", &["dllhost"], true, Windows),
    ("audiodg", &["audiodg"], true, Windows),
    ("spoolsv", &["spoolsv"], true, Windows),
    ("wmiprvse", &["wmiprvse", "unsecapp"], true, Windows),
    ("defender", &["msmpeng", "nissrv", "mpdefendercoreservice", "msmpengcp", "mpcmdrun"], false, Windows),
    ("securityhealth", &["securityhealthservice", "securityhealthsystray", "securityhealthhost"], true, Windows),
    ("smartscreen", &["smartscreen"], true, Windows),
    ("sgrmbroker", &["sgrmbroker"], true, Windows),
    ("appframe", &["applicationframehost"], true, Windows),
    ("settings", &["systemsettings", "systemsettingsbroker"], false, Windows),
    ("lockapp", &["lockapp"], false, Windows),
    ("backgroundtask", &["backgroundtaskhost"], true, Windows),
    ("wudfhost", &["wudfhost"], true, Windows),
    ("dashost", &["dashost"], true, Windows),
    ("update", &["mousocoreworker", "usocoreworker", "tiworker", "trustedinstaller", "wuauclt", "sihclient", "musnotification", "musnotifyicon", "uhssvc"], false, Windows),
    ("msiexec", &["msiexec"], true, Windows),
    ("werfault", &["werfault", "wermgr"], true, Windows),
    ("sppsvc", &["sppsvc"], true, Windows),
    ("rundll32", &["rundll32"], true, Windows),
    ("vmmem", &["vmmem", "vmmemwsl", "vmcompute", "vmwp"], false, Windows),
    ("widgets", &["widgets", "widgetservice", "widgetboard"], false, App),
    ("phonelink", &["phoneexperiencehost", "yourphone", "crossdeviceservice", "crossdeviceresume"], false, App),
    ("gamebar", &["gamebar", "gamebarftserver", "gamebarpresencewriter", "gameinputsvc"], false, App),
    ("webview2", &["msedgewebview2"], false, App),
    ("terminal", &["windowsterminal", "openconsole"], false, App),
    ("shell", &["powershell", "pwsh", "cmd"], false, App),
    ("wsl", &["wsl", "wslhost", "wslservice", "wslrelay"], false, App),
    ("node", &["node"], false, App),
    ("edge", &["msedge"], false, App),
    ("chrome", &["chrome"], false, App),
    ("firefox", &["firefox"], false, App),
    ("browser", &["brave", "opera", "opera_gx", "vivaldi", "arc"], false, App),
    ("discord", &["discord"], false, App),
    ("steam", &["steam", "steamwebhelper", "steamservice"], false, App),
    ("epic", &["epicgameslauncher", "epicwebhelper", "epiconlineservices", "epiconlineserviceshost"], false, App),
    ("ea", &["eadesktop", "eabackgroundservice", "ealocalhostsvc", "eaconnect_microsoft"], false, App),
    ("telegram", &["telegram"], false, App),
    ("spotify", &["spotify"], false, App),
    ("vscode", &["code"], false, App),
    ("onedrive", &["onedrive", "onedrive.sync.service", "filecoauth"], false, App),
    ("teams", &["ms-teams", "teams", "msteams"], false, App),
    ("vanguard", &["vgc", "vgtray", "vgm"], false, App),
    ("faceit", &["faceit", "faceitservice", "faceitclient"], false, App),
    ("nvidia", &["nvcontainer", "nvdisplay.container", "nvidia web helper", "nvidia share", "nvidia overlay", "nvsphelper64", "nvbackend", "nvidia app", "nvcplui"], false, App),
    ("intelgfx", &["igfxem", "igfxcuiservice", "igfxhk", "igfxtray", "intelcphdcpsvc", "intelcphecisvc", "igcc", "igcctray", "intelgraphicssoftware", "intelaudioservice", "jhi_service", "lms", "esrv", "esrv_svc"], false, App),
    ("realtek", &["rtkauduservice64", "rtkaudioservice", "rtkngui64", "realtekaudioservice"], false, App),
    ("asus", &["asussystemanalysis", "asussystemdiagnosis", "asusoptimization", "asusoptimizationstartuptask", "asusswitch", "asussoftwaremanager", "asussoftwaremanageragent", "asuslinknear", "asuslinkremote", "atkexcomsvc", "armourycrate.service", "armourycrateservice", "armourycrate.usersessionhelper", "myasus", "asusappservice", "asuscertservice"], false, App),
    ("eset", &["ekrn", "egui", "eguiproxy", "ecmds", "ecls", "eamonm"], false, App),
    ("delpheye", &["delpheye", "delpheye.sensors"], false, Own),
];

/// The name as Windows shows it, lower-cased and without ".exe".
pub fn key(name: &str) -> String {
    let lower = name.to_lowercase();
    lower.strip_suffix(".exe").map(str::to_string).unwrap_or(lower)
}

pub fn lookup(name: &str) -> Option<Known> {
    let key = key(name);
    TABLE.iter().find(|(_, names, _, _)| names.contains(&key.as_str())).map(|(id, _, in_windows, level)| Known { id, in_windows: *in_windows, level: *level })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_matched_without_case_or_extension() {
        let k = lookup("LSASS.EXE").unwrap();
        assert_eq!((k.id, k.level, k.in_windows), ("lsass", Level::Critical, true));
        assert_eq!(lookup("Memory Compression").unwrap().id, "memcompression");
        assert_eq!(lookup("steamwebhelper.exe").unwrap().id, "steam");
        assert!(lookup("svchost32.exe").is_none());
    }

    #[test]
    fn every_name_appears_once() {
        let mut seen = std::collections::HashSet::new();
        for (_, names, _, _) in TABLE {
            for name in *names {
                assert!(seen.insert(*name), "{name} is listed twice");
                assert_eq!(*name, name.to_lowercase(), "{name} must be lower-case");
            }
        }
    }
}
