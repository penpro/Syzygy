//! Test-only executable for proving that hostile plugin failures remain in a subprocess.

fn main() {
    if let Err(error) = app_lib::plugin_runtime::run_worker() {
        eprintln!("Syzygy plugin runtime harness stopped: {error}");
        std::process::exit(1);
    }
}
