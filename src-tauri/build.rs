fn main() {
    // tauri-build declares tauri.conf.json and capabilities/ as inputs, but not
    // the icons. With the Rust build cache warm, an icon-only change therefore
    // skips build.rs entirely and the executable keeps the previous icon
    // embedded — which is exactly how a stale app icon survived a release.
    println!("cargo:rerun-if-changed=icons");

    tauri_build::build()
}
