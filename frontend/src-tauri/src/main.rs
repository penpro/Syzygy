// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if std::env::args().any(|argument| argument == "--mcp") {
        if let Err(error) = app_lib::mcp::run() {
            eprintln!("Syzygy MCP stopped: {error}");
            std::process::exit(1);
        }
    } else {
        app_lib::run();
    }
}
