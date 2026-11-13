//! Starting OpenWren when the user logs in.
//!
//! Linux desktops start every entry in `~/.config/autostart`. OpenWren keeps one
//! file there while the "start_at_login" setting is on (the default) and removes
//! it when the setting is switched off. The entry starts OpenWren with `--hidden`,
//! so it goes straight to the tray and only announces new mail.

use std::path::{Path, PathBuf};

/// The argument that starts OpenWren in the tray, without showing its window.
pub const HIDDEN: &str = "--hidden";

const FILE: &str = "openwren.desktop";

/// `~/.config/autostart/openwren.desktop`, or None when the home folder is unknown.
fn entry_path() -> Option<PathBuf> {
    let config = match std::env::var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(std::env::var_os("HOME")?).join(".config"),
    };
    Some(config.join("autostart").join(FILE))
}

/// The program to start: the AppImage file when running from one, else this executable.
fn program() -> Option<PathBuf> {
    std::env::var_os("APPIMAGE").map(PathBuf::from).or_else(|| std::env::current_exe().ok())
}

/// A path as one quoted argument of a desktop entry's `Exec` line.
fn quoted(path: &Path) -> String {
    let mut out = String::from("\"");
    for c in path.to_string_lossy().chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                out.push('\\');
                out.push(c);
            }
            // A literal percent sign is written twice; "%f" and the like are field codes.
            '%' => out.push_str("%%"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn entry(program: &Path) -> String {
    format!(
        "[Desktop Entry]\nType=Application\nName=OpenWren\nComment=Check for new mail in the background\nExec={} {HIDDEN}\nIcon=openwren\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
        quoted(program)
    )
}

/// Make the autostart entry match the setting. Development builds never register themselves.
pub fn apply(enabled: bool) {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(path) = entry_path() else { return };
    if let Err(e) = write(&path, enabled) {
        eprintln!("Could not update {}: {e}", path.display());
    }
}

fn write(path: &Path, enabled: bool) -> std::io::Result<()> {
    if !enabled {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let Some(program) = program() else { return Ok(()) };
    let wanted = entry(&program);
    if std::fs::read_to_string(path).is_ok_and(|current| current == wanted) {
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, wanted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_line_quotes_the_program() {
        let text = entry(Path::new("/opt/Open Wren/open$wren 100%"));
        assert!(text.contains("Exec=\"/opt/Open Wren/open\\$wren 100%%\" --hidden\n"), "{text}");
    }

    #[test]
    fn writes_and_removes_the_entry() {
        let dir = std::env::temp_dir().join(format!("openwren-autostart-{}", std::process::id()));
        let path = dir.join("autostart").join(FILE);
        write(&path, true).unwrap();
        assert!(std::fs::read_to_string(&path).unwrap().contains(HIDDEN));
        write(&path, false).unwrap();
        assert!(!path.exists());
        write(&path, false).unwrap(); // removing twice is fine
        let _ = std::fs::remove_dir_all(dir);
    }
}
