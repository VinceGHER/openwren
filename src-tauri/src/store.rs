//! SQLite storage: opening the encrypted database and applying migrations.
//!
//! The file is encrypted with SQLCipher. Its key is 32 random bytes (64 hex
//! digits) that the app keeps in the system keyring, never on disk.

use std::io::Read;
use std::path::Path;

use rusqlite::{Connection, Result};

/// Migrations in order. The database's `user_version` is the number applied.
/// Never edit a released migration; append a new one.
const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_initial.sql"),
    include_str!("../migrations/0002_send_ops_threads.sql"),
    include_str!("../migrations/0003_recipient_addresses.sql"),
    include_str!("../migrations/0004_drafts_no_pop3.sql"),
    include_str!("../migrations/0005_privacy_drafts_signatures.sql"),
    include_str!("../migrations/0006_trusted_checks_picked_files.sql"),
    include_str!("../migrations/0007_fast_folder_lists.sql"),
];

const PLAIN_HEADER: &[u8; 16] = b"SQLite format 3\0";

/// True when the file is an ordinary, unencrypted SQLite database.
pub fn is_plain(path: &Path) -> bool {
    let mut start = [0u8; 16];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut start)).is_ok() && &start == PLAIN_HEADER
}

fn key_literal(key: &str) -> Result<String> {
    if key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(format!("\"x'{key}'\""))
    } else {
        Err(rusqlite::Error::InvalidParameterName("the database key must be 64 hex digits".into()))
    }
}

/// Open the encrypted database, creating it if needed. A database left
/// unencrypted by an earlier version is encrypted in place first.
pub fn open(path: &Path, key: &str) -> Result<Connection> {
    if is_plain(path) {
        encrypt_plain_file(path, key)?;
    }
    let mut conn = Connection::open(path)?;
    conn.execute_batch(&format!("PRAGMA key = {};", key_literal(key)?))?;
    // A wrong key only shows when the file is first read.
    conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    configure(&mut conn)?;
    Ok(conn)
}

/// Copy an unencrypted database into an encrypted one and put it in its place.
fn encrypt_plain_file(path: &Path, key: &str) -> Result<()> {
    let sibling = |suffix: &str| {
        let mut name = path.as_os_str().to_owned();
        name.push(suffix);
        std::path::PathBuf::from(name)
    };
    let encrypted = sibling(".encrypting");
    let _ = std::fs::remove_file(&encrypted);
    {
        let conn = Connection::open(path)?;
        let version = schema_version(&conn)?;
        // Fold the write-ahead log into the main file so nothing is left behind.
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        conn.execute(&format!("ATTACH DATABASE ?1 AS encrypted KEY {}", key_literal(key)?), [encrypted.to_string_lossy()])?;
        conn.query_row("SELECT sqlcipher_export('encrypted')", [], |_| Ok(()))?;
        conn.execute_batch(&format!("PRAGMA encrypted.user_version = {version}; DETACH DATABASE encrypted;"))?;
    }
    // The old write-ahead files must not be applied to the new database.
    let _ = std::fs::remove_file(sibling("-wal"));
    let _ = std::fs::remove_file(sibling("-shm"));
    std::fs::rename(&encrypted, path).map_err(|e| rusqlite::Error::InvalidPath(format!("{}: {e}", path.display()).into()))?;
    Ok(())
}

/// A fresh in-memory database with the full schema, for tests.
pub fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &mut Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(conn)
}

pub fn schema_version(conn: &Connection) -> Result<i64> {
    conn.pragma_query_value(None, "user_version", |row| row.get(0))
}

fn migrate(conn: &mut Connection) -> Result<()> {
    let applied = schema_version(conn)? as usize;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(applied) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (index + 1) as i64)?;
        tx.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory() -> Connection {
        open_in_memory().unwrap()
    }

    #[test]
    fn migrations_apply_and_set_version() {
        let conn = memory();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrating_twice_is_a_no_op() {
        let mut conn = memory();
        migrate(&mut conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn full_text_search_finds_old_mail() {
        let conn = memory();
        conn.execute_batch(
            "INSERT INTO accounts (id, address, kind) VALUES (1, 'katy@work.com', 'imap');
             INSERT INTO messages (id, account_id, from_name, from_address, subject, date)
               VALUES (1, 1, 'Nordic Print', 'billing@nordicprint.example', 'Invoice 2023-1102', 1698915720);
             INSERT INTO search_index (rowid, subject, sender, recipients, body)
               VALUES (1, 'Invoice 2023-1102', 'Nordic Print', 'katy@work.com', 'Attached is your invoice.');",
        )
        .unwrap();
        let id: i64 = conn
            .query_row(
                "SELECT m.id FROM search_index s JOIN messages m ON m.id = s.rowid
                 WHERE search_index MATCH 'invoice' AND m.date < 1731000000",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(id, 1);
    }

    const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

    fn temp_db(name: &str) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("openwren-{name}-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[test]
    fn new_database_is_encrypted_and_needs_its_key() {
        let path = temp_db("new");
        open(&path, KEY).unwrap().execute("INSERT INTO settings (key, value) VALUES ('secret', 'hello')", []).unwrap();
        assert!(!is_plain(&path));
        assert!(!std::fs::read(&path).unwrap().windows(5).any(|w| w == b"hello"));
        assert!(open(&path, &KEY.replace('0', "1")).is_err());
        let value: String = open(&path, KEY).unwrap().query_row("SELECT value FROM settings WHERE key = 'secret'", [], |r| r.get(0)).unwrap();
        assert_eq!(value, "hello");
        assert!(open(&path, "short").is_err());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn plain_database_is_encrypted_in_place_and_keeps_its_mail() {
        let path = temp_db("plain");
        {
            // What version 0.1.0 left on disk: an unencrypted database, part way through the migrations.
            let conn = Connection::open(&path).unwrap();
            conn.pragma_update(None, "journal_mode", "WAL").unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute_batch(
                "INSERT INTO accounts (id, address, kind) VALUES (1, 'katy@work.com', 'imap');
                 INSERT INTO messages (id, account_id, subject, date) VALUES (1, 1, 'Invoice 2023-1102', 1698915720);
                 INSERT INTO search_index (rowid, subject, sender, recipients, body) VALUES (1, 'Invoice 2023-1102', 'Nordic Print', '', 'Attached is your invoice.');",
            )
            .unwrap();
        }
        assert!(is_plain(&path));
        let conn = open(&path, KEY).unwrap();
        assert!(!is_plain(&path));
        assert_eq!(schema_version(&conn).unwrap(), MIGRATIONS.len() as i64);
        let found: i64 = conn.query_row("SELECT rowid FROM search_index WHERE search_index MATCH 'invoice'", [], |r| r.get(0)).unwrap();
        assert_eq!(found, 1);
        drop(conn);
        assert!(!std::fs::read(&path).unwrap().windows(7).any(|w| w == b"Invoice"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn deleting_an_account_removes_its_mail() {
        let conn = memory();
        conn.execute_batch(
            "INSERT INTO accounts (id, address, kind) VALUES (1, 'a@b.c', 'imap');
             INSERT INTO messages (id, account_id, subject, date) VALUES (1, 1, 'x', 0);
             DELETE FROM accounts WHERE id = 1;",
        )
        .unwrap();
        let left: i64 = conn.query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
