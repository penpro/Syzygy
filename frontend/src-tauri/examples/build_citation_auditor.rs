use std::{fs, path::PathBuf};

fn main() {
    let package_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("examples")
        .join("plugins")
        .join("citation-auditor");
    let source = package_root.join("citation-auditor.wat");
    let output = package_root.join("citation-auditor.component");
    let component =
        wat::parse_file(&source).expect("citation-auditor.wat must be valid component WAT");
    fs::write(&output, component).expect("generated component must be writable");
    println!("generated {}", output.display());
}
