// The agent log (N4, e9-t07; f-remote-control-security.md §5.10, T-13): who asked to control this
// computer, what the person answered, when control started and ended and why, which combinations
// were blocked or shown, and when an update was installed. It is for the owner of the computer
// (TH-24): plain text in the app's log folder (Windows: %LOCALAPPDATA%\app.longtalk.agent\logs),
// one line per entry, one file per day (UTC), files older than LOG_KEEP_DAYS deleted. The tray's
// 「開啟日誌」 opens the folder.
//
// What it NEVER holds: anything typed (`text` events), keys, coordinates, the content of a batch.
// `Entry` cannot carry them: there is no variant with an event in it, and a batch reaches the log
// only through `entries_for` (combination names), which the test below feeds typed text and keys.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/** Days of log files kept (§5.10) */
pub const LOG_KEEP_DAYS: i64 = 30;
const PREFIX: &str = "control-";
const SUFFIX: &str = ".log";

/** One line of the log */
#[derive(Debug, PartialEq, Eq)]
pub enum Entry<'a> {
    /** A request reached this computer (controlAsk) */
    Asked {
        room: &'a str,
        request: &'a str,
        from_name: &'a str,
        from_id: &'a str,
    },
    /** The person answered in the consent dialog */
    Answered {
        request: &'a str,
        decision: &'a str,
        mute_ms: Option<u64>,
    },
    /** Control started (a valid controlStart): who, for how long (None: until stopped) */
    Started {
        room: &'a str,
        grant: &'a str,
        controller: &'a str,
        minutes: Option<u64>,
    },
    /** A controlStart the agent refused (T-12): it never answered that, or not for that long */
    StartRefused,
    /** Control ended; `reason` is control.rs Ended::reason */
    Ended {
        grant: &'a str,
        reason: &'a str,
    },
    /** A combination not pressed, or pressed and shown, by its name ("Ctrl+Alt+Del", "Win+R") */
    Blocked {
        combo: &'a str,
    },
    Warned {
        combo: &'a str,
    },
    /** Something the agent did not do, once per grant per kind (inject/ Skipped, a dropped batch) */
    Skipped {
        what: &'a str,
    },
    /** An update was installed */
    Updated {
        version: &'a str,
    },
}

/** A value as one field of a line: no tabs, line breaks or control characters, at most 60 chars */
fn field(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(60)
        .collect()
}

impl Entry<'_> {
    fn fields(&self) -> (&'static str, Vec<(&'static str, String)>) {
        match self {
            Entry::Asked {
                room,
                request,
                from_name,
                from_id,
            } => (
                "asked",
                vec![
                    ("room", field(room)),
                    ("request", field(request)),
                    ("from", field(from_name)),
                    ("fromId", field(from_id)),
                ],
            ),
            Entry::Answered {
                request,
                decision,
                mute_ms,
            } => {
                let mut fields = vec![("request", field(request)), ("decision", field(decision))];
                if let Some(ms) = mute_ms {
                    fields.push(("muteMinutes", (ms / 60_000).to_string()));
                }
                ("answered", fields)
            }
            Entry::Started {
                room,
                grant,
                controller,
                minutes,
            } => (
                "started",
                vec![
                    ("room", field(room)),
                    ("grant", field(grant)),
                    ("by", field(controller)),
                    (
                        "minutes",
                        minutes.map_or_else(|| "untilStopped".to_owned(), |m| m.to_string()),
                    ),
                ],
            ),
            Entry::StartRefused => ("startRefused", Vec::new()),
            Entry::Ended { grant, reason } => (
                "ended",
                vec![("grant", field(grant)), ("reason", field(reason))],
            ),
            Entry::Blocked { combo } => ("blocked", vec![("combo", field(combo))]),
            Entry::Warned { combo } => ("warned", vec![("combo", field(combo))]),
            Entry::Skipped { what } => ("skipped", vec![("what", field(what))]),
            Entry::Updated { version } => ("updated", vec![("version", field(version))]),
        }
    }
}

/** Days since 1970-01-01 to (year, month, day), Howard Hinnant's civil_from_days */
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/** (year, month, day) to days since 1970-01-01 (days_from_civil) */
fn days_from(year: i64, month: u32, day: u32) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let yoe = year.rem_euclid(400);
    let month = month as i64;
    let doy = (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn date(days: i64) -> String {
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/** One line, `2026-11-13T05:12:33.123Z<TAB>started<TAB>room=…<TAB>…` */
pub fn line(unix_ms: u64, entry: &Entry) -> String {
    let days = (unix_ms / 86_400_000) as i64;
    let in_day = unix_ms % 86_400_000;
    let (h, m, s, ms) = (
        in_day / 3_600_000,
        in_day / 60_000 % 60,
        in_day / 1_000 % 60,
        in_day % 1_000,
    );
    let (kind, fields) = entry.fields();
    let mut text = format!("{}T{h:02}:{m:02}:{s:02}.{ms:03}Z\t{kind}", date(days));
    for (name, value) in fields {
        text.push('\t');
        text.push_str(name);
        text.push('=');
        text.push_str(&value);
    }
    text
}

/** The day a log file is for, from its name; None for any other file */
fn file_day(name: &str) -> Option<i64> {
    let date = name.strip_prefix(PREFIX)?.strip_suffix(SUFFIX)?;
    let mut parts = date.split('-');
    let year = parts.next()?.parse::<i64>().ok()?;
    let month = parts.next()?.parse::<u32>().ok()?;
    let day = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from(year, month, day))
}

pub struct AgentLog {
    dir: Option<PathBuf>,
    day: i64,
    file: Option<File>,
}

impl AgentLog {
    /** Writes into `dir` (None: nowhere, when the OS gave no log folder) */
    pub fn new(dir: Option<PathBuf>) -> Self {
        Self {
            dir,
            day: i64::MIN,
            file: None,
        }
    }

    pub fn dir(&self) -> Option<&Path> {
        self.dir.as_deref()
    }

    /** Appends one entry (a failure to write never stops anything: the log is not a gate) */
    pub fn write(&mut self, entry: &Entry) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.write_at(now, entry);
    }

    fn write_at(&mut self, unix_ms: u64, entry: &Entry) {
        let Some(dir) = self.dir.clone() else {
            return;
        };
        let day = (unix_ms / 86_400_000) as i64;
        if day != self.day || self.file.is_none() {
            self.day = day;
            let _ = fs::create_dir_all(&dir);
            prune(&dir, day);
            self.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join(format!("{PREFIX}{}{SUFFIX}", date(day))))
                .ok();
        }
        if let Some(file) = self.file.as_mut() {
            let _ = writeln!(file, "{}", line(unix_ms, entry));
        }
    }
}

/** Deletes this log's files more than LOG_KEEP_DAYS before `today` (nothing else in the folder) */
fn prune(dir: &Path, today: i64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if let Some(day) = name.to_str().and_then(file_day) {
            if today - day > LOG_KEEP_DAYS {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

/** What a planned batch adds to the log: the names of blocked and shown combinations, nothing else */
pub fn entries_for(plan: &crate::inject::Plan) -> Vec<Entry<'_>> {
    plan.blocked
        .iter()
        .map(|combo| Entry::Blocked { combo })
        .chain(plan.warned.iter().map(|combo| Entry::Warned { combo }))
        .collect()
}

/** Opens the log folder in the OS's file manager (a fixed local path: no URL, no shell) */
pub fn open_folder(dir: &Path) {
    let _ = fs::create_dir_all(dir);
    #[cfg(target_os = "windows")]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";
    let _ = std::process::Command::new(program).arg(dir).spawn();
}

#[cfg(test)]
mod tests {
    use super::*;

    // 2026-11-13T05:12:33.123Z
    const AT: u64 = 1_794_546_753_123;

    // T-13: a batch with typed text, keys and a pointer leaves only combination names
    #[test]
    fn nothing_typed_reaches_the_log() {
        use crate::control::{ControlEvent, Held};
        use crate::inject::{plan, Platform, MOD_ALT, MOD_CTRL, MOD_META};
        let events = [
            ControlEvent::Text {
                text: "hunter2密碼".into(),
            },
            ControlEvent::Key {
                code: "KeyP".into(),
                down: true,
                mods: 0,
            },
            ControlEvent::Move { x: 0.25, y: 0.75 },
            ControlEvent::Key {
                code: "Delete".into(),
                down: true,
                mods: MOD_CTRL | MOD_ALT,
            },
            ControlEvent::Key {
                code: "KeyR".into(),
                down: true,
                mods: MOD_META,
            },
        ];
        let planned = plan(&[], &events, &Held::new(), None, Platform::Windows);
        let lines: Vec<String> = entries_for(&planned)
            .iter()
            .map(|entry| line(AT, entry))
            .collect();
        assert_eq!(
            lines,
            vec![
                "2026-11-13T05:12:33.123Z	blocked	combo=Ctrl+Alt+Del".to_owned(),
                "2026-11-13T05:12:33.123Z	warned	combo=Win+R".to_owned(),
            ]
        );
        let all = lines.join(
            "
",
        );
        for secret in ["hunter2", "密碼", "KeyP", "0.25", "0.75"] {
            assert!(!all.contains(secret), "{secret}");
        }
    }

    #[test]
    fn dates_are_right() {
        assert_eq!(date(0), "1970-01-01");
        assert_eq!(date(days_from(2026, 11, 13)), "2026-11-13");
        assert_eq!(date(days_from(2024, 2, 29)), "2024-02-29");
        assert_eq!(date(days_from(2000, 3, 1) - 1), "2000-02-29");
        for days in [-1, 0, 59, 365, 10_957, 20_000, 20_405] {
            let (y, m, d) = civil(days);
            assert_eq!(days_from(y, m, d), days);
        }
    }

    #[test]
    fn a_line_is_one_line_of_fields() {
        assert_eq!(
            line(
                AT,
                &Entry::Started {
                    room: "abc-defg-hij",
                    grant: "GGGG",
                    controller: "Bob\tthe\nbuilder",
                    minutes: Some(10),
                }
            ),
            "2026-11-13T05:12:33.123Z\tstarted\troom=abc-defg-hij\tgrant=GGGG\tby=Bob the builder\tminutes=10"
        );
        assert_eq!(
            line(
                AT,
                &Entry::Ended {
                    grant: "GGGG",
                    reason: "escape"
                }
            ),
            "2026-11-13T05:12:33.123Z\tended\tgrant=GGGG\treason=escape"
        );
        let answered = line(
            AT,
            &Entry::Answered {
                request: "RRRR",
                decision: "deny",
                mute_ms: Some(1_800_000),
            },
        );
        assert!(answered.ends_with("decision=deny\tmuteMinutes=30"));
        // A name cannot make a second line or run on
        let long = "x".repeat(500);
        let asked = line(
            AT,
            &Entry::Asked {
                room: "r",
                request: "q",
                from_name: &format!("Eve\r\n2026-01-01T00:00:00.000Z\tstarted{long}"),
                from_id: "m",
            },
        );
        assert!(!asked.contains('\n') && !asked.contains('\r'));
        assert!(asked.len() < 300);
    }

    #[test]
    fn files_are_per_day_and_old_ones_go() {
        let dir = std::env::temp_dir().join(format!("longtalk-log-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let today = days_from(2026, 11, 13);
        let old = dir.join(format!(
            "{PREFIX}{}{SUFFIX}",
            date(today - LOG_KEEP_DAYS - 1)
        ));
        let kept = dir.join(format!("{PREFIX}{}{SUFFIX}", date(today - LOG_KEEP_DAYS)));
        let other = dir.join("notes.txt");
        for path in [&old, &kept, &other] {
            fs::write(path, "x").unwrap();
        }
        let mut log = AgentLog::new(Some(dir.clone()));
        log.write_at(
            AT,
            &Entry::Blocked {
                combo: "Ctrl+Alt+Del",
            },
        );
        log.write_at(AT + 1, &Entry::StartRefused);
        assert!(!old.exists());
        assert!(kept.exists() && other.exists());
        let written = fs::read_to_string(dir.join("control-2026-11-13.log")).unwrap();
        assert_eq!(
            written,
            "2026-11-13T05:12:33.123Z\tblocked\tcombo=Ctrl+Alt+Del\n2026-11-13T05:12:33.124Z\tstartRefused\n"
        );
        // The next day: a new file
        log.write_at(AT + 86_400_000, &Entry::Updated { version: "0.2.0" });
        assert!(dir.join("control-2026-11-14.log").exists());
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(file_day("control-2026-13-01.log"), None);
        assert_eq!(file_day("other-2026-11-13.log"), None);
    }
}
