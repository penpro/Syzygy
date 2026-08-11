//! Test-only worker that never reads stdin, proving the parent deadline covers blocked pipes.

fn main() {
    std::thread::sleep(std::time::Duration::from_secs(60));
}
