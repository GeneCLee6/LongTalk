// Keeps a console window from opening next to the agent in release builds on Windows
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    longtalk_agent_lib::run()
}
