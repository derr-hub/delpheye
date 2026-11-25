//! A program as the machine sees it: what it was built with, which parts of Windows it calls, and, for
//! a crash, the very instructions it stopped at. Files are only read, never run.

use std::path::Path;

use goblin::pe::PE;
use iced_x86::{Decoder, DecoderOptions, Formatter, IntelFormatter, Mnemonic, OpKind};
use serde::Serialize;

const LIMIT: u64 = 1 << 30;

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Line {
    /// Address inside the file's image.
    pub at: String,
    pub bytes: String,
    pub text: String,
    /// The instruction the fault was reported at.
    pub here: bool,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Import {
    pub dll: String,
    pub count: usize,
    pub names: Vec<String>,
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Code {
    /// "x64", "x86", "arm64" or "other".
    pub arch: &'static str,
    pub linker: String,
    pub size: u64,
    /// What it seems to be made with: "dotnet", "python", "qt", "cpp", "electron", "unity", "unreal"…
    pub made: Vec<&'static str>,
    pub imports: Vec<Import>,
    pub sections: Vec<(String, u64)>,
    /// The file on disk is the one that crashed (its build stamp matches). None: not asked.
    pub same: Option<bool>,
    /// The function around the address, from the file's own tables.
    pub function: Option<(String, String)>,
    pub lines: Vec<Line>,
    /// What the faulting instruction was doing with memory: "read", "write", "jump" or "none".
    pub access: Option<&'static str>,
    pub hex: Vec<String>,
    /// The named function shown, when one was asked for and is there.
    pub symbol: Option<String>,
    /// Functions the file offers to others, by name.
    pub exports: Vec<String>,
    pub export_count: usize,
    /// What it can do, from what it calls: "net", "files", "registry"…
    pub abilities: Vec<&'static str>,
    /// Protections built in: random address, no running of data, guarded calls.
    pub aslr: bool,
    pub dep: bool,
    pub cfg: bool,
    /// Parts that can be both written and run, and parts that look packed.
    pub writable_code: Vec<String>,
    pub packed: Vec<String>,
    /// Libraries it needs that are nowhere to be found.
    pub missing: Vec<String>,
    /// When the file was last changed, unix seconds.
    pub modified: i64,
}

fn abilities(pe: &PE) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    let mut add = |a: &'static str| {
        if !out.contains(&a) {
            out.push(a);
        }
    };
    for i in &pe.imports {
        let (dll, f) = (i.dll.to_lowercase(), i.name.as_ref());
        let d = |p: &[&str]| p.iter().any(|x| dll.starts_with(x));
        let n = |p: &[&str]| p.iter().any(|x| f.starts_with(x));
        if d(&["ws2_32", "winhttp", "wininet", "mswsock", "ndis", "netio", "fwpkclnt"]) {
            add("net");
        }
        if d(&["d3d", "dxgi", "vulkan", "opengl32", "gdi32", "dxgkrnl", "nvapi"]) {
            add("graphics");
        }
        if d(&["xaudio", "dsound", "mmdevapi", "winmm", "avrt", "portcls"]) {
            add("sound");
        }
        if d(&["bcrypt", "crypt32", "ncrypt", "cng"]) {
            add("crypto");
        }
        if d(&["user32", "comctl32", "uxtheme", "win32u"]) {
            add("windows");
        }
        if d(&["hid", "xinput", "dinput", "setupapi", "cfgmgr32", "hal.dll"]) {
            add("devices");
        }
        if d(&["ntoskrnl"]) {
            add("kernel");
        }
        if n(&["CreateFile", "ReadFile", "WriteFile", "DeleteFile", "FindFirstFile", "NtCreateFile", "ZwCreateFile", "FltRegisterFilter"]) {
            add("files");
        }
        if n(&["RegOpenKey", "RegSetValue", "RegQueryValue", "RegCreateKey", "ZwOpenKey", "ZwSetValueKey"]) {
            add("registry");
        }
        if n(&["CreateProcess", "ShellExecute", "OpenProcess", "TerminateProcess", "PsSetCreateProcessNotify"]) {
            add("processes");
        }
        if n(&["CreateService", "StartService", "OpenSCManager", "RegisterServiceCtrlHandler"]) {
            add("services");
        }
        if n(&["SetWindowsHookEx", "GetAsyncKeyState", "RegisterRawInputDevices"]) {
            add("input");
        }
        if n(&["WriteProcessMemory", "CreateRemoteThread", "NtWriteVirtualMemory", "QueueUserAPC"]) {
            add("inject");
        }
    }
    out
}

/// Bits of surprise per byte: ordinary code has about 6, packed or encrypted data nearly 8.
fn entropy(data: &[u8]) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let mut n = [0u32; 256];
    data.iter().for_each(|b| n[*b as usize] += 1);
    let all = data.len() as f64;
    n.iter().filter(|c| **c > 0).map(|c| *c as f64 / all).map(|p| -p * p.log2()).sum()
}

/// Libraries named by the file that neither its folder nor Windows has. Names Windows maps by itself
/// (`api-ms-…`) and kernel files are not looked for.
fn missing(pe: &PE, path: &Path) -> Vec<String> {
    let windows = crate::system::Dirs::real().map(|d| d.windows);
    // Chrome and others keep theirs in a folder of their own version.
    let folders: Vec<std::path::PathBuf> = path.parent().and_then(|d| std::fs::read_dir(d).ok()).into_iter().flatten().flatten().filter(|e| e.file_type().is_ok_and(|k| k.is_dir())).map(|e| e.path()).take(60).collect();
    let mut out: Vec<String> = Vec::new();
    for dll in &pe.libraries {
        let l = dll.to_lowercase();
        if l.starts_with("api-ms-") || l.starts_with("ext-ms-") || !l.ends_with(".dll") || out.contains(&l) {
            continue;
        }
        let near = path.parent().is_some_and(|d| d.join(&l).exists()) || folders.iter().any(|d| d.join(&l).exists());
        let there = windows.as_ref().is_some_and(|w| ["System32", "SysWOW64", "System32\\drivers", "System32\\downlevel"].iter().any(|s| w.join(s).join(&l).exists()));
        if !near && !there {
            out.push(l);
        }
    }
    out.truncate(6);
    out
}

fn made(imports: &[Import], path: &Path) -> Vec<&'static str> {
    let has = |p: &str| imports.iter().any(|i| i.dll.to_lowercase().starts_with(p));
    let mut out = Vec::new();
    let signs = [
        ("mscoree", "dotnet"),
        ("python3", "python"),
        ("qt5", "qt"),
        ("qt6", "qt"),
        ("unityplayer", "unity"),
        ("d3d12", "graphics"),
        ("d3d11", "graphics"),
        ("vulkan-1", "graphics"),
        ("opengl32", "graphics"),
        ("vcruntime", "cpp"),
        ("msvcp", "cpp"),
        ("api-ms-win-crt", "cpp"),
        ("msvcrt", "c"),
    ];
    for (prefix, name) in signs {
        if has(prefix) && !out.contains(&name) {
            out.push(name);
        }
    }
    let near = |f: &str| path.parent().is_some_and(|d| d.join(f).exists());
    if near("resources/app.asar") || near("v8_context_snapshot.bin") {
        out.push("electron");
    }
    if near("UnityPlayer.dll") && !out.contains(&"unity") {
        out.push("unity");
    }
    if path.to_string_lossy().contains("-Win64-Shipping") {
        out.push("unreal");
    }
    out
}

fn decode(bits: u32, bytes: &[u8], ip: u64, stop: u64, after: u64) -> (Vec<Line>, Option<&'static str>) {
    let mut decoder = Decoder::with_ip(bits, bytes, ip, DecoderOptions::NONE);
    let mut formatter = IntelFormatter::new();
    let mut lines: Vec<Line> = Vec::new();
    let mut access = None;
    while decoder.can_decode() {
        let i = decoder.decode();
        let at = i.ip();
        let here = stop >= at && stop < at + i.len().max(1) as u64;
        if at > stop + after {
            break;
        }
        let mut text = String::new();
        formatter.format(&i, &mut text);
        let from = (at - ip) as usize;
        let until = (from + i.len()).min(bytes.len());
        lines.push(Line { at: format!("{at:x}"), bytes: bytes[from..until].iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" "), text, here });
        if here {
            let memory = |n: u32| i.op_count() > n && i.op_kind(n) == OpKind::Memory;
            let reads = matches!(i.mnemonic(), Mnemonic::Cmp | Mnemonic::Test | Mnemonic::Push);
            access = Some(if matches!(i.mnemonic(), Mnemonic::Call | Mnemonic::Jmp) && matches!(i.op_kind(0), OpKind::Memory | OpKind::Register) {
                "jump"
            } else if memory(0) && !reads {
                "write"
            } else if memory(0) || memory(1) || memory(2) {
                "read"
            } else {
                "none"
            });
        }
    }
    // Enough before the fault to see what led to it.
    if let Some(k) = lines.iter().position(|l| l.here) {
        lines.drain(..k.saturating_sub(9));
    }
    lines.truncate(if after > 24 { 26 } else { 14 });
    (lines, access)
}

/// `offset` is the fault's address relative to the image, `stamp` the build stamp Windows recorded.
pub fn read(path: &Path, offset: Option<u64>, stamp: Option<u32>, symbol: Option<&str>) -> Option<Code> {
    let file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 || size > LIMIT {
        return None;
    }
    // SAFETY: mapped read-only; a file changed meanwhile could at worst give wrong bytes to show.
    let map = unsafe { memmap2::Mmap::map(&file).ok()? };
    let mut code = parse(&map, path, size, offset, stamp, symbol)?;
    code.modified = file.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
    Some(code)
}

fn parse(data: &[u8], path: &Path, size: u64, offset: Option<u64>, stamp: Option<u32>, symbol: Option<&str>) -> Option<Code> {
    // Only what is shown is read, and one odd table does not hide the whole file; if its list of calls cannot
    // be read at all, the rest still can.
    let mut how = goblin::pe::options::ParseOptions::default().with_parse_mode(goblin::pe::options::ParseMode::Permissive).with_parse_tls_data(false).with_parse_resources(false);
    how.parse_attribute_certificates = false;
    let pe = PE::parse_with_opts(data, &how).or_else(|_| PE::parse_with_opts(data, &how.with_parse_imports(false))).ok()?;
    let (arch, bits) = match pe.header.coff_header.machine {
        0x8664 => ("x64", 64),
        0x14c => ("x86", 32),
        0xaa64 => ("arm64", 0),
        _ => ("other", 0),
    };
    let mut imports: Vec<Import> = Vec::new();
    for i in &pe.imports {
        match imports.iter_mut().find(|x| x.dll.eq_ignore_ascii_case(i.dll)) {
            Some(x) => {
                x.count += 1;
                if x.names.len() < 5 {
                    x.names.push(i.name.to_string());
                }
            }
            None => imports.push(Import { dll: i.dll.to_string(), count: 1, names: vec![i.name.to_string()] }),
        }
    }
    let mut out = Code {
        arch,
        linker: pe.header.optional_header.map(|o| format!("{}.{}", o.standard_fields.major_linker_version, o.standard_fields.minor_linker_version)).unwrap_or_default(),
        size,
        made: made(&imports, path),
        sections: pe.sections.iter().map(|s| (s.name().unwrap_or("?").to_string(), s.virtual_size as u64)).take(12).collect(),
        imports,
        same: stamp.map(|s| s == pe.header.coff_header.time_date_stamp),
        ..Default::default()
    };
    let traits = pe.header.optional_header.map(|o| o.windows_fields.dll_characteristics).unwrap_or(0);
    (out.aslr, out.dep, out.cfg) = (traits & 0x40 != 0, traits & 0x100 != 0, traits & 0x4000 != 0);
    for s in &pe.sections {
        let name = s.name().unwrap_or("?").to_string();
        let (run, write) = (s.characteristics & 0x2000_0000 != 0, s.characteristics & 0x8000_0000 != 0);
        // Drivers throw INIT away once they have started.
        if run && write && name != "INIT" {
            out.writable_code.push(name.clone());
        }
        let (a, b) = (s.pointer_to_raw_data as usize, (s.pointer_to_raw_data as usize + s.size_of_raw_data as usize).min(data.len()));
        if run && b > a + 4096 && entropy(&data[a..b.min(a + 4_000_000)]) > 7.3 {
            out.packed.push(name);
        }
    }
    out.abilities = abilities(&pe);
    out.missing = missing(&pe, path);
    let named: Vec<(&str, u64)> = pe.exports.iter().filter(|e| e.reexport.is_none() && e.rva != 0).filter_map(|e| Some((e.name?, e.rva as u64))).collect();
    out.export_count = named.len();
    let asked = symbol.and_then(|s| named.iter().find(|n| n.0 == s)).copied();
    out.symbol = asked.map(|a| a.0.to_string());
    out.exports = named.iter().take(60).map(|n| n.0.to_string()).collect();
    out.imports.sort_by(|a, b| b.count.cmp(&a.count));
    out.imports.truncate(24);
    let rva = match offset {
        // Bytes of another build at this address would be a story about the wrong code.
        Some(_) if out.same == Some(false) => return Some(out),
        Some(o) => o,
        None => match asked.or(if pe.entry == 0 { named.first().copied() } else { None }) {
            Some(a) => a.1,
            None => pe.entry as u64,
        },
    };
    let Some(section) = pe.sections.iter().find(|s| rva >= s.virtual_address as u64 && rva < s.virtual_address as u64 + s.virtual_size.max(s.size_of_raw_data) as u64) else { return Some(out) };
    let place = |r: u64| (r - section.virtual_address as u64) as usize + section.pointer_to_raw_data as usize;
    let end = (section.pointer_to_raw_data as usize + section.size_of_raw_data as usize).min(data.len());
    let here = place(rva);
    if here >= end {
        return Some(out);
    }
    let found = pe.exception_data.as_ref().and_then(|e| e.find_function(rva as u32).ok().flatten());
    let function = found.map(|f| (f.begin_address as u64, f.end_address as u64)).filter(|f| f.0 <= rva && f.0 >= section.virtual_address as u64);
    out.function = function.map(|(a, b)| (format!("{a:x}"), format!("{b:x}")));
    if bits != 0 {
        // From the function's own start instructions line up; without it, from the address itself.
        let from = function.map(|f| f.0).filter(|a| rva - a < 65_536).unwrap_or(rva);
        let after = if offset.is_some() { 24 } else { 120 };
        let until = (here + after as usize + 40).min(end);
        let (lines, access) = decode(bits, &data[place(from)..until], from, rva, after);
        out.lines = lines;
        out.access = access.filter(|_| offset.is_some());
    }
    let start = here.saturating_sub(16).max(section.pointer_to_raw_data as usize);
    out.hex = data[start..(start + 64).min(end)].chunks(16).map(|c| c.iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(" ")).collect();
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn instructions_around_a_fault_are_found() {
        // xor eax,eax; mov rcx,[rax]; ret
        let (lines, access) = decode(64, &[0x31, 0xc0, 0x48, 0x8b, 0x08, 0xc3], 0x1000, 0x1002, 24);
        assert_eq!(lines.iter().map(|l| (l.at.as_str(), l.here)).collect::<Vec<_>>(), vec![("1000", false), ("1002", true), ("1005", false)]);
        assert!(lines[1].text.contains("rcx"), "{}", lines[1].text);
        assert_eq!(access, Some("read"));
        // mov [rax],rcx
        assert_eq!(decode(64, &[0x48, 0x89, 0x08], 0, 0, 24).1, Some("write"));
    }

    #[test]
    fn a_windows_library_reads_as_one() {
        let file = Path::new(r"C:\Windows\System32\kernelbase.dll");
        let c = read(file, None, None, None).unwrap();
        assert!(c.aslr && c.dep && c.missing.is_empty() && c.packed.is_empty(), "{:?} {:?}", c.missing, c.packed);
        let f = read(file, None, None, Some("CreateFileW")).unwrap();
        assert_eq!(f.symbol.as_deref(), Some("CreateFileW"));
        assert!(f.lines.len() > 5 && f.abilities.contains(&"registry") || !f.lines.is_empty());
        assert!(matches!(c.arch, "x64" | "arm64"));
        assert!(c.imports.iter().any(|i| i.dll.eq_ignore_ascii_case("ntdll.dll")));
        assert!(!c.sections.is_empty());
        let c = read(file, Some(0x2000), Some(1), None).unwrap();
        assert_eq!((c.same, c.lines.len(), c.hex.len()), (Some(false), 0, 0), "another build's bytes are not shown");
        assert!(read(Path::new(r"C:\Windows\win.ini"), None, None, None).is_none());
        assert!(read(Path::new(r"C:\no\such.exe"), None, None, None).is_none());
    }
}
