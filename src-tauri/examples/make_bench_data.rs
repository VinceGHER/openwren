//! Create a data folder holding a synthetic mailbox, for timing the whole app
//! without touching real mail. Used by `scripts/bench.sh`.
//!
//! `cargo run --release --example make_bench_data -- <folder> <messages>`
//! then start the app with `XDG_DATA_HOME=<folder>`.
//!
//! The database is encrypted with the key in the system keyring, like a real
//! one (the key is created if this computer has none yet). The account has no
//! mail server, so the app shows the mailbox as it is and syncs nothing.

use openwren_lib::model::AccountSettings;
use openwren_lib::{db, sample_data, store};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(folder), Some(count)) = (args.next(), args.next().and_then(|n| n.parse::<usize>().ok())) else {
        return Err("usage: make_bench_data <folder> <messages>".into());
    };
    let dir = std::path::Path::new(&folder).join("org.openwren.app");
    std::fs::create_dir_all(&dir)?;
    let database = dir.join("openwren.db");
    let mut conn = store::open(&database, &openwren_lib::database_key(&database)?)?;
    let account = db::insert_account(&conn, "katy@work.test", "Katy Reid", "imap", &AccountSettings::default()).map_err(|e| e.0)?;
    let inbox = db::upsert_folder(&conn, account, "INBOX", "Inbox", "inbox").map_err(|e| e.0)?;
    for (path, name, role) in [("Drafts", "Drafts", "drafts"), ("Sent", "Sent", "sent"), ("Trash", "Trash", "trash"), ("Archive", "Archive", "archive")] {
        db::upsert_folder(&conn, account, path, name, role).map_err(|e| e.0)?;
    }
    sample_data::fill(&mut conn, account, inbox, count, chrono::Utc::now().timestamp()).map_err(|e| e.0)?;
    // No welcome screens and no usage request during a benchmark.
    db::set_setting(&conn, "onboarded", "yes").map_err(|e| e.0)?;
    db::set_setting(&conn, "usage_stats", "off").map_err(|e| e.0)?;
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    println!("{count} messages in {}", database.display());
    Ok(())
}
