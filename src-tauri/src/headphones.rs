//! Bluetooth headphones shared with a phone: take them to this computer, or let them go, in one step.
//!
//! Taking asks Windows' Bluetooth audio driver to reconnect the headphones' sound (the headphones
//! leave the phone by themselves). Letting go drops the Bluetooth link: the driver's own "disconnect"
//! answers "ok" and does nothing on some machines (Intel's audio offload). The outcome is therefore
//! always read from the link and the sound device, never from what a call returned.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use windows::Win32::Devices::Bluetooth::*;
use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::Media::Audio::*;
use windows::Win32::Media::KernelStreaming::{IKsControl, KSIDENTIFIER, KSIDENTIFIER_0_0};
use windows::Win32::System::Com::{CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize, STGM_READ};
use windows::Win32::System::IO::DeviceIoControl;
use windows::core::{GUID, Interface, PCWSTR};

use crate::journal::Journal;

const KSPROPSETID_BT_AUDIO: GUID = GUID::from_u128(0x7FA06C40_B8F6_4C7E_8556_E8C33A12E54D);
const ONESHOT_RECONNECT: u32 = 0;
const KSPROPERTY_TYPE_GET: u32 = 1;
const IOCTL_BTH_DISCONNECT_DEVICE: u32 = 0x0041_000C;
/// The Bluetooth class of device's major class for audio (headphones, headsets, speakers).
const MAJOR_AUDIO: u32 = 4;

/// Sound is usually ready 12-16 s after asking; past this it will not come.
const GIVE_UP: Duration = Duration::from_secs(45);
/// Linked for this long and still silent: start over once.
const START_OVER: Duration = Duration::from_secs(25);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Headphones {
    /// The Bluetooth address, as hex.
    pub id: String,
    pub name: String,
    /// The Bluetooth link to this computer is up.
    pub linked: bool,
    /// Their sound device is ready to play.
    pub ready: bool,
}

#[derive(Default)]
pub struct HeadphonesState {
    busy: AtomicBool,
    /// What is going on now, for a panel that opens midway.
    now: Mutex<Option<serde_json::Value>>,
}

// ───────────────────────── Windows ─────────────────────────

struct Radio(HANDLE);
impl Drop for Radio {
    fn drop(&mut self) {
        // SAFETY: the handle came from BluetoothFindFirstRadio and is closed once.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

fn radio() -> Option<Radio> {
    // SAFETY: the structures carry their own sizes; both handles are closed.
    unsafe {
        let mut h = HANDLE::default();
        let p = BLUETOOTH_FIND_RADIO_PARAMS { dwSize: size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32 };
        let find = BluetoothFindFirstRadio(&p, &mut h).ok()?;
        let _ = BluetoothFindRadioClose(find);
        Some(Radio(h))
    }
}

/// Paired audio devices: (address, name, linked).
fn paired() -> Vec<(u64, String, bool)> {
    let Some(radio) = radio() else { return Vec::new() };
    let mut out = Vec::new();
    // SAFETY: as above; no inquiry is issued, so nothing is searched for in the air.
    unsafe {
        let p = BLUETOOTH_DEVICE_SEARCH_PARAMS {
            dwSize: size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
            fReturnAuthenticated: true.into(),
            fReturnRemembered: true.into(),
            fReturnUnknown: false.into(),
            fReturnConnected: true.into(),
            fIssueInquiry: false.into(),
            cTimeoutMultiplier: 0,
            hRadio: radio.0,
        };
        let mut d = BLUETOOTH_DEVICE_INFO { dwSize: size_of::<BLUETOOTH_DEVICE_INFO>() as u32, ..Default::default() };
        let Ok(find) = BluetoothFindFirstDevice(&p, &mut d) else { return out };
        loop {
            // Some (Galaxy Buds4 Pro) report no class at all: then their installed services tell.
            if is_audio(d.ulClassofDevice) || (d.ulClassofDevice == 0 && plays_sound(radio.0, &d)) {
                let end = d.szName.iter().position(|c| *c == 0).unwrap_or(d.szName.len());
                let address = d.Address.Anonymous.ullLong;
                out.push((address, String::from_utf16_lossy(&d.szName[..end]), d.fConnected.as_bool()));
            }
            if BluetoothFindNextDevice(find, &mut d).is_err() {
                break;
            }
        }
        let _ = BluetoothFindDeviceClose(find);
    }
    out
}

/// Windows has installed "plays sound" services for it: A2DP sink, headset or hands-free.
/// (A phone has the opposite ends: audio source and gateway.)
fn plays_sound(radio: HANDLE, d: &BLUETOOTH_DEVICE_INFO) -> bool {
    let mut services = [GUID::zeroed(); 32];
    let mut n = services.len() as u32;
    // SAFETY: `n` says how many GUIDs fit and comes back as how many there are.
    let status = unsafe { BluetoothEnumerateInstalledServices(Some(radio), d, &mut n, Some(services.as_mut_ptr())) };
    status == 0 && services[..(n as usize).min(services.len())].iter().any(|g| is_sink(g))
}

fn is_sink(service: &GUID) -> bool {
    matches!(service.data1, 0x110B | 0x1108 | 0x111E) && service.data2 == 0 && service.data3 == 0x1000
}

fn is_audio(class: u32) -> bool {
    (class >> 8) & 0x1f == MAJOR_AUDIO
}

fn drop_link(address: u64) {
    let Some(radio) = radio() else { return };
    let mut got = 0u32;
    // SAFETY: the input is the 8-byte address the IOCTL expects and outlives the call.
    unsafe {
        let _ = DeviceIoControl(radio.0, IOCTL_BTH_DISCONNECT_DEVICE, Some(&address as *const u64 as *const _), 8, None, 0, Some(&mut got), None);
    }
}

/// COM for the current thread, released at the end of the scope.
struct Com(bool);
impl Com {
    fn new() -> Self {
        // SAFETY: balanced by CoUninitialize in Drop when it succeeded.
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}
impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: see `new`.
            unsafe { CoUninitialize() }
        }
    }
}

unsafe fn device_name(d: &IMMDevice) -> String {
    unsafe { d.OpenPropertyStore(STGM_READ).and_then(|s| s.GetValue(&PKEY_Device_FriendlyName)).map(|v| v.to_string()).unwrap_or_default() }
}

/// Playback devices, plugged in or not, with the names Windows shows: "Headphones (Buds4 Pro)".
fn outputs(e: &IMMDeviceEnumerator) -> Vec<(IMMDevice, String, bool)> {
    // SAFETY: plain COM calls on live interfaces.
    unsafe {
        let Ok(all) = e.EnumAudioEndpoints(eRender, DEVICE_STATE(DEVICE_STATE_ACTIVE.0 | DEVICE_STATE_UNPLUGGED.0)) else { return Vec::new() };
        (0..all.GetCount().unwrap_or(0))
            .filter_map(|i| {
                let d = all.Item(i).ok()?;
                let active = d.GetState().ok()? == DEVICE_STATE_ACTIVE;
                let name = device_name(&d);
                Some((d, name, active))
            })
            .collect()
    }
}

/// Windows names a sound device "Kind (Device name)"; calls use a second one ending in "Hands-Free".
fn is_of(output: &str, device: &str) -> bool {
    !device.is_empty() && (output.ends_with(&format!("({device})")) || output.contains(&format!("({device} ")))
}

fn enumerator() -> Option<IMMDeviceEnumerator> {
    // SAFETY: COM is initialised by the caller's `Com`.
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok() }
}

fn ready(e: &IMMDeviceEnumerator, name: &str) -> bool {
    outputs(e).iter().any(|(_, n, active)| *active && is_of(n, name))
}

fn is_default(e: &IMMDeviceEnumerator, name: &str) -> bool {
    // SAFETY: plain COM calls on live interfaces.
    unsafe { e.GetDefaultAudioEndpoint(eRender, eMultimedia).map(|d| is_of(&device_name(&d), name)).unwrap_or(false) }
}

/// Asks the driver to reconnect the headphones' sound. Nothing is learnt from the answer.
fn ask(e: &IMMDeviceEnumerator, name: &str) {
    for (d, n, _) in outputs(e) {
        if !is_of(&n, name) {
            continue;
        }
        // SAFETY: the property request lives through the call; the driver writes no data back.
        let _ = unsafe {
            (|| -> windows::core::Result<()> {
                let topology: IDeviceTopology = d.Activate(CLSCTX_ALL, None)?;
                let part: IPart = topology.GetConnector(0)?.GetConnectedTo()?.cast()?;
                let id = part.GetTopologyObject()?.GetDeviceId()?;
                let filter = e.GetDevice(PCWSTR(id.0));
                windows::Win32::System::Com::CoTaskMemFree(Some(id.0 as *const _));
                let ks: IKsControl = filter?.Activate(CLSCTX_ALL, None)?;
                let mut p = KSIDENTIFIER::default();
                p.Anonymous.Anonymous = KSIDENTIFIER_0_0 { Set: KSPROPSETID_BT_AUDIO, Id: ONESHOT_RECONNECT, Flags: KSPROPERTY_TYPE_GET };
                let mut got = 0u32;
                ks.KsProperty(&p, size_of::<KSIDENTIFIER>() as u32, std::ptr::null_mut(), 0, &mut got)
            })()
        };
    }
}

fn list() -> Vec<Headphones> {
    let _com = Com::new();
    let e = enumerator();
    paired()
        .into_iter()
        .map(|(address, name, linked)| {
            let ready = linked && e.as_ref().is_some_and(|e| ready(e, &name));
            Headphones { id: format!("{address:012x}"), name, linked, ready }
        })
        .collect()
}

// ───────────────────────── switching ─────────────────────────

/// "ready", "elsewhere" (connected, but Windows plays through something else), "silent" (linked,
/// no sound) or "unreachable".
fn take(address: u64, name: &str) -> &'static str {
    let _com = Com::new();
    let Some(e) = enumerator() else { return "unreachable" };
    let linked = || paired().iter().any(|(a, _, l)| *a == address && *l);
    let start = Instant::now();
    let mut asked = None::<Instant>;
    let mut since_link = None::<Instant>;
    let mut again = false;
    while start.elapsed() < GIVE_UP {
        let up = linked();
        if up && ready(&e, name) {
            // Windows moves the sound over by itself, a moment later.
            for _ in 0..8 {
                if is_default(&e, name) {
                    return "ready";
                }
                std::thread::sleep(Duration::from_millis(500));
            }
            return "elsewhere";
        }
        if up {
            let t = *since_link.get_or_insert_with(Instant::now);
            if !again && t.elapsed() > START_OVER {
                again = true;
                since_link = None;
                asked = None;
                drop_link(address);
                std::thread::sleep(Duration::from_secs(2));
                continue;
            }
        }
        // Linked or not: a link made by the headphones themselves does not bring the sound along.
        if asked.is_none_or(|t| t.elapsed() > Duration::from_secs(9)) {
            ask(&e, name);
            asked = Some(Instant::now());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    if linked() { "silent" } else { "unreachable" }
}

fn release(address: u64) -> &'static str {
    drop_link(address);
    for _ in 0..16 {
        std::thread::sleep(Duration::from_millis(500));
        if !paired().iter().any(|(a, _, l)| *a == address && *l) {
            return "released";
        }
    }
    "stuck"
}

fn publish(app: &AppHandle, value: Option<serde_json::Value>) {
    *app.state::<HeadphonesState>().now.lock().unwrap() = value.clone();
    let _ = app.emit("headphones:state", value);
}

/// Which headphones a key press means: those on this computer, else the last switched, else the only ones.
fn pick<'a>(all: &'a [Headphones], last: Option<&str>) -> Option<&'a Headphones> {
    let mut linked = all.iter().filter(|h| h.linked);
    all.iter()
        .find(|h| h.linked && Some(h.id.as_str()) == last)
        .or_else(|| linked.next())
        .or_else(|| all.iter().find(|h| Some(h.id.as_str()) == last))
        .or(if all.len() == 1 { all.first() } else { None })
}

/// Takes or lets go of the headphones (`id`, or the ones a key press means). Blocks until it is over.
pub fn switch(app: &AppHandle, id: Option<&str>) {
    if app.state::<HeadphonesState>().busy.swap(true, Ordering::SeqCst) {
        return;
    }
    let uk = app.state::<crate::watcher::WatcherState>().settings.lock().unwrap().lang != "en";
    let journal = app.state::<Journal>();
    let last = crate::watcher::kv_get(&journal, "headphones");
    let all = list();
    let target = match id {
        Some(id) => all.iter().find(|h| h.id == id),
        None => pick(&all, last.as_deref()),
    }
    .cloned();
    match target {
        Some(h) => {
            crate::watcher::kv_set(&journal, "headphones", &h.id);
            let address = u64::from_str_radix(&h.id, 16).unwrap_or(0);
            // On this computer but silent: the user wants the sound, not to be rid of them.
            let letting_go = h.linked && h.ready;
            publish(app, Some(json!({ "id": h.id, "name": h.name, "phase": if letting_go { "releasing" } else { "connecting" } })));
            let outcome = if letting_go { release(address) } else { take(address, &h.name) };
            publish(app, None);
            let (level, text) = words(outcome, uk);
            tell(app, level, &h.name, text);
        }
        None => {
            let (title, text) = match (all.is_empty(), uk) {
                (true, true) => ("Навушників немає", "До цього комп'ютера не спарено Bluetooth-навушників, або Bluetooth вимкнено."),
                (true, false) => ("No headphones", "No Bluetooth headphones are paired with this computer, or Bluetooth is off."),
                (false, true) => ("Які саме навушники?", "Спарено кілька. Розгорни острів (Ctrl+Shift+F11) і вибери — далі клавіша пам'ятатиме."),
                (false, false) => ("Which headphones?", "Several are paired. Open the island (Ctrl+Shift+F11) and choose — the key remembers it from then on."),
            };
            tell(app, "info", title, text);
        }
    }
    app.state::<HeadphonesState>().busy.store(false, Ordering::SeqCst);
}

fn words(outcome: &str, uk: bool) -> (&'static str, &'static str) {
    match (outcome, uk) {
        ("ready", true) => ("info", "На комп'ютері, звук готовий."),
        ("ready", false) => ("info", "On this computer, sound is ready."),
        ("elsewhere", true) => ("warn", "Підключено, але Windows грає через інший пристрій. Вибери навушники у виводі звуку Windows."),
        ("elsewhere", false) => ("warn", "Connected, but Windows plays through another device. Choose the headphones in Windows sound output."),
        ("silent", true) => ("warn", "З'єднано, але звук так і не з'явився. Поклади навушники в кейс, дістань і спробуй ще раз."),
        ("silent", false) => ("warn", "Linked, but the sound never came up. Put them in the case, take them out and try again."),
        ("released", true) => ("info", "Відпущено. Вибери їх на телефоні, якщо він не підхопив їх сам."),
        ("released", false) => ("info", "Let go. Choose them on the phone if it did not pick them up itself."),
        ("stuck", true) => ("warn", "Не вдалося відпустити: з'єднання не розірвалося."),
        ("stuck", false) => ("warn", "Could not let go: the link stayed up."),
        (_, true) => ("warn", "Не відповідають. Перевір, що навушники поруч і дістані з кейса."),
        (_, false) => ("warn", "No answer. Check that they are near and out of the case."),
    }
}

/// In the island when it is on screen, else as a Windows notification.
fn tell(app: &AppHandle, level: &str, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    if !crate::overlay::alert(app, "headphones", level, title, body) {
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

// ───────────────────────── commands ─────────────────────────

#[tauri::command]
pub async fn headphones_list() -> Vec<Headphones> {
    tauri::async_runtime::spawn_blocking(list).await.unwrap_or_default()
}

#[tauri::command]
pub fn headphones_now(state: State<'_, HeadphonesState>) -> Option<serde_json::Value> {
    state.now.lock().unwrap().clone()
}

#[tauri::command]
pub async fn headphones_switch(app: AppHandle, id: String) {
    let _ = tauri::async_runtime::spawn_blocking(move || switch(&app, Some(&id))).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(id: &str, linked: bool) -> Headphones {
        Headphones { id: id.into(), name: id.into(), linked, ready: linked }
    }

    #[test]
    fn sound_devices_are_matched_by_name() {
        assert!(is_of("Headphones (Buds4 Pro)", "Buds4 Pro"));
        assert!(is_of("Headset (Buds4 Pro Hands-Free)", "Buds4 Pro"));
        assert!(!is_of("Headphones (Buds3 Pro)", "Buds4 Pro"));
        assert!(!is_of("Speakers (Realtek(R) Audio)", ""));
    }

    #[test]
    fn only_audio_devices_count() {
        assert!(is_audio(0x240418)); // headphones
        assert!(!is_audio(0x5a020c)); // a phone
    }

    #[test]
    fn sinks_are_told_from_sources() {
        assert!(is_sink(&GUID::from_u128(0x0000110B_0000_1000_8000_00805F9B34FB)));
        assert!(!is_sink(&GUID::from_u128(0x0000110A_0000_1000_8000_00805F9B34FB)));
    }

    #[test]
    fn the_key_means_the_obvious_pair() {
        assert_eq!(pick(&[h("a", false), h("b", true)], Some("a")).unwrap().id, "b");
        assert_eq!(pick(&[h("a", true), h("b", true)], Some("b")).unwrap().id, "b");
        assert_eq!(pick(&[h("a", false), h("b", false)], Some("a")).unwrap().id, "a");
        assert_eq!(pick(&[h("a", false)], None).unwrap().id, "a");
        assert!(pick(&[h("a", false), h("b", false)], None).is_none());
    }
}
