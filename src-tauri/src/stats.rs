//! The anonymous usage count: at most one small request a day, so the project
//! can see how many people use OpenWren without knowing who they are.
//!
//! Nothing here identifies a person or a computer. There is no install id.
//! The request says which version and kind of system it comes from, and
//! whether it is this installation's first request today, this week, this
//! month and ever; the server only adds those up. What was last sent is kept
//! in the local settings table, never on the server.

use chrono::{DateTime, Datelike, Utc};
use rusqlite::Connection;
use serde::Serialize;

use crate::db;
use crate::error::Result;

pub const ENDPOINT: &str = "https://stats.openwren.app/ping";

/// Exactly what is sent. Field names are short because the server stores only counters.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Ping {
    /// App version, such as "0.1.0".
    pub v: String,
    /// How it was installed: "deb", "rpm", "appimage", "flatpak", "dmg" (macOS), "exe" (Windows) or "other".
    pub pkg: String,
    /// Distribution and version, such as "ubuntu-24.04".
    pub os: String,
    /// Processor type, such as "x86_64".
    pub arch: String,
    /// First request today, this week, this month, ever.
    pub d: bool,
    pub w: bool,
    pub m: bool,
    pub first: bool,
    /// The week the app was first used, such as "2026-W46".
    pub iw: String,
}

fn day(now: DateTime<Utc>) -> String {
    now.format("%Y-%m-%d").to_string()
}

fn week(now: DateTime<Utc>) -> String {
    let iso = now.iso_week();
    format!("{}-W{:02}", iso.year(), iso.week())
}

fn month(now: DateTime<Utc>) -> String {
    now.format("%Y-%m").to_string()
}

/// False when the user switched the count off, or `OPENWREN_NO_STATS` is set
/// (tests, CI), or this is a development build.
pub fn enabled(conn: &Connection) -> bool {
    !cfg!(debug_assertions) && std::env::var_os("OPENWREN_NO_STATS").is_none() && switched_on(conn)
}

/// The user's own choice in Settings; on unless switched off.
pub fn switched_on(conn: &Connection) -> bool {
    db::get_setting(conn, "usage_stats").ok().flatten().as_deref() != Some("off")
}

/// The request that would be sent now, or None when today's has already gone out.
pub fn next(conn: &Connection, now: DateTime<Utc>, version: &str) -> Result<Option<Ping>> {
    let last = |key: &str| db::get_setting(conn, key);
    if last("stats_last_day")?.as_deref() == Some(day(now).as_str()) {
        return Ok(None);
    }
    let install_week = last("stats_install_week")?;
    let (pkg, os) = system();
    Ok(Some(Ping {
        v: version.to_string(),
        pkg,
        os,
        arch: std::env::consts::ARCH.to_string(),
        d: true,
        w: last("stats_last_week")?.as_deref() != Some(week(now).as_str()),
        m: last("stats_last_month")?.as_deref() != Some(month(now).as_str()),
        first: install_week.is_none(),
        iw: install_week.unwrap_or_else(|| week(now)),
    }))
}

/// Remember that a request went out, so the next one carries the right flags.
pub fn record(conn: &Connection, ping: &Ping, now: DateTime<Utc>) -> Result<()> {
    db::set_setting(conn, "stats_last_day", &day(now))?;
    db::set_setting(conn, "stats_last_week", &week(now))?;
    db::set_setting(conn, "stats_last_month", &month(now))?;
    db::set_setting(conn, "stats_install_week", &ping.iw)
}

/// (package kind, "distribution-version") of this computer, from `/etc/os-release`.
fn system() -> (String, String) {
    // macOS and Windows have one installer each and no distributions to tell apart.
    if cfg!(target_os = "macos") {
        return ("dmg".into(), "macos".into());
    }
    if cfg!(target_os = "windows") {
        return ("exe".into(), "windows".into());
    }
    let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
    let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
    describe(&release, &exe, std::env::var_os("APPIMAGE").is_some(), std::path::Path::new("/.flatpak-info").exists())
}

fn describe(os_release: &str, exe: &str, appimage: bool, flatpak: bool) -> (String, String) {
    let field = |name: &str| {
        os_release
            .lines()
            .find_map(|line| line.strip_prefix(name)?.strip_prefix('='))
            .map(|value| value.trim().trim_matches('"').to_lowercase())
            .unwrap_or_default()
    };
    let clean = |text: String, allowed: fn(char) -> bool, max: usize| text.chars().filter(|c| allowed(*c)).take(max).collect::<String>();
    let id = clean(field("ID"), |c| c.is_ascii_alphanumeric() || c == '-', 24);
    let version = clean(field("VERSION_ID"), |c| c.is_ascii_digit() || c == '.', 8);
    let os = match (id.is_empty(), version.is_empty()) {
        (true, _) => "other".to_string(),
        (false, true) => id.clone(),
        (false, false) => format!("{id}-{version}"),
    };
    let family = format!("{id} {}", field("ID_LIKE"));
    let pkg = if appimage {
        "appimage"
    } else if flatpak {
        "flatpak"
    } else if !exe.starts_with("/usr/") {
        "other" // run from a build folder or unpacked by hand
    } else if ["debian", "ubuntu"].iter().any(|f| family.contains(f)) {
        "deb"
    } else if ["fedora", "rhel", "suse", "centos"].iter().any(|f| family.contains(f)) {
        "rpm"
    } else {
        "other"
    };
    (pkg.to_string(), os)
}

/// Send one request. Failure is silent and simply tried again later.
pub async fn send(ping: &Ping) -> Result<()> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).user_agent("OpenWren").build()?;
    let response = client.post(ENDPOINT).json(ping).send().await?;
    if !response.status().is_success() {
        return Err(crate::error::Error(format!("The usage counter answered {}.", response.status())));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(y: i32, m: u32, d: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, 9, 30, 0).unwrap()
    }

    #[test]
    fn one_request_a_day_with_the_right_first_flags() {
        let conn = crate::store::open_in_memory().unwrap();
        // First ever: everything is a first.
        let friday = at(2026, 11, 13);
        let first = next(&conn, friday, "0.1.0").unwrap().unwrap();
        assert_eq!((first.d, first.w, first.m, first.first), (true, true, true, true));
        assert_eq!(first.iw, "2026-W46");
        assert_eq!(first.v, "0.1.0");
        record(&conn, &first, friday).unwrap();

        // Same day: nothing more is sent.
        assert_eq!(next(&conn, friday, "0.1.0").unwrap(), None);

        // Next day, same week and month.
        let saturday = at(2026, 11, 14);
        let second = next(&conn, saturday, "0.1.0").unwrap().unwrap();
        assert_eq!((second.d, second.w, second.m, second.first), (true, false, false, false));
        assert_eq!(second.iw, "2026-W46", "the install week never changes");
        record(&conn, &second, saturday).unwrap();

        // Monday: a new week, same month.
        let monday = at(2026, 11, 16);
        let third = next(&conn, monday, "0.1.0").unwrap().unwrap();
        assert_eq!((third.w, third.m), (true, false));
        record(&conn, &third, monday).unwrap();

        // A missed stretch is not made up for: one request, with the flags of that day.
        let december = at(2026, 12, 3);
        let fourth = next(&conn, december, "0.2.0").unwrap().unwrap();
        assert_eq!((fourth.d, fourth.w, fourth.m, fourth.first), (true, true, true, false));
        assert_eq!(fourth.v, "0.2.0");
    }

    #[test]
    fn the_week_follows_the_iso_calendar_across_new_year() {
        assert_eq!(week(at(2027, 1, 1)), "2026-W53");
        assert_eq!(week(at(2027, 1, 4)), "2027-W01");
    }

    #[test]
    fn can_be_switched_off() {
        let conn = crate::store::open_in_memory().unwrap();
        assert!(switched_on(&conn));
        db::set_setting(&conn, "usage_stats", "off").unwrap();
        assert!(!switched_on(&conn));
        assert!(!enabled(&conn));
    }

    #[test]
    fn describes_the_system_without_anything_personal() {
        let ubuntu = "NAME=\"Ubuntu\"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID=\"24.04\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n";
        assert_eq!(describe(ubuntu, "/usr/bin/openwren", false, false), ("deb".into(), "ubuntu-24.04".into()));
        assert_eq!(describe(ubuntu, "/home/someone/build/openwren", false, false), ("other".into(), "ubuntu-24.04".into()));
        assert_eq!(describe(ubuntu, "/tmp/.mount_x/usr/bin/openwren", true, false).0, "appimage");
        let fedora = "ID=fedora\nVERSION_ID=41\n";
        assert_eq!(describe(fedora, "/usr/bin/openwren", false, false), ("rpm".into(), "fedora-41".into()));
        let arch = "ID=arch\nBUILD_ID=rolling\n";
        assert_eq!(describe(arch, "/usr/bin/openwren", false, false), ("other".into(), "arch".into()));
        assert_eq!(describe("", "/usr/bin/openwren", false, true), ("flatpak".into(), "other".into()));
        // A hand-edited file cannot smuggle text into the request.
        assert_eq!(describe("ID=\"my host; rm -rf\"\nVERSION_ID=\"1.2 beta\"\n", "/usr/bin/x", false, false).1, "myhostrm-rf-1.2");
    }
}
