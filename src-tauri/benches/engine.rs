//! Engine benchmarks: how long the things a user waits for take, on an
//! encrypted mailbox of a known size. Run with `cargo bench --bench engine`.
//!
//! Sizes come from `OPENWREN_BENCH_SIZES` (default "50000,200000"). With
//! `OPENWREN_TEST_IMAP=host:port` set, sync speed is measured against that
//! server for the user in `OPENWREN_BENCH_USER` (default bench@work.test).
//! Output is a Markdown table, as used in docs/benchmarks.md.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use openwren_lib::db::{self, Db};
use openwren_lib::model::{AccountSettings, SearchFilters, Security, ServerSettings};
use openwren_lib::sample_data::{self, Rng};
use openwren_lib::sync::{self, Silent};
use openwren_lib::{imap, store};

const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

/// Run `f` `runs` times; return (median, 95th percentile).
fn time(runs: usize, mut f: impl FnMut()) -> (Duration, Duration) {
    let mut samples: Vec<Duration> = (0..runs)
        .map(|_| {
            let start = Instant::now();
            f();
            start.elapsed()
        })
        .collect();
    samples.sort();
    (samples[runs / 2], samples[(runs * 95 / 100).min(runs - 1)])
}

fn ms(d: Duration) -> String {
    let v = d.as_secs_f64() * 1000.0;
    if v < 10.0 { format!("{v:.2} ms") } else { format!("{v:.0} ms") }
}

fn row(what: &str, (median, p95): (Duration, Duration)) {
    println!("| {what} | {} | {} |", ms(median), ms(p95));
}

fn engine(count: usize) {
    let path = std::env::temp_dir().join(format!("openwren-bench-{count}-{}.db", std::process::id()));
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
    let now = chrono::Utc::now();
    let built = Instant::now();
    let mut conn = store::open(&path, KEY).unwrap();
    let account = db::insert_account(&conn, "katy@work.test", "Katy Reid", "imap", &AccountSettings::default()).unwrap();
    let folder = db::upsert_folder(&conn, account, "INBOX", "Inbox", "inbox").unwrap();
    sample_data::fill(&mut conn, account, folder, count, now.timestamp()).unwrap();
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);").ok();
    drop(conn);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    println!("\n### {count} messages\n");
    println!("Encrypted database: {:.0} MB, generated in {:.0} s.\n", size as f64 / 1e6, built.elapsed().as_secs_f64());
    println!("| Operation | Median | 95th percentile |");
    println!("|---|---|---|");

    row("Open the encrypted database", time(10, || drop(store::open(&path, KEY).unwrap())));
    let conn = store::open(&path, KEY).unwrap();
    let stamp = now.timestamp();
    // A few pinned messages, as a real mailbox would have.
    conn.execute("UPDATE messages SET pinned = 1 WHERE id IN (SELECT id FROM messages ORDER BY date DESC LIMIT 5 OFFSET 20)", []).unwrap();
    row("Show a folder (first 100 messages)", time(200, || drop(db::list_filtered(&conn, folder, None, None, 100, 0, stamp).unwrap())));
    row("Scroll to the 50th page of a folder", time(100, || drop(db::list_filtered(&conn, folder, None, None, 100, 4900, stamp).unwrap())));
    row("Folder list with unread counts", time(100, || drop(db::list_folders(&conn).unwrap())));
    row("Pinned messages of a folder", time(100, || drop(db::list_pinned(&conn, folder, None).unwrap())));
    row("Show only unread mail", time(100, || drop(db::list_filtered(&conn, folder, None, Some("unread"), 100, 0, stamp).unwrap())));

    let ids: Vec<i64> = {
        let mut stmt = conn.prepare("SELECT id FROM messages ORDER BY id").unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        rows
    };
    let mut rng = Rng::new(7);
    row("Open a message", time(1000, || drop(db::message_detail(&conn, ids[rng.below(ids.len())]).unwrap())));

    let words = sample_data::vocabulary();
    let filters = SearchFilters::default();
    let search = |query: &str, filters: &SearchFilters| db::search(&conn, query, filters, now, 300).unwrap().len();
    let (common, rare) = (words[3].clone(), words[words.len() - 5].clone());
    row("Search: one common word", time(50, || { let _ = search(&common, &filters); }));
    row("Search: one rare word", time(50, || { let _ = search(&rare, &filters); }));
    row("Search: two words", time(50, || { let _ = search(&format!("{common} {}", words[11]), &filters); }));
    row("Search: `from:kane invoice`", time(50, || { let _ = search("from:kane invoice", &filters); }));
    let older = SearchFilters { date: "older-2y".into(), ..SearchFilters::default() };
    row("Search: a word in mail older than 2 years", time(50, || { let _ = search(&common, &older); }));
    drop(conn);
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

/// Headers and message texts per second from an IMAP server into an encrypted database.
fn sync_speed(target: &str) {
    let (host, port) = target.split_once(':').expect("OPENWREN_TEST_IMAP must be host:port");
    let user = std::env::var("OPENWREN_BENCH_USER").unwrap_or_else(|_| "bench@work.test".into());
    let settings = ServerSettings { host: host.into(), port: port.parse().unwrap(), security: Security::None, username: user.clone() };
    let path = std::env::temp_dir().join(format!("openwren-bench-sync-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let db: Db = Arc::new(Mutex::new(store::open(&path, KEY).unwrap()));
    let account = db::insert_account(&db::lock(&db), &user, "Bench", "imap", &AccountSettings { imap: Some(settings.clone()), ..Default::default() }).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let mut session = imap::connect(&settings, "pass").await.unwrap();
        let start = Instant::now();
        sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
        let headers = start.elapsed();
        let (_, total) = db::body_counts(&db::lock(&db), account).unwrap();
        // sync_headers already fetched the newest few texts; count what is left.
        let (had, _) = db::body_counts(&db::lock(&db), account).unwrap();
        let start = Instant::now();
        while sync::sync_bodies(&db, &mut session, account, 2000, 0, &Silent).await.unwrap() > 0 {}
        let bodies = start.elapsed();
        println!("\n### Sync from a mail server on the same computer ({total} messages)\n");
        println!("| Step | Time | Rate |");
        println!("|---|---|---|");
        println!("| Headers of every message | {:.1} s | {:.0} messages per second |", headers.as_secs_f64(), total as f64 / headers.as_secs_f64());
        println!("| Text of every message | {:.1} s | {:.0} messages per second |", bodies.as_secs_f64(), (total - had) as f64 / bodies.as_secs_f64());
    });
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
    }
}

fn main() {
    // `cargo bench` passes flags such as --bench; none are needed here.
    let sizes = std::env::var("OPENWREN_BENCH_SIZES").unwrap_or_else(|_| "50000,200000".into());
    for size in sizes.split(',').filter_map(|s| s.trim().parse::<usize>().ok()) {
        engine(size);
    }
    if let Ok(target) = std::env::var("OPENWREN_TEST_IMAP") {
        sync_speed(&target);
    }
}
