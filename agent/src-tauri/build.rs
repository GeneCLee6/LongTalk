// The app's own commands are listed here so that each one needs a permission (capabilities/
// main.json grants them to the main window only): nothing the bundled UI does not call is reachable
// over IPC (docs/PRD/f-remote-control-security.md §5.8).
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "agent_info",
            "session_state",
            "socket_connect",
            "socket_send",
            "confirm_join",
            "set_sharing",
            "leave_room",
            "api_fetch",
        ]),
    ))
    .expect("failed to run tauri-build");
}
