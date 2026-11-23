//! Notification wording. Windows shows these outside the app, so they are put together here
//! in the user's language rather than in the interface's translation files.

use serde_json::Value;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or("")
}

pub fn render(lang: &str, kind: &str, v: &Value) -> (String, String) {
    let uk = lang != "en";
    match kind {
        "device" if !s(v, "loginFailed").is_empty() => {
            if uk {
                ("Наглядач не зміг увійти в роутер".into(), "Збережений пароль роутера не підійшов. Щоб не заблокувати роутер, DelphEye більше не пробує сам — увійди у «Wi-Fi → Професійний».".into())
            } else {
                ("The watcher could not log in to the router".into(), "The saved router password did not work. To avoid locking the router DelphEye stops trying — log in under Wi-Fi → Professional.".into())
            }
        }
        "device" => {
            let name = [s(v, "name"), s(v, "vendor")].into_iter().find(|x| !x.is_empty()).map(str::to_string).unwrap_or_else(|| if uk { "Невідомий пристрій".into() } else { "Unknown device".into() });
            let how = match (s(v, "link"), uk) {
                ("wired", true) => "кабелем".to_string(),
                ("wired", false) => "by cable".to_string(),
                (b, true) => format!("через Wi-Fi {b} ГГц"),
                (b, false) => format!("over Wi-Fi {b} GHz"),
            };
            if uk {
                (format!("Новий пристрій у мережі: {name}"), format!("{} підключився {how}. Якщо це не твій — зміни пароль Wi-Fi.", s(v, "mac")))
            } else {
                (format!("New device on the network: {name}"), format!("{} joined {how}. If it is not yours, change the Wi-Fi password.", s(v, "mac")))
            }
        }
        "twin" => {
            if uk {
                (format!("Хтось роздає мережу «{}»", s(v, "ssid")), format!("Точка {} має назву твоєї мережі, але це не твій роутер. Не підключайся до неї.", s(v, "bssid")))
            } else {
                (format!("Someone broadcasts \u{201c}{}\u{201d}", s(v, "ssid")), format!("Access point {} has your network's name but is not your router. Do not join it.", s(v, "bssid")))
            }
        }
        "heat" => {
            let t = v["temp"].as_i64().map(|t| format!(" ({t} °C)")).unwrap_or_default();
            if uk {
                (format!("Процесор перегрівається{t}"), "Він уже кілька хвилин гарячий і знижує частоту. Перевір, чи не закриті вентиляційні отвори.".into())
            } else {
                (format!("The CPU is overheating{t}"), "It has been hot for minutes and is slowing itself down. Check the vents are not blocked.".into())
            }
        }
        "disk" => {
            let gb = v["free_gb"].as_f64().unwrap_or(0.0);
            if uk {
                (format!("Диск {} майже заповнений", s(v, "drive")), format!("Вільно лише {} ГБ. Windows може гальмувати й не встановити оновлення — відкрий «Очищення».", gb.to_string().replace('.', ",")))
            } else {
                (format!("Drive {} is nearly full", s(v, "drive")), format!("Only {gb} GB free. Windows may slow down and fail to update — open Cleanup."))
            }
        }
        "autostart" => {
            if uk {
                (format!("Нова програма в автозапуску: {}", s(v, "name")), "Вона запускатиметься разом із Windows. Якщо ти її не встановлював — перевір у «Автозапуску».".into())
            } else {
                (format!("New startup program: {}", s(v, "name")), "It will start with Windows. If you did not install it, check it under Startup.".into())
            }
        }
        "crash" => {
            let what = match (s(v, "kind"), uk) {
                ("bluescreen", true) => "Синій екран",
                ("bluescreen", false) => "A blue screen",
                ("gpu", true) => "Збій відеодрайвера",
                ("gpu", false) => "A graphics driver reset",
                ("whea", true) => "Апаратна помилка",
                ("whea", false) => "A hardware error",
                (_, true) => "Раптове вимкнення",
                (_, false) => "An unexpected shutdown",
            };
            if uk {
                (format!("{what} — DelphEye записав це"), "Подробиці й можлива причина — у «Моніторингу», розділ стабільності.".into())
            } else {
                (format!("{what} — DelphEye recorded it"), "Details and the likely cause are under Monitoring, stability section.".into())
            }
        }
        "threat" => {
            if uk {
                (format!("Нове в схованках вірусів: {}", s(v, "name")), "Щось нове з'явилося там, де закріплюються шкідливі програми. Відкрий «Захист», щоб побачити подробиці.".into())
            } else {
                (format!("New in a malware hiding place: {}", s(v, "name")), "Something new settled where malware makes itself start. Open Protection for the details.".into())
            }
        }
        _ => (String::from("DelphEye"), String::new()),
    }
}

pub fn weekly(lang: &str, counts: &[(String, i64)]) -> (String, String) {
    let uk = lang != "en";
    if counts.is_empty() {
        return if uk {
            ("DelphEye: тиждень без пригод".into(), "Нових пристроїв, перегрівів і збоїв не було. Усе спокійно.".into())
        } else {
            ("DelphEye: a quiet week".into(), "No new devices, overheating or crashes. All calm.".into())
        };
    }
    let total: i64 = counts.iter().map(|c| c.1).sum();
    if uk {
        ("DelphEye: підсумок тижня".into(), format!("Подій за тиждень: {total}. Подробиці — у «Наглядачі»."))
    } else {
        ("DelphEye: the week in short".into(), format!("Events this week: {total}. Details under Watcher."))
    }
}

pub fn test(lang: &str) -> (String, String) {
    if lang != "en" {
        ("Наглядач DelphEye працює".into(), "Так виглядатимуть сповіщення про нові пристрої, перегрів чи повний диск.".into())
    } else {
        ("DelphEye watcher is on".into(), "Alerts about new devices, overheating or a full disk will look like this.".into())
    }
}
