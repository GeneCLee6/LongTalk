// Injecting the controller's input (N4, e9-t06; f-remote-control-security.md §5.6, §5.8, §5.12).
// control.rs decides WHETHER a batch is taken (the grant, the seq, what is held); this module decides
// WHAT the OS is asked to do with it, in two parts:
// - `plan` (pure, tested here on every platform): each event against what is held before it
//   (classify_key_combo: block, warn or allow, judged on the held modifier keys OR the event's own
//   `mods`; a modifier in `mods` that is not held is pressed just before the key and let go right
//   after it, so what was judged is what the OS sees), normalized coordinates to the shared screen,
//   browser wheel pixels to the OS's units;
// - an `Injector` per OS that performs the plan (windows.rs: SendInput; macos.rs: CGEvent; linux.rs:
//   XTest on X11, N5; Wayland: nothing, it has no injection a program may use without its own
//   portal). Windows and macOS refuse a press (a key, a button or the wheel going down) aimed at one
//   of the agent's own windows (§5.8, TH-30): the controller cannot press 允許, drag the 中斷 button
//   away or change a setting. Releases always go through, so nothing stays held. On Linux the agent's
//   windows only ever make control smaller (中斷, 不允許貼上, 暫停接受請求, 離開), and nothing is
//   injected while the consent dialog or the hourly question is up (control.rs pauses).
// - which screen the pointer aims at (N5, e9-t09): `candidates` are the screens that fit the
//   captured share; when several do (two identical monitors), the person picks one in the main
//   window (lib.rs choose_screen, not while controlled) and `pick_screen` takes it only if it is
//   still one of them: the pointer never aims at a screen nobody is shown.
// Nothing here is logged or kept but the NAME of a blocked or warned combination (§5.10, D11).

pub mod keymap;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
pub(crate) mod macos;
#[cfg(target_os = "windows")]
mod windows;

use crate::control::{next_held, ControlEvent, Held, MouseButton};

/** The OS the agent runs on, as shared/control.ts AgentPlatform */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Macos,
    Linux,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else {
            Platform::Linux
        }
    }
}

// shared/control.ts MOD_SHIFT, MOD_CTRL, MOD_ALT, MOD_META
pub const MOD_SHIFT: u8 = 1;
pub const MOD_CTRL: u8 = 2;
pub const MOD_ALT: u8 = 4;
pub const MOD_META: u8 = 8;

fn modifier_bit(code: &str) -> u8 {
    match code {
        "ShiftLeft" | "ShiftRight" => MOD_SHIFT,
        "ControlLeft" | "ControlRight" => MOD_CTRL,
        "AltLeft" | "AltRight" => MOD_ALT,
        "MetaLeft" | "MetaRight" => MOD_META,
        _ => 0,
    }
}

pub fn is_modifier(code: &str) -> bool {
    modifier_bit(code) != 0
}

/** shared/control.ts modsOfHeld */
pub fn mods_of_held(held: &Held) -> u8 {
    held.iter()
        .fold(0, |mods, entry| mods | modifier_bit(entry))
}

/** shared/control.ts KeyVerdict */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Allow,
    Warn,
    Block,
}

/**
 * shared/control.ts classifyKeyCombo, the same rules (tests/shared/control.test.ts and the tests
 * below are the spec): `held` is what is pressed before this key, `mods` the event's own.
 */
pub fn classify_key_combo(code: &str, held: &Held, mods: u8, platform: Platform) -> Verdict {
    let all = mods | mods_of_held(held);
    let ctrl = all & MOD_CTRL != 0;
    let alt = all & MOD_ALT != 0;
    let shift = all & MOD_SHIFT != 0;
    let meta = all & MOD_META != 0;
    let windows_or_linux = matches!(platform, Platform::Windows | Platform::Linux);
    if windows_or_linux && ctrl && alt && code == "Delete" {
        return Verdict::Block;
    }
    if platform == Platform::Linux {
        if ctrl && alt && code == "Backspace" {
            return Verdict::Block;
        }
        let function_key = code
            .strip_prefix('F')
            .and_then(|n| {
                (!n.starts_with('0'))
                    .then(|| n.parse::<u8>().ok())
                    .flatten()
            })
            .is_some_and(|n| (1..=12).contains(&n));
        if ctrl && alt && function_key {
            return Verdict::Block;
        }
        if alt && code == "PrintScreen" {
            return Verdict::Block;
        }
    }
    if platform == Platform::Windows {
        if meta && matches!(code, "KeyR" | "KeyX" | "KeyL") {
            return Verdict::Warn;
        }
        if ctrl && shift && code == "Escape" {
            return Verdict::Warn;
        }
    }
    if platform == Platform::Macos {
        if meta && alt && code == "Escape" {
            return Verdict::Warn;
        }
        if ctrl && meta && code == "KeyQ" {
            return Verdict::Warn;
        }
        if meta && shift && code == "KeyQ" {
            return Verdict::Warn;
        }
    }
    Verdict::Allow
}

/**
 * What the person at the computer reads, and the log keeps, for a combination: 「Win+R」,
 * 「Ctrl+Alt+Del」, 「⌘⌥Esc」. Only names of keys, never anything typed.
 */
pub fn combo_name(code: &str, held: &Held, mods: u8, platform: Platform) -> String {
    let all = mods | mods_of_held(held);
    let key = match code {
        "Escape" => "Esc".to_owned(),
        "Delete" => "Del".to_owned(),
        "Backspace" => "Backspace".to_owned(),
        "PrintScreen" => "PrtSc".to_owned(),
        other => other
            .strip_prefix("Key")
            .or_else(|| other.strip_prefix("Digit"))
            .unwrap_or(other)
            .to_owned(),
    };
    if platform == Platform::Macos {
        let mut name = String::new();
        for (bit, symbol) in [
            (MOD_CTRL, "⌃"),
            (MOD_ALT, "⌥"),
            (MOD_SHIFT, "⇧"),
            (MOD_META, "⌘"),
        ] {
            if all & bit != 0 {
                name.push_str(symbol);
            }
        }
        name.push_str(&key);
        return name;
    }
    let meta = if platform == Platform::Windows {
        "Win"
    } else {
        "Super"
    };
    let mut parts: Vec<&str> = Vec::new();
    for (bit, label) in [
        (MOD_META, meta),
        (MOD_CTRL, "Ctrl"),
        (MOD_ALT, "Alt"),
        (MOD_SHIFT, "Shift"),
    ] {
        if all & bit != 0 {
            parts.push(label);
        }
    }
    parts.push(&key);
    parts.join("+")
}

/** A screen in the injector's own coordinates (Windows: physical pixels; macOS: points) */
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Screen {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /** Its size in pixels (what a capture of it measures) */
    pub pixel_width: u32,
    pub pixel_height: u32,
    pub primary: bool,
}

/**
 * Which screen the share shows, from the captured track's size (the page reads it from
 * getSettings): the one with exactly that many pixels, else the one with the same shape (the
 * capture may be scaled down), preferring the primary screen when several fit. None when the share
 * is not a whole screen or nothing fits: the mouse is then not moved at all (a click at a guessed
 * place is worse than none), keys still go.
 */
#[cfg(test)]
pub fn pick_screen(screens: &[Screen], captured: Option<(u32, u32)>) -> Option<Screen> {
    pick_screen_chosen(screens, captured, None)
}

/**
 * The screens the share may show (N5): those with exactly the captured size, else those with its
 * shape; the primary screen first. Empty when the share is not a whole screen or nothing fits.
 */
pub fn candidates(screens: &[Screen], captured: Option<(u32, u32)>) -> Vec<Screen> {
    let Some((width, height)) = captured else {
        return Vec::new();
    };
    if width == 0 || height == 0 {
        return Vec::new();
    }
    let primary_first = |mut fitting: Vec<Screen>| {
        fitting.sort_by_key(|s| !s.primary);
        fitting
    };
    let exact: Vec<Screen> = screens
        .iter()
        .filter(|s| s.pixel_width == width && s.pixel_height == height)
        .copied()
        .collect();
    if !exact.is_empty() {
        return primary_first(exact);
    }
    let shape = width as f64 / height as f64;
    primary_first(
        screens
            .iter()
            .filter(|s| {
                s.pixel_height > 0
                    && ((s.pixel_width as f64 / s.pixel_height as f64) - shape).abs() / shape < 0.01
            })
            .copied()
            .collect(),
    )
}

/**
 * `pick_screen` with the person's choice (N5, lib.rs choose_screen): `chosen` wins only while it is
 * one of the candidates; otherwise the first candidate (the primary screen when it fits)
 */
pub fn pick_screen_chosen(
    screens: &[Screen],
    captured: Option<(u32, u32)>,
    chosen: Option<Screen>,
) -> Option<Screen> {
    let fitting = candidates(screens, captured);
    chosen
        .filter(|choice| fitting.contains(choice))
        .or_else(|| fitting.first().copied())
}

/** One thing the OS is asked to do */
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    /** The pointer to this point of the screen (the injector's coordinates) */
    MoveTo {
        x: i32,
        y: i32,
    },
    Button {
        button: MouseButton,
        down: bool,
    },
    /**
     * The wheel, in the browser's direction and pixels (positive: down, right); each injector turns
     * them into its own units
     */
    Wheel {
        dx: i32,
        dy: i32,
    },
    Key {
        code: String,
        down: bool,
    },
    Text(String),
}

/** A batch as the OS will see it, and what the person at the computer is told */
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan {
    pub actions: Vec<Action>,
    /** Combinations not pressed (Verdict::Block), by name */
    pub blocked: Vec<String>,
    /** Combinations pressed and shown (Verdict::Warn), by name */
    pub warned: Vec<String>,
    /** Pointer events dropped because no screen is known (the share is not a whole screen) */
    pub no_screen: bool,
}

/** A normalized coordinate (0–1, control.rs checked it) to a pixel of the screen */
fn to_screen(screen: &Screen, x: f64, y: f64) -> (i32, i32) {
    let span = |size: u32| (size.max(1) - 1) as f64;
    (
        screen.x + (x * span(screen.width)).round() as i32,
        screen.y + (y * span(screen.height)).round() as i32,
    )
}

/**
 * The OS's actions for `release` (control.rs: what was held when a batch is a gap) and then
 * `events`, judged against `held_before` (what was held before the batch, updated event by event
 * as the OS will see it).
 */
pub fn plan(
    release: &[ControlEvent],
    events: &[ControlEvent],
    held_before: &Held,
    screen: Option<&Screen>,
    platform: Platform,
) -> Plan {
    let mut plan = Plan::default();
    let mut held = held_before.clone();
    for event in release.iter().chain(events) {
        match event {
            ControlEvent::Move { x, y } => match screen {
                Some(screen) => {
                    let (x, y) = to_screen(screen, *x, *y);
                    plan.actions.push(Action::MoveTo { x, y });
                }
                None => plan.no_screen = true,
            },
            ControlEvent::Button { button, down } => {
                // A release always goes, even without a screen: nothing stays held
                if screen.is_some() || !down {
                    plan.actions.push(Action::Button {
                        button: *button,
                        down: *down,
                    });
                } else {
                    plan.no_screen = true;
                }
            }
            ControlEvent::Wheel { dx, dy } => match screen {
                Some(_) => plan.actions.push(Action::Wheel {
                    dx: *dx as i32,
                    dy: *dy as i32,
                }),
                None => plan.no_screen = true,
            },
            ControlEvent::Key { code, down, mods } => {
                if !*down || is_modifier(code) {
                    plan.actions.push(Action::Key {
                        code: code.clone(),
                        down: *down,
                    });
                } else {
                    match classify_key_combo(code, &held, *mods, platform) {
                        Verdict::Block => {
                            plan.blocked.push(combo_name(code, &held, *mods, platform));
                        }
                        verdict => {
                            if verdict == Verdict::Warn {
                                plan.warned.push(combo_name(code, &held, *mods, platform));
                            }
                            // `mods` the agent does not hold yet: pressed around this key only
                            let missing = missing_modifiers(&held, *mods);
                            for modifier in &missing {
                                plan.actions.push(Action::Key {
                                    code: (*modifier).to_owned(),
                                    down: true,
                                });
                            }
                            plan.actions.push(Action::Key {
                                code: code.clone(),
                                down: true,
                            });
                            for modifier in missing.iter().rev() {
                                plan.actions.push(Action::Key {
                                    code: (*modifier).to_owned(),
                                    down: false,
                                });
                            }
                        }
                    }
                }
            }
            ControlEvent::Text { text } => plan.actions.push(Action::Text(text.clone())),
        }
        next_held(&mut held, event);
    }
    plan
}

/** The left-hand modifier keys for the bits of `mods` that no held key gives */
fn missing_modifiers(held: &Held, mods: u8) -> Vec<&'static str> {
    let have = mods_of_held(held);
    [
        (MOD_CTRL, "ControlLeft"),
        (MOD_ALT, "AltLeft"),
        (MOD_SHIFT, "ShiftLeft"),
        (MOD_META, "MetaLeft"),
    ]
    .into_iter()
    .filter(|(bit, _)| mods & bit != 0 && have & bit == 0)
    .map(|(_, code)| code)
    .collect()
}

/** Whether an action presses something (a release never is refused) */
pub fn is_press(action: &Action) -> bool {
    match action {
        Action::Button { down, .. } | Action::Key { down, .. } => *down,
        Action::Wheel { .. } | Action::Text(_) => true,
        Action::MoveTo { .. } => false,
    }
}

/** Why an injector did not perform part of a plan (for the log; never what it was) */
// AgentWindow is Windows and macOS only, SecureDesktop Windows only
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skipped {
    /** A press aimed at one of the agent's own windows (§5.8) */
    AgentWindow,
    /** The secure desktop (UAC, the lock screen): Windows takes no injected input there (§5.12) */
    SecureDesktop,
    /** A key this keyboard does not have (macOS: PrintScreen…) */
    UnknownKey,
    /** The OS refused it (UIPI: a window of an administrator, T-16) or injection is not built */
    Refused,
}

/** Performs a plan on this OS. Returns what it skipped, at most once per kind */
pub trait Injector: Send {
    fn perform(&mut self, actions: &[Action]) -> Vec<Skipped>;
    /** The screens, in this injector's coordinates */
    fn screens(&self) -> Vec<Screen>;
}

/** Whether this computer's session is locked or its screen saver runs (ends control, `locked`) */
pub fn session_locked() -> bool {
    #[cfg(target_os = "windows")]
    return windows::session_locked();
    #[cfg(target_os = "macos")]
    return macos::session_locked();
    #[cfg(target_os = "linux")]
    return linux::session_locked();
    #[allow(unreachable_code)]
    false
}

/**
 * Whether the secure desktop is up (Windows: a UAC prompt), where no injected input arrives and only
 * the person here can answer (N5, §5.12): the grant goes on, the controller is told. Never on
 * macOS and Linux (their password prompts are ordinary windows, or refuse injection on their own).
 */
pub fn secure_desktop() -> bool {
    #[cfg(target_os = "windows")]
    return windows::secure_desktop();
    #[allow(unreachable_code)]
    false
}

/** The injector for this OS */
pub fn injector() -> Box<dyn Injector> {
    #[cfg(target_os = "windows")]
    return Box::new(windows::WindowsInjector::new());
    #[cfg(target_os = "macos")]
    return Box::new(macos::MacInjector::new());
    #[cfg(target_os = "linux")]
    if let Some(injector) = linux::X11Injector::connect() {
        return Box::new(injector);
    }
    #[allow(unreachable_code)]
    Box::new(Unsupported)
}

/**
 * No injection here: Linux without an X11 display (a Wayland session, f-doc §5.12: best effort, not
 * built) or any other system. Every press is reported refused, so the log says why nothing happened.
 */
#[allow(dead_code)]
struct Unsupported;

impl Injector for Unsupported {
    fn perform(&mut self, actions: &[Action]) -> Vec<Skipped> {
        if actions.iter().any(is_press) {
            vec![Skipped::Refused]
        } else {
            Vec::new()
        }
    }
    fn screens(&self) -> Vec<Screen> {
        Vec::new()
    }
}

/** For the injectors: adds `kind` once */
#[allow(dead_code)]
pub(crate) fn skip(skipped: &mut Vec<Skipped>, kind: Skipped) {
    if !skipped.contains(&kind) {
        skipped.push(kind);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(codes: &[&str]) -> Held {
        codes.iter().map(|c| c.to_string()).collect()
    }

    fn key(code: &str, down: bool, mods: u8) -> ControlEvent {
        ControlEvent::Key {
            code: code.into(),
            down,
            mods,
        }
    }

    fn press(code: &str, down: bool) -> Action {
        Action::Key {
            code: code.into(),
            down,
        }
    }

    const SCREEN: Screen = Screen {
        x: -1920,
        y: 0,
        width: 1920,
        height: 1080,
        pixel_width: 1920,
        pixel_height: 1080,
        primary: false,
    };

    #[test]
    fn combos_follow_shared_control() {
        use Platform::*;
        let none = held(&[]);
        // Ctrl+Alt+Del: blocked on Windows and Linux, from `mods` or from held keys
        assert_eq!(
            classify_key_combo("Delete", &none, MOD_CTRL | MOD_ALT, Windows),
            Verdict::Block
        );
        assert_eq!(
            classify_key_combo("Delete", &held(&["ControlLeft", "AltLeft"]), 0, Windows),
            Verdict::Block
        );
        assert_eq!(
            classify_key_combo("Delete", &held(&["ControlRight"]), MOD_ALT, Linux),
            Verdict::Block
        );
        assert_eq!(
            classify_key_combo("Delete", &none, MOD_CTRL | MOD_ALT, Macos),
            Verdict::Allow
        );
        // Linux: kill X, text consoles, SysRq
        assert_eq!(
            classify_key_combo("Backspace", &none, MOD_CTRL | MOD_ALT, Linux),
            Verdict::Block
        );
        assert_eq!(
            classify_key_combo("F3", &none, MOD_CTRL | MOD_ALT, Linux),
            Verdict::Block
        );
        assert_eq!(
            classify_key_combo("F3", &none, MOD_CTRL | MOD_ALT, Windows),
            Verdict::Allow
        );
        assert_eq!(
            classify_key_combo("PrintScreen", &held(&["AltLeft"]), 0, Linux),
            Verdict::Block
        );
        assert_eq!(
            classify_key_combo("PrintScreen", &none, 0, Linux),
            Verdict::Allow
        );
        // Windows: Run, the power menu, lock, Task Manager are told
        for code in ["KeyR", "KeyX", "KeyL"] {
            assert_eq!(
                classify_key_combo(code, &held(&["MetaLeft"]), 0, Windows),
                Verdict::Warn
            );
            assert_eq!(classify_key_combo(code, &none, 0, Windows), Verdict::Allow);
        }
        assert_eq!(
            classify_key_combo("Escape", &none, MOD_CTRL | MOD_SHIFT, Windows),
            Verdict::Warn
        );
        // ⌘R is reload on a Mac, not Run
        assert_eq!(
            classify_key_combo("KeyR", &none, MOD_META, Macos),
            Verdict::Allow
        );
        assert_eq!(
            classify_key_combo("Escape", &none, MOD_META | MOD_ALT, Macos),
            Verdict::Warn
        );
        assert_eq!(
            classify_key_combo("KeyQ", &none, MOD_CTRL | MOD_META, Macos),
            Verdict::Warn
        );
        assert_eq!(
            classify_key_combo("KeyQ", &none, MOD_META | MOD_SHIFT, Macos),
            Verdict::Warn
        );
        assert_eq!(
            classify_key_combo("KeyQ", &none, MOD_META, Macos),
            Verdict::Allow
        );
    }

    #[test]
    fn combos_have_readable_names() {
        let none = held(&[]);
        assert_eq!(
            combo_name("KeyR", &held(&["MetaLeft"]), 0, Platform::Windows),
            "Win+R"
        );
        assert_eq!(
            combo_name("Escape", &none, MOD_CTRL | MOD_SHIFT, Platform::Windows),
            "Ctrl+Shift+Esc"
        );
        assert_eq!(
            combo_name("Delete", &none, MOD_CTRL | MOD_ALT, Platform::Windows),
            "Ctrl+Alt+Del"
        );
        assert_eq!(
            combo_name("Escape", &none, MOD_META | MOD_ALT, Platform::Macos),
            "⌥⌘Esc"
        );
        assert_eq!(
            combo_name("F2", &none, MOD_CTRL | MOD_ALT, Platform::Linux),
            "Ctrl+Alt+F2"
        );
    }

    #[test]
    fn a_blocked_combination_is_never_pressed_however_it_is_split() {
        // TH-29: the modifiers sent as keys of their own, then Delete with mods 0
        let events = [
            key("ControlLeft", true, 0),
            key("AltLeft", true, MOD_CTRL),
            key("Delete", true, 0),
            key("Delete", false, 0),
            key("AltLeft", false, 0),
            key("ControlLeft", false, 0),
        ];
        let plan = plan(&[], &events, &held(&[]), Some(&SCREEN), Platform::Windows);
        assert_eq!(plan.blocked, vec!["Ctrl+Alt+Del".to_owned()]);
        assert!(!plan.actions.contains(&press("Delete", true)));
        // The modifiers still go down and up, the Delete release too (harmless, never stuck)
        assert_eq!(plan.actions.first(), Some(&press("ControlLeft", true)));
        assert!(plan.actions.contains(&press("Delete", false)));
        // A combination held from an earlier batch counts too
        let later = plan_one(
            key("Delete", true, 0),
            &held(&["ControlLeft", "AltRight"]),
            Platform::Windows,
        );
        assert_eq!(later.blocked.len(), 1);
        assert!(later.actions.is_empty());
    }

    fn plan_one(event: ControlEvent, before: &Held, platform: Platform) -> Plan {
        plan(&[], &[event], before, Some(&SCREEN), platform)
    }

    #[test]
    fn claimed_modifiers_are_pressed_around_the_key_only() {
        // mods says Ctrl, nothing holds it: Ctrl down, C down, Ctrl up; C's own up later
        let p = plan_one(key("KeyC", true, MOD_CTRL), &held(&[]), Platform::Windows);
        assert_eq!(
            p.actions,
            vec![
                press("ControlLeft", true),
                press("KeyC", true),
                press("ControlLeft", false)
            ]
        );
        // Held already: nothing added
        let p = plan_one(
            key("KeyC", true, MOD_CTRL),
            &held(&["ControlRight"]),
            Platform::Windows,
        );
        assert_eq!(p.actions, vec![press("KeyC", true)]);
        // Warned: pressed, and named
        let p = plan_one(key("KeyR", true, MOD_META), &held(&[]), Platform::Windows);
        assert_eq!(p.warned, vec!["Win+R".to_owned()]);
        assert_eq!(
            p.actions,
            vec![
                press("MetaLeft", true),
                press("KeyR", true),
                press("MetaLeft", false)
            ]
        );
    }

    #[test]
    fn releases_come_first_and_always_go() {
        let release = [key("ShiftLeft", false, 0)];
        let events = [ControlEvent::Text {
            text: "你好".into(),
        }];
        let p = plan(
            &release,
            &events,
            &held(&["ShiftLeft"]),
            None,
            Platform::Windows,
        );
        assert_eq!(
            p.actions,
            vec![press("ShiftLeft", false), Action::Text("你好".into())]
        );
        assert!(!p.no_screen);
    }

    #[test]
    fn the_pointer_lands_on_the_shared_screen() {
        let events = [
            ControlEvent::Move { x: 0.0, y: 0.0 },
            ControlEvent::Move { x: 1.0, y: 1.0 },
            ControlEvent::Move { x: 0.5, y: 0.5 },
            ControlEvent::Button {
                button: MouseButton::Left,
                down: true,
            },
            ControlEvent::Wheel { dx: 0, dy: 120 },
        ];
        let p = plan(&[], &events, &held(&[]), Some(&SCREEN), Platform::Windows);
        assert_eq!(
            p.actions,
            vec![
                Action::MoveTo { x: -1920, y: 0 },
                Action::MoveTo { x: -1, y: 1079 },
                Action::MoveTo { x: -960, y: 540 },
                Action::Button {
                    button: MouseButton::Left,
                    down: true
                },
                Action::Wheel { dx: 0, dy: 120 },
            ]
        );
        // No screen: no pointer at all, but a button release still goes
        let p = plan(
            &[],
            &[
                events[0].clone(),
                events[3].clone(),
                ControlEvent::Button {
                    button: MouseButton::Left,
                    down: false,
                },
                key("KeyA", true, 0),
            ],
            &held(&[]),
            None,
            Platform::Windows,
        );
        assert!(p.no_screen);
        assert_eq!(
            p.actions,
            vec![
                Action::Button {
                    button: MouseButton::Left,
                    down: false
                },
                press("KeyA", true)
            ]
        );
    }

    #[test]
    fn the_shared_screen_is_the_one_its_size_says() {
        let primary = Screen {
            x: 0,
            y: 0,
            width: 2560,
            height: 1440,
            pixel_width: 2560,
            pixel_height: 1440,
            primary: true,
        };
        let side = Screen {
            x: 2560,
            y: 0,
            width: 1920,
            height: 1080,
            pixel_width: 1920,
            pixel_height: 1080,
            primary: false,
        };
        let portrait = Screen {
            x: -1080,
            y: 0,
            width: 1080,
            height: 1920,
            pixel_width: 1080,
            pixel_height: 1920,
            primary: false,
        };
        let screens = [side, primary, portrait];
        assert_eq!(pick_screen(&screens, Some((1920, 1080))), Some(side));
        assert_eq!(pick_screen(&screens, Some((1080, 1920))), Some(portrait));
        // Scaled down: same shape; both 16:9 fit, the primary wins
        assert_eq!(pick_screen(&screens, Some((1280, 720))), Some(primary));
        assert_eq!(pick_screen(&screens, Some((800, 600))), None);
        assert_eq!(pick_screen(&screens, None), None);
        assert_eq!(pick_screen(&screens, Some((0, 0))), None);
        // Two identical screens: the primary one
        let twin = Screen {
            primary: false,
            x: 2560,
            ..primary
        };
        assert_eq!(
            pick_screen(&[twin, primary], Some((2560, 1440))),
            Some(primary)
        );
    }

    #[test]
    fn presses_and_releases() {
        assert!(is_press(&press("KeyA", true)));
        assert!(!is_press(&press("KeyA", false)));
        assert!(!is_press(&Action::MoveTo { x: 0, y: 0 }));
        assert!(is_press(&Action::Text("a".into())));
        assert!(is_press(&Action::Wheel { dx: 0, dy: 1 }));
    }

    // ── N5: which screen, when several fit (e9-t09) ──────────────────────────────────────────

    fn screen(x: i32, primary: bool) -> Screen {
        Screen {
            x,
            y: 0,
            width: 1920,
            height: 1080,
            pixel_width: 1920,
            pixel_height: 1080,
            primary,
        }
    }

    #[test]
    fn two_identical_screens_are_both_candidates_primary_first() {
        let left = screen(-1920, false);
        let main = screen(0, true);
        let screens = [left, main];
        assert_eq!(candidates(&screens, Some((1920, 1080))), vec![main, left]);
        assert_eq!(pick_screen(&screens, Some((1920, 1080))), Some(main));
        // The person's choice wins while it fits the share
        assert_eq!(
            pick_screen_chosen(&screens, Some((1920, 1080)), Some(left)),
            Some(left)
        );
        // Never a screen that does not fit what is shown
        let other = Screen {
            pixel_width: 2560,
            pixel_height: 1440,
            width: 2560,
            height: 1440,
            ..screen(1920, false)
        };
        assert_eq!(
            pick_screen_chosen(&[left, main, other], Some((1920, 1080)), Some(other)),
            Some(main)
        );
        // Nothing shown, nothing aimed at, whatever was chosen
        assert_eq!(pick_screen_chosen(&screens, None, Some(left)), None);
        assert!(candidates(&screens, Some((0, 0))).is_empty());
    }
}
