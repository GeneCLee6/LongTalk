// Automatic updates (f-remote-control-security.md §5.9), only in builds with the `updater` feature
// (the owner's key must be in tauri.conf.json first: agent/README.md). The Tauri updater installs
// only an update signed with the private key that matches the public key built in, from the
// GitHub Releases `latest.json`, and never an older version. Checked once a little after start;
// installed only while the agent is in no room (never in the middle of a meeting), then restarted.

use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::AgentState;

const FIRST_CHECK_AFTER: Duration = Duration::from_secs(15);

pub fn start(app: &AppHandle) -> tauri::Result<()> {
    app.plugin(tauri_plugin_updater::Builder::new().build())?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_AFTER).await;
        if let Err(error) = check(&app).await {
            eprintln!("update check failed: {error}");
        }
    });
    Ok(())
}

async fn check(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let idle = || {
        app.state::<AgentState>().session.lock().unwrap().phase() == &crate::session::Phase::Idle
    };
    if !idle() {
        // Next launch
        return Ok(());
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    if idle() {
        update.install(bytes)?;
        // The agent log keeps every update installed (§5.10)
        app.state::<AgentState>()
            .log
            .lock()
            .unwrap()
            .write(&crate::agent_log::Entry::Updated {
                version: &update.version,
            });
        app.restart();
    }
    Ok(())
}
