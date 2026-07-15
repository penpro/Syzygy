fn main() {
    // Rebuild (and re-embed frontend assets) whenever the Vite output changes. Without this,
    // a frontend-only change can ship a stale UI: cargo sees no Rust edits, skips recompiling
    // the app crate, and the exe keeps the previously embedded dist. Vite's hashed filenames
    // mean any rebuild adds/removes files, which reliably bumps the dir fingerprint.
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
