// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `openwren --version` answers without opening a window, so a package can be checked on a server.
    if std::env::args().any(|arg| arg == "--version" || arg == "-V") {
        println!("openwren {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    openwren_lib::mark_start();
    openwren_lib::run()
}
