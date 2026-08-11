// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let arguments = std::env::args().collect::<Vec<_>>();
    if arguments.iter().any(|argument| argument == "--mcp") {
        if let Err(error) = app_lib::mcp::run() {
            eprintln!("Syzygy MCP stopped: {error}");
            std::process::exit(1);
        }
    } else if arguments.iter().any(|argument| argument == "--lan-agent") {
        if let Err(error) = app_lib::lan_agent::run_from_args(arguments.into_iter().skip(1)) {
            eprintln!("Syzygy LAN agent stopped: {error}");
            std::process::exit(1);
        }
    } else if arguments
        .iter()
        .any(|argument| argument == "--collaboration-relay")
    {
        if let Err(error) =
            app_lib::collaboration_relay_server::run_from_args(arguments.into_iter().skip(1))
        {
            eprintln!("Syzygy collaboration relay stopped: {error}");
            std::process::exit(1);
        }
    } else if arguments
        .iter()
        .any(|argument| argument == "--plugin-runtime-worker")
    {
        if let Err(error) = app_lib::plugin_runtime::run_worker() {
            eprintln!("Syzygy plugin runtime worker stopped: {error}");
            std::process::exit(1);
        }
    } else {
        app_lib::run();
    }
}
