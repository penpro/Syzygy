fn main() {
    if let Err(error) = app_lib::collaboration_relay_server::run_from_args(std::env::args().skip(1))
    {
        eprintln!("Syzygy collaboration relay stopped: {error}");
        std::process::exit(1);
    }
}
