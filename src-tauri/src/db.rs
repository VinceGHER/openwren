//! All SQL lives here. Functions take a plain connection and never block on the network.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::Result;
use crate::model::*;
use crate::parse::{Body, Header};

/// The one database connection. Lock it briefly; never hold it across an `.await`.
pub type Db = Arc<Mutex<Connection>>;

pub fn lock(db: &Db) -> MutexGuard<'_, Connection> {
    db.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------- accounts ----------

pub fn insert_account(conn: &Connection, address: &str, display_name: &str, kind: &str, settings: &AccountSettings) -> Result<i64> {
    conn.execute(
        "INSERT INTO accounts (address, display_name, kind, settings, position)
         VALUES (?1, ?2, ?3, ?4, (SELECT coalesce(max(position), 0) + 1 FROM accounts))",
        params![address, display_name, kind, serde_json::to_string(settings)?],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_accounts(conn: &Connection) -> Result<Vec<Account>> {
    let mut stmt = conn.prepare(
        "SELECT a.id, a.address, a.display_name, a.kind, (SELECT value FROM settings WHERE key = 'auth_server_' || a.id)
           FROM accounts a ORDER BY a.position, a.id",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Account { id: r.get(0)?, address: r.get(1)?, display_name: r.get(2)?, kind: r.get(3)?, auth_server: r.get(4)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The mail server whose sender checks this account trusts.
pub fn auth_server(conn: &Connection, account_id: i64) -> Result<Option<String>> {
    get_setting(conn, &format!("auth_server_{account_id}"))
}

/// Work out which server does the sender checks for an account: the one named in
/// at least half of its mail. A sender can write such a header too, but cannot
/// write it into most of the mailbox. Returns true when the answer changed.
pub fn learn_auth_server(conn: &Connection, account_id: i64) -> Result<bool> {
    let read: i64 = conn.query_row("SELECT count(*) FROM messages WHERE account_id = ?1 AND auth IS NOT NULL", [account_id], |r| r.get(0))?;
    let top: Option<(String, i64)> = conn
        .query_row(
            "SELECT substr(auth, 4, instr(auth || ';', ';') - 4) AS server, count(*) AS n FROM messages
              WHERE account_id = ?1 AND auth LIKE 'id=%' GROUP BY server ORDER BY n DESC LIMIT 1",
            [account_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let learned = top.filter(|(_, n)| *n >= 5 && *n * 2 >= read).map(|(server, _)| server);
    if learned == auth_server(conn, account_id)? {
        return Ok(false);
    }
    let key = format!("auth_server_{account_id}");
    match learned {
        Some(server) => set_setting(conn, &key, &server)?,
        None => {
            conn.execute("DELETE FROM settings WHERE key = ?1", [key])?;
        }
    }
    Ok(true)
}

// ---------- files chosen for attaching ----------

pub fn remember_picked(conn: &Connection, path: &str) -> Result<()> {
    conn.execute("INSERT OR IGNORE INTO picked_files (path) VALUES (?1)", [path])?;
    Ok(())
}

/// True when the user chose this file in the file dialog at some point.
pub fn was_picked(conn: &Connection, path: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM picked_files WHERE path = ?1)", [path], |r| r.get(0))?)
}

/// The account's address and server settings.
pub fn account_settings(conn: &Connection, account_id: i64) -> Result<(String, AccountSettings)> {
    let (address, json): (String, String) =
        conn.query_row("SELECT address, settings FROM accounts WHERE id = ?1", [account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok((address, serde_json::from_str(&json)?))
}

// ---------- folders ----------

pub fn upsert_folder(conn: &Connection, account_id: i64, path: &str, name: &str, role: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO folders (account_id, path, name, role, favorite) VALUES (?1, ?2, ?3, ?4, ?4 = 'inbox')
         ON CONFLICT (account_id, path) DO UPDATE SET name = excluded.name, role = excluded.role",
        params![account_id, path, name, role],
    )?;
    Ok(conn.query_row("SELECT id FROM folders WHERE account_id = ?1 AND path = ?2", params![account_id, path], |r| r.get(0))?)
}

/// Drop local folders that no longer exist on the server.
pub fn keep_only_folders(conn: &Connection, account_id: i64, keep: &[i64]) -> Result<()> {
    let mut stmt = conn.prepare("SELECT id FROM folders WHERE account_id = ?1")?;
    let local: Vec<i64> = stmt.query_map([account_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for id in local.into_iter().filter(|id| !keep.contains(id)) {
        delete_folder_messages(conn, id)?;
        conn.execute("DELETE FROM folders WHERE id = ?1", [id])?;
    }
    Ok(())
}

pub fn list_folders(conn: &Connection) -> Result<Vec<Folder>> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.account_id, f.name, f.role, f.favorite,
                (SELECT count(*) FROM messages m WHERE m.unread = 1
                    AND EXISTS (SELECT 1 FROM message_folders mf WHERE mf.message_id = m.id AND mf.folder_id = f.id))
           FROM folders f JOIN accounts a ON a.id = f.account_id
          ORDER BY a.position, a.id,
                   CASE f.role WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2 WHEN 'trash' THEN 3
                               WHEN 'junk' THEN 4 WHEN 'archive' THEN 5 ELSE 6 END,
                   f.name COLLATE NOCASE",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Folder { id: r.get(0)?, account_id: r.get(1)?, name: r.get(2)?, role: r.get(3)?, favorite: r.get(4)?, unread: r.get(5)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Mark every message in a folder (or in all inboxes) as read here, and queue the
/// same for the server. Returns the accounts to wake.
pub fn mark_folder_read(conn: &Connection, folder_id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT id, account_id, path FROM folders WHERE (?1 < 0 AND role = 'inbox') OR id = ?1")?;
    let folders: Vec<(i64, i64, String)> = stmt.query_map([folder_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut accounts = Vec::new();
    for (id, account_id, path) in folders {
        let changed = conn.execute("UPDATE messages SET unread = 0 WHERE unread = 1 AND id IN (SELECT message_id FROM message_folders WHERE folder_id = ?1)", [id])?;
        if changed > 0 {
            enqueue_op(conn, account_id, "mark-read", &serde_json::json!({ "srcPath": path }), 0)?;
            accounts.push(account_id);
        }
    }
    Ok(accounts)
}

pub fn set_favorite(conn: &Connection, folder_id: i64, favorite: bool) -> Result<()> {
    conn.execute("UPDATE folders SET favorite = ?2 WHERE id = ?1", params![folder_id, favorite])?;
    Ok(())
}

pub fn folder_uid_validity(conn: &Connection, folder_id: i64) -> Result<Option<u32>> {
    Ok(conn.query_row("SELECT uid_validity FROM folders WHERE id = ?1", [folder_id], |r| r.get(0))?)
}

pub fn set_folder_uid_validity(conn: &Connection, folder_id: i64, uid_validity: Option<u32>) -> Result<()> {
    conn.execute("UPDATE folders SET uid_validity = ?2 WHERE id = ?1", params![folder_id, uid_validity])?;
    Ok(())
}

pub fn delete_folder_messages(conn: &Connection, folder_id: i64) -> Result<()> {
    conn.execute("DELETE FROM messages WHERE id IN (SELECT message_id FROM message_folders WHERE folder_id = ?1)", [folder_id])?;
    Ok(())
}

// ---------- messages: writing ----------

pub fn local_uids(conn: &Connection, folder_id: i64) -> Result<HashSet<u32>> {
    let mut stmt = conn.prepare("SELECT uid FROM message_folders WHERE folder_id = ?1 AND uid IS NOT NULL")?;
    let rows = stmt.query_map([folder_id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub struct NewMessage<'a> {
    pub account_id: i64,
    pub folder_id: i64,
    /// The server UID; None while a moved message waits for the server to confirm.
    pub uid: Option<u32>,
    pub header: &'a Header,
    /// Used when the Date header is missing or unreadable.
    pub fallback_date: i64,
    pub size: u32,
    pub unread: bool,
    pub flagged: bool,
}

/// Store one message's header and index it for search. Call inside a transaction.
pub fn insert_message(conn: &Connection, m: &NewMessage) -> Result<i64> {
    let h = m.header;
    conn.execute(
        "INSERT INTO messages (account_id, message_id, in_reply_to, refs, from_name, from_address, to_list, cc_list,
                               subject, date, size, unread, flagged, focused, has_attachment, thread_key, to_addresses, cc_addresses, auth, unsubscribe)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
        params![
            m.account_id, h.message_id, h.in_reply_to, h.refs, h.from_name, h.from_address, h.to_list, h.cc_list,
            h.subject, h.date.unwrap_or(m.fallback_date), m.size, m.unread, m.flagged, h.focused, h.maybe_attachment, h.thread_key(), h.to_addresses, h.cc_addresses, h.auth, h.unsubscribe
        ],
    )?;
    let id = conn.last_insert_rowid();
    if h.focused {
        // People who write to you personally become autocomplete suggestions.
        remember_contact(conn, &h.from_name, &h.from_address, 1, h.date.unwrap_or(m.fallback_date))?;
    }
    // The date is repeated here so a folder can be listed in date order from an index.
    conn.execute("INSERT INTO message_folders (message_id, folder_id, uid, date) VALUES (?1, ?2, ?3, ?4)", params![id, m.folder_id, m.uid, h.date.unwrap_or(m.fallback_date)])?;
    conn.execute(
        "INSERT INTO search_index (rowid, subject, sender, recipients, body) VALUES (?1, ?2, ?3, ?4, '')",
        params![id, h.subject, format!("{} {}", h.from_name, h.from_address), format!("{} {}", h.to_list, h.cc_list)],
    )?;
    Ok(id)
}

pub fn delete_uids(conn: &Connection, folder_id: i64, uids: &[u32]) -> Result<()> {
    let mut stmt = conn.prepare(
        "DELETE FROM messages WHERE id IN (SELECT message_id FROM message_folders WHERE folder_id = ?1 AND uid = ?2)",
    )?;
    for uid in uids {
        stmt.execute(params![folder_id, uid])?;
    }
    Ok(())
}

/// Apply server flags. Returns true when something changed.
pub fn update_flags(conn: &Connection, folder_id: i64, uid: u32, unread: bool, flagged: bool) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE messages SET unread = ?3, flagged = ?4
          WHERE id IN (SELECT message_id FROM message_folders WHERE folder_id = ?1 AND uid = ?2)
            AND (unread != ?3 OR flagged != ?4)",
        params![folder_id, uid, unread, flagged],
    )?;
    Ok(changed > 0)
}

pub fn set_local_flags(conn: &Connection, id: i64, unread: Option<bool>, flagged: Option<bool>, pinned: Option<bool>) -> Result<()> {
    conn.execute(
        "UPDATE messages SET unread = coalesce(?2, unread), flagged = coalesce(?3, flagged), pinned = coalesce(?4, pinned) WHERE id = ?1",
        params![id, unread, flagged, pinned],
    )?;
    Ok(())
}

pub fn has_body(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM bodies WHERE message_id = ?1)", [id], |r| r.get(0))?)
}

/// Store a downloaded body, its attachments and its search text.
pub fn save_body(conn: &mut Connection, id: i64, body: &Body) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("INSERT OR REPLACE INTO bodies (message_id, html, plain) VALUES (?1, ?2, ?3)", params![id, body.html, body.plain])?;
    tx.execute("DELETE FROM attachments WHERE message_id = ?1", [id])?;
    for a in &body.attachments {
        tx.execute(
            "INSERT INTO attachments (message_id, name, mime_type, size, content_id) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, a.name, a.mime_type, a.size, a.content_id],
        )?;
    }
    tx.execute(
        "UPDATE messages SET preview = ?2, has_attachment = ?3 WHERE id = ?1",
        params![id, body.preview, !body.attachments.is_empty()],
    )?;
    tx.execute("UPDATE search_index SET body = ?2 WHERE rowid = ?1", params![id, body.plain])?;
    tx.commit()?;
    Ok(())
}

/// Where a message lives on the server.
pub struct Location {
    pub account_id: i64,
    pub folder_path: String,
    pub uid: u32,
}

pub fn location(conn: &Connection, id: i64) -> Result<Option<Location>> {
    Ok(conn
        .query_row(
            "SELECT m.account_id, f.path, mf.uid FROM messages m
               JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
              WHERE m.id = ?1 AND mf.uid IS NOT NULL LIMIT 1",
            [id],
            |r| Ok(Location { account_id: r.get(0)?, folder_path: r.get(1)?, uid: r.get(2)? }),
        )
        .optional()?)
}

/// Newest messages whose body is not downloaded yet: (message id, folder path, uid).
pub fn missing_bodies(conn: &Connection, account_id: i64, limit: u32, not_older_than: i64) -> Result<Vec<(i64, String, u32)>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, f.path, mf.uid FROM messages m
           JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
          WHERE m.account_id = ?1 AND mf.uid IS NOT NULL
            AND m.date >= ?3
            AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = m.id)
          ORDER BY m.date DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![account_id, limit, not_older_than], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// (messages with a body, all messages) for one account.
pub fn body_counts(conn: &Connection, account_id: i64) -> Result<(u32, u32)> {
    Ok(conn.query_row(
        "SELECT (SELECT count(*) FROM bodies b JOIN messages m ON m.id = b.message_id WHERE m.account_id = ?1),
                (SELECT count(*) FROM messages WHERE account_id = ?1)",
        [account_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

// ---------- messages: reading ----------

const SUMMARY: &str = "SELECT m.id, m.account_id, f.id, f.name, a.address, m.from_name, m.from_address, m.to_list, m.subject,
        m.preview, m.date, m.unread, m.flagged, m.pinned, m.focused, m.has_attachment, m.categories, m.snoozed_until, m.auth
   FROM messages m JOIN message_folders mf ON mf.message_id = m.id
   JOIN folders f ON f.id = mf.folder_id JOIN accounts a ON a.id = m.account_id";

fn summary(r: &Row) -> rusqlite::Result<MessageSummary> {
    Ok(MessageSummary {
        id: r.get(0)?,
        account_id: r.get(1)?,
        folder_id: r.get(2)?,
        folder_name: r.get(3)?,
        account_address: r.get(4)?,
        from_name: r.get(5)?,
        from_address: r.get(6)?,
        to: r.get(7)?,
        subject: r.get(8)?,
        preview: r.get(9)?,
        date: r.get(10)?,
        unread: r.get(11)?,
        flagged: r.get(12)?,
        pinned: r.get(13)?,
        focused: r.get(14)?,
        has_attachment: r.get(15)?,
        categories: serde_json::from_str(&r.get::<_, String>(16)?).unwrap_or_default(),
        snoozed_until: r.get(17)?,
        auth: r.get(18)?,
    })
}

/// Passed as a folder id to list the inboxes of every account together.
pub const ALL_INBOXES: i64 = -1;

/// The SQL condition for "in this folder"; `?1` is the folder id.
fn in_folder(folder_id: i64) -> &'static str {
    if folder_id == ALL_INBOXES { "f.role = 'inbox' AND ?1 < 0" } else { "mf.folder_id = ?1" }
}

/// One page of a folder, newest first. `focused` filters the Focused / Other tabs.
/// Snoozed messages stay hidden until `now` passes their time.
pub fn list_messages(conn: &Connection, folder_id: i64, focused: Option<bool>, limit: u32, offset: u32, now: i64) -> Result<Vec<MessageSummary>> {
    list_filtered(conn, folder_id, focused, None, limit, offset, now)
}

/// `list_messages`, optionally narrowed to "unread" or "flagged" mail.
pub fn list_filtered(conn: &Connection, folder_id: i64, focused: Option<bool>, only: Option<&str>, limit: u32, offset: u32, now: i64) -> Result<Vec<MessageSummary>> {
    let sql = format!(
        "{SUMMARY} WHERE {} AND (?2 IS NULL OR m.focused = ?2) AND (m.snoozed_until IS NULL OR m.snoozed_until <= ?5)
            AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.account_id = m.account_id AND d.message_id = m.message_id)
            AND (?6 IS NULL OR (?6 = 'unread' AND m.unread = 1) OR (?6 = 'flagged' AND m.flagged = 1))
         ORDER BY mf.date DESC, mf.message_id DESC LIMIT ?3 OFFSET ?4",
        in_folder(folder_id)
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![folder_id, focused, limit, offset, now, only], summary)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Pinned messages of a folder, regardless of paging.
pub fn list_pinned(conn: &Connection, folder_id: i64, focused: Option<bool>) -> Result<Vec<MessageSummary>> {
    // Pinned mail is a handful of messages: start from those (a small index) and
    // keep the ones in this folder, instead of walking the whole folder.
    let mut pinned = conn.prepare_cached("SELECT id FROM messages INDEXED BY messages_pinned WHERE pinned = 1")?;
    let ids: Vec<i64> = pinned.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let sql = format!("{SUMMARY} WHERE m.id = ?3 AND {} AND (?2 IS NULL OR m.focused = ?2)", in_folder(folder_id));
    let mut stmt = conn.prepare_cached(&sql)?;
    let mut out = Vec::new();
    for id in ids {
        out.extend(stmt.query_map(params![folder_id, focused, id], summary)?.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    out.sort_by(|a, b| b.date.cmp(&a.date));
    Ok(out)
}

/// Search everything stored locally, newest first. The query may use operators
/// (see search.rs). `now` is passed in so the date filters can be tested.
pub fn search(conn: &Connection, query: &str, filters: &SearchFilters, now: chrono::DateTime<chrono::Utc>, limit: u32) -> Result<Vec<MessageSummary>> {
    use rusqlite::types::Value;
    let parsed = crate::search::parse(query);
    if parsed.is_empty() {
        return Ok(Vec::new());
    }
    let years_ago = |n: u32| now.checked_sub_months(chrono::Months::new(12 * n)).unwrap_or(now).timestamp();
    let (chip_after, chip_before): (Option<i64>, Option<i64>) = match filters.date.as_str() {
        "past-year" => (Some(years_ago(1)), None),
        "older-1y" => (None, Some(years_ago(1))),
        "older-2y" => (None, Some(years_ago(2))),
        "custom" => (filters.after, filters.before),
        _ => (None, None),
    };
    let mut sql = String::from(SUMMARY);
    let mut wheres: Vec<String> = Vec::new();
    let mut values: Vec<Value> = Vec::new();
    let mut bind = |clause: &str, value: Value, wheres: &mut Vec<String>| {
        values.push(value);
        wheres.push(clause.replace('?', &format!("?{}", values.len())));
    };
    if let Some(fts) = &parsed.fts {
        sql.push_str(" JOIN search_index s ON s.rowid = m.id");
        bind("search_index MATCH ?", Value::Text(fts.clone()), &mut wheres);
    }
    if let Some(account) = filters.account_id {
        bind("m.account_id = ?", Value::Integer(account), &mut wheres);
    }
    // The chips and the typed operators both narrow the range; the tighter bound wins.
    let after = [chip_after, parsed.after].into_iter().flatten().max();
    let before = [chip_before, parsed.before].into_iter().flatten().min();
    if let Some(after) = after {
        bind("m.date >= ?", Value::Integer(after), &mut wheres);
    }
    if let Some(before) = before {
        bind("m.date < ?", Value::Integer(before), &mut wheres);
    }
    if let Some(folder) = &parsed.folder {
        bind("(f.name LIKE ? OR f.role = lower(?))", Value::Text(folder.clone()), &mut wheres);
    }
    if filters.has_attachment || parsed.has_attachment {
        wheres.push("m.has_attachment = 1".into());
    }
    if parsed.unread {
        wheres.push("m.unread = 1".into());
    }
    if parsed.flagged {
        wheres.push("m.flagged = 1".into());
    }
    sql.push_str(&format!(" WHERE {} ORDER BY m.date DESC LIMIT {limit}", wheres.join(" AND ")));
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(values), summary)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn message_detail(conn: &Connection, id: i64) -> Result<MessageDetail> {
    let sql = format!("{SUMMARY} WHERE m.id = ?1 LIMIT 1");
    let summary = conn.query_row(&sql, [id], summary)?;
    let (cc, message_id_header, references, to_addresses, cc_addresses, unsubscribe): (String, Option<String>, Option<String>, String, String, String) = conn.query_row(
        "SELECT cc_list, message_id, refs, to_addresses, cc_addresses, unsubscribe FROM messages WHERE id = ?1",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    )?;
    let confirmed = crate::parse::sender_confirmed(summary.auth.as_deref().unwrap_or(""), auth_server(conn, summary.account_id)?.as_deref());
    let options = serde_json::from_str::<Unsubscribe>(&unsubscribe).unwrap_or_default();
    let unsubscribe = options.kind(confirmed).map(str::to_string);
    let unsubscribe_to = unsubscribe.as_deref().and_then(|kind| options.destination(kind));
    let (html, plain): (Option<String>, Option<String>) = conn
        .query_row("SELECT html, plain FROM bodies WHERE message_id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?
        .unwrap_or((None, None));
    let mut stmt = conn.prepare("SELECT name, mime_type, size FROM attachments WHERE message_id = ?1 AND content_id IS NULL ORDER BY id")?;
    let attachments = stmt
        .query_map([id], |r| Ok(Attachment { name: r.get(0)?, mime_type: r.get(1)?, size: r.get(2)? }))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(MessageDetail { summary, cc, html, plain: plain.unwrap_or_default(), attachments, message_id_header, references, to_addresses, cc_addresses, unsubscribe, unsubscribe_to })
}

/// Newest messages whose sender checks and unsubscribe options have not been read yet
/// (mail synced by an earlier version): (message id, folder path, uid).
pub fn missing_header_info(conn: &Connection, account_id: i64, limit: u32) -> Result<Vec<(i64, String, u32)>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, f.path, mf.uid FROM messages m
           JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
          WHERE m.account_id = ?1 AND m.auth IS NULL AND mf.uid IS NOT NULL
          ORDER BY m.date DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![account_id, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn set_header_info(conn: &Connection, id: i64, auth: &str, unsubscribe: &str) -> Result<()> {
    conn.execute("UPDATE messages SET auth = ?2, unsubscribe = ?3 WHERE id = ?1", params![id, auth, unsubscribe])?;
    Ok(())
}

/// The account and unsubscribe options of a message, and whether its sender is confirmed.
pub fn unsubscribe_info(conn: &Connection, id: i64) -> Result<(i64, bool, Unsubscribe)> {
    let (account, auth, json): (i64, Option<String>, String) =
        conn.query_row("SELECT account_id, auth, unsubscribe FROM messages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?;
    let confirmed = crate::parse::sender_confirmed(auth.as_deref().unwrap_or(""), auth_server(conn, account)?.as_deref());
    Ok((account, confirmed, serde_json::from_str(&json).unwrap_or_default()))
}

// ---------- accounts: removing ----------

pub fn delete_account(conn: &Connection, account_id: i64) -> Result<()> {
    conn.execute("DELETE FROM messages WHERE account_id = ?1", [account_id])?;
    conn.execute("DELETE FROM accounts WHERE id = ?1", [account_id])?;
    Ok(())
}

pub fn account_exists(conn: &Connection, account_id: i64) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS (SELECT 1 FROM accounts WHERE id = ?1)", [account_id], |r| r.get(0))?)
}

pub fn account_identity(conn: &Connection, account_id: i64) -> Result<(String, String, String)> {
    Ok(conn.query_row("SELECT address, display_name, kind FROM accounts WHERE id = ?1", [account_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?)
}

pub fn folder_by_role(conn: &Connection, account_id: i64, role: &str) -> Result<Option<(i64, String)>> {
    Ok(conn
        .query_row("SELECT id, path FROM folders WHERE account_id = ?1 AND role = ?2 ORDER BY id LIMIT 1", params![account_id, role], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional()?)
}

// ---------- outbox ----------

pub struct Queued {
    pub id: i64,
    pub account_id: i64,
    pub raw: Vec<u8>,
    pub mail_from: String,
    pub recipients: Vec<String>,
    pub to_list: String,
    pub subject: String,
    pub attempts: i64,
}

#[allow(clippy::too_many_arguments)]
pub fn queue_outgoing(conn: &Connection, account_id: i64, raw: &[u8], mail_from: &str, recipients: &[String], to_list: &str, subject: &str, send_at: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO outbox (account_id, raw, send_after, mail_from, recipients, to_list, subject) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![account_id, raw, send_at, mail_from, serde_json::to_string(recipients)?, to_list, subject],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn due_outgoing(conn: &Connection, now: i64) -> Result<Vec<Queued>> {
    let mut stmt = conn.prepare(
        "SELECT id, account_id, raw, mail_from, recipients, to_list, subject, attempts FROM outbox WHERE send_after <= ?1 ORDER BY send_after, id",
    )?;
    let rows = stmt.query_map([now], |r| {
        let recipients: String = r.get(4)?;
        Ok(Queued {
            id: r.get(0)?,
            account_id: r.get(1)?,
            raw: r.get(2)?,
            mail_from: r.get(3)?,
            recipients: serde_json::from_str(&recipients).unwrap_or_default(),
            to_list: r.get(5)?,
            subject: r.get(6)?,
            attempts: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Remove a queued message. Returns false when it was already sent or removed.
pub fn remove_outgoing(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM outbox WHERE id = ?1", [id])? > 0)
}

pub fn fail_outgoing(conn: &Connection, id: i64, error: &str, retry_at: i64) -> Result<()> {
    conn.execute("UPDATE outbox SET attempts = attempts + 1, last_error = ?2, send_after = ?3 WHERE id = ?1", params![id, error, retry_at])?;
    Ok(())
}

pub fn list_outbox(conn: &Connection) -> Result<Vec<OutboxItem>> {
    let mut stmt = conn.prepare("SELECT id, account_id, to_list, subject, send_after, attempts, last_error FROM outbox ORDER BY send_after, id")?;
    let rows = stmt.query_map([], |r| {
        Ok(OutboxItem { id: r.get(0)?, account_id: r.get(1)?, to: r.get(2)?, subject: r.get(3)?, send_at: r.get(4)?, attempts: r.get(5)?, last_error: r.get(6)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ---------- signatures ----------

pub fn list_signatures(conn: &Connection) -> Result<Vec<Signature>> {
    let mut stmt = conn.prepare("SELECT id, name, html, layout, image FROM signatures ORDER BY name COLLATE NOCASE")?;
    let rows = stmt.query_map([], |r| Ok(Signature { id: r.get(0)?, name: r.get(1)?, html: r.get(2)?, layout: r.get(3)?, image: r.get(4)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Create (id 0) or update a signature. Returns its id.
pub fn save_signature(conn: &Connection, s: &Signature, plain: &str) -> Result<i64> {
    if s.id == 0 {
        conn.execute("INSERT INTO signatures (name, html, plain, layout, image) VALUES (?1, ?2, ?3, ?4, ?5)", params![s.name, s.html, plain, s.layout, s.image])?;
        Ok(conn.last_insert_rowid())
    } else {
        conn.execute("UPDATE signatures SET name = ?2, html = ?3, plain = ?4, layout = ?5, image = ?6 WHERE id = ?1", params![s.id, s.name, s.html, plain, s.layout, s.image])?;
        Ok(s.id)
    }
}

pub fn delete_signature(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM signatures WHERE id = ?1", [id])?;
    Ok(())
}

pub fn signature_defaults(conn: &Connection) -> Result<Vec<SignatureDefaults>> {
    let mut stmt = conn.prepare("SELECT account_id, new_id, reply_id FROM signature_defaults")?;
    let rows = stmt.query_map([], |r| Ok(SignatureDefaults { account_id: r.get(0)?, new_id: r.get(1)?, reply_id: r.get(2)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn set_signature_defaults(conn: &Connection, d: &SignatureDefaults) -> Result<()> {
    conn.execute(
        "INSERT INTO signature_defaults (account_id, new_id, reply_id) VALUES (?1, ?2, ?3)
         ON CONFLICT (account_id) DO UPDATE SET new_id = excluded.new_id, reply_id = excluded.reply_id",
        params![d.account_id, d.new_id, d.reply_id],
    )?;
    Ok(())
}

// ---------- contacts ----------

/// Remember an address for autocomplete. `weight` is higher for people the user writes to.
pub fn remember_contact(conn: &Connection, name: &str, address: &str, weight: i64, now: i64) -> Result<()> {
    if !address.contains('@') {
        return Ok(());
    }
    let name = if name == address { "" } else { name };
    conn.execute(
        "INSERT INTO contacts (address, name, use_count, last_used) VALUES (lower(?1), ?2, ?3, ?4)
         ON CONFLICT (address) DO UPDATE SET use_count = use_count + ?3, last_used = ?4,
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END",
        params![address, name, weight, now],
    )?;
    Ok(())
}

pub fn suggest_contacts(conn: &Connection, typed: &str, limit: u32) -> Result<Vec<Contact>> {
    let like = format!("%{}%", typed.trim().replace(['%', '_'], ""));
    let mut stmt = conn.prepare(
        "SELECT name, address FROM contacts WHERE address LIKE ?1 OR name LIKE ?1 ORDER BY use_count DESC, last_used DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![like, limit], |r| Ok(Contact { name: r.get(0)?, address: r.get(1)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ---------- moving, deleting, queued operations ----------

/// Where a message is shown: (account id, folder id, folder path, folder role, server UID if known).
pub fn placement(conn: &Connection, id: i64) -> Result<Option<(i64, i64, String, String, Option<u32>)>> {
    Ok(conn
        .query_row(
            "SELECT m.account_id, f.id, f.path, f.role, mf.uid FROM messages m
               JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id WHERE m.id = ?1 LIMIT 1",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()?)
}

pub fn folder_path(conn: &Connection, folder_id: i64) -> Result<(i64, String)> {
    Ok(conn.query_row("SELECT account_id, path FROM folders WHERE id = ?1", [folder_id], |r| Ok((r.get(0)?, r.get(1)?)))?)
}

/// Show a message in another folder. `uid` is None until the server confirms the move.
pub fn move_local(conn: &Connection, id: i64, folder_id: i64, uid: Option<u32>) -> Result<()> {
    conn.execute("UPDATE message_folders SET folder_id = ?2, uid = ?3 WHERE message_id = ?1", params![id, folder_id, uid])?;
    conn.execute("UPDATE messages SET pinned = 0 WHERE id = ?1", [id])?;
    Ok(())
}

pub fn delete_message(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM messages WHERE id = ?1", [id])?;
    Ok(())
}

pub struct Op {
    pub id: i64,
    pub kind: String,
    pub payload: serde_json::Value,
    pub attempts: i64,
}

pub fn enqueue_op(conn: &Connection, account_id: i64, kind: &str, payload: &serde_json::Value, not_before: i64) -> Result<i64> {
    conn.execute(
        "INSERT INTO pending_ops (account_id, kind, payload, not_before) VALUES (?1, ?2, ?3, ?4)",
        params![account_id, kind, payload.to_string(), not_before],
    )?;
    Ok(conn.last_insert_rowid())
}

fn op_row(r: &Row) -> rusqlite::Result<Op> {
    let payload: String = r.get(2)?;
    Ok(Op { id: r.get(0)?, kind: r.get(1)?, payload: serde_json::from_str(&payload).unwrap_or_default(), attempts: r.get(3)? })
}

pub fn due_ops(conn: &Connection, account_id: i64, now: i64) -> Result<Vec<Op>> {
    let mut stmt = conn.prepare("SELECT id, kind, payload, attempts FROM pending_ops WHERE account_id = ?1 AND not_before <= ?2 ORDER BY id")?;
    let rows = stmt.query_map(params![account_id, now], op_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn get_op(conn: &Connection, id: i64) -> Result<Option<Op>> {
    Ok(conn.query_row("SELECT id, kind, payload, attempts FROM pending_ops WHERE id = ?1", [id], op_row).optional()?)
}

/// Returns false when the operation was already carried out or removed.
pub fn remove_op(conn: &Connection, id: i64) -> Result<bool> {
    Ok(conn.execute("DELETE FROM pending_ops WHERE id = ?1", [id])? > 0)
}

pub fn fail_op(conn: &Connection, id: i64, error: &str) -> Result<()> {
    conn.execute("UPDATE pending_ops SET attempts = attempts + 1, last_error = ?2 WHERE id = ?1", params![id, error])?;
    Ok(())
}

/// UIDs in a folder that are queued to move away. Sync must not re-add them.
pub fn pending_move_uids(conn: &Connection, account_id: i64, folder_path: &str) -> Result<HashSet<u32>> {
    let mut stmt = conn.prepare(
        "SELECT json_extract(payload, '$.uid') FROM pending_ops
          WHERE account_id = ?1 AND kind IN ('move', 'expunge') AND json_extract(payload, '$.srcPath') = ?2",
    )?;
    let rows = stmt.query_map(params![account_id, folder_path], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A moved message waits in its new folder without a UID. When sync meets the
/// real copy there, give the waiting row its UID instead of adding a duplicate.
pub fn adopt_placeholder(conn: &Connection, folder_id: i64, message_id_header: &str, uid: u32) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE message_folders SET uid = ?3
          WHERE rowid = (SELECT mf.rowid FROM message_folders mf JOIN messages m ON m.id = mf.message_id
                          WHERE mf.folder_id = ?1 AND mf.uid IS NULL AND m.message_id = ?2 LIMIT 1)",
        params![folder_id, message_id_header, uid],
    )?;
    Ok(changed > 0)
}

/// After a folder is synced, rows still without a UID and without a queued
/// operation have a real twin (or are gone on the server): remove them.
pub fn drop_stale_placeholders(conn: &Connection, account_id: i64, folder_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE id IN (SELECT message_id FROM message_folders WHERE folder_id = ?2 AND uid IS NULL)
            AND id NOT IN (SELECT json_extract(payload, '$.messageId') FROM pending_ops WHERE account_id = ?1 AND kind = 'move')",
        params![account_id, folder_id],
    )?;
    Ok(())
}

/// Local ids of the given UIDs in a folder whose body is not downloaded yet.
pub fn without_body(conn: &Connection, folder_id: i64, uids: &[u32]) -> Result<Vec<(i64, u32)>> {
    let mut stmt = conn.prepare(
        "SELECT mf.message_id FROM message_folders mf
          WHERE mf.folder_id = ?1 AND mf.uid = ?2 AND NOT EXISTS (SELECT 1 FROM bodies b WHERE b.message_id = mf.message_id)",
    )?;
    let mut out = Vec::new();
    for uid in uids {
        if let Some(id) = stmt.query_row(params![folder_id, uid], |r| r.get(0)).optional()? {
            out.push((id, *uid));
        }
    }
    Ok(out)
}

pub fn account_folders(conn: &Connection, account_id: i64) -> Result<Vec<(i64, String)>> {
    let mut stmt = conn.prepare("SELECT id, path FROM folders WHERE account_id = ?1")?;
    let rows = stmt.query_map([account_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ---------- conversations, categories, snooze ----------

/// Every message of the conversation `id` belongs to, itself included, oldest
/// first, across folders (so your own replies in Sent appear), leaving out
/// Deleted, Junk and Drafts. A message filed in several folders (Gmail labels)
/// is listed once.
pub fn thread_messages(conn: &Connection, id: i64) -> Result<Vec<MessageSummary>> {
    let sql = format!(
        "{SUMMARY} WHERE (m.id = ?1 OR f.role NOT IN ('trash', 'junk', 'drafts'))
            AND (m.account_id, m.thread_key) = (SELECT account_id, thread_key FROM messages WHERE id = ?1 AND thread_key IS NOT NULL)
          ORDER BY m.date, m.id"
    );
    let mut stmt = conn.prepare(&sql)?;
    let all: Vec<MessageSummary> = stmt.query_map([id], summary)?.collect::<rusqlite::Result<_>>()?;
    // Copies of one message share sender, date and subject. Keep the open one, else the first.
    let same = |a: &MessageSummary, b: &MessageSummary| a.date == b.date && a.from_address == b.from_address && a.subject == b.subject;
    let mut out: Vec<MessageSummary> = Vec::new();
    for m in all {
        match out.iter_mut().find(|kept| same(kept, &m)) {
            Some(kept) if m.id == id => *kept = m,
            Some(_) => {}
            None => out.push(m),
        }
    }
    Ok(out)
}

pub fn set_categories(conn: &Connection, id: i64, categories: &[String]) -> Result<()> {
    conn.execute("UPDATE messages SET categories = ?2 WHERE id = ?1", params![id, serde_json::to_string(categories)?])?;
    Ok(())
}

pub fn set_snooze(conn: &Connection, id: i64, until: Option<i64>) -> Result<()> {
    conn.execute("UPDATE messages SET snoozed_until = ?2 WHERE id = ?1", params![id, until])?;
    Ok(())
}

/// Bring back messages whose snooze time has passed, as unread. Returns the accounts affected.
pub fn wake_snoozed(conn: &Connection, now: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare("SELECT DISTINCT account_id FROM messages WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?1")?;
    let accounts: Vec<i64> = stmt.query_map([now], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    conn.execute("UPDATE messages SET snoozed_until = NULL, unread = 1 WHERE snoozed_until IS NOT NULL AND snoozed_until <= ?1", [now])?;
    Ok(accounts)
}

// ---------- drafts ----------

/// Save a draft; `id` is None for a new one. Returns its id.
/// `message_id` is the Message-ID its copy on the server carries; it is set once, when the draft is created.
pub fn save_draft(conn: &Connection, id: Option<i64>, account_id: i64, content: &str, message_id: &str, now: i64) -> Result<i64> {
    if let Some(id) = id {
        let updated = conn.execute("UPDATE drafts SET account_id = ?2, content = ?3, updated_at = ?4 WHERE id = ?1", params![id, account_id, content, now])?;
        if updated > 0 {
            return Ok(id);
        }
    }
    conn.execute("INSERT INTO drafts (account_id, content, updated_at, message_id) VALUES (?1, ?2, ?3, ?4)", params![account_id, content, now, message_id])?;
    Ok(conn.last_insert_rowid())
}

pub fn list_drafts(conn: &Connection) -> Result<Vec<LocalDraft>> {
    let mut stmt = conn.prepare("SELECT id, account_id, content, updated_at FROM drafts ORDER BY updated_at DESC")?;
    let rows = stmt.query_map([], |r| Ok(LocalDraft { id: r.get(0)?, account_id: r.get(1)?, content: r.get(2)?, updated_at: r.get(3)? }))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// A draft's account, content (JSON) and server Message-ID.
pub fn draft(conn: &Connection, id: i64) -> Result<Option<(i64, String, Option<String>)>> {
    Ok(conn.query_row("SELECT account_id, content, message_id FROM drafts WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?)
}

/// Queue (or re-queue) the upload of a draft to the server's Drafts folder.
pub fn queue_draft_upload(conn: &Connection, account_id: i64, draft_id: i64, not_before: i64) -> Result<()> {
    conn.execute("DELETE FROM pending_ops WHERE kind = 'draft-upload' AND json_extract(payload, '$.draftId') = ?1", [draft_id])?;
    enqueue_op(conn, account_id, "draft-upload", &serde_json::json!({ "draftId": draft_id }), not_before)?;
    Ok(())
}

/// Delete a draft here and queue the removal of its copy on the server.
/// Returns the account to wake, if there is a server copy to remove.
pub fn delete_draft(conn: &Connection, id: i64) -> Result<Option<i64>> {
    let Some((account_id, _, message_id)) = draft(conn, id)? else { return Ok(None) };
    conn.execute("DELETE FROM drafts WHERE id = ?1", [id])?;
    conn.execute("DELETE FROM pending_ops WHERE kind = 'draft-upload' AND json_extract(payload, '$.draftId') = ?1", [id])?;
    let (Some(message_id), Some((folder_id, path))) = (message_id, folder_by_role(conn, account_id, "drafts")?) else { return Ok(None) };
    // The synced copy would otherwise reappear in Drafts until the server has removed it.
    conn.execute(
        "DELETE FROM messages WHERE account_id = ?1 AND message_id = ?2 AND id IN (SELECT message_id FROM message_folders WHERE folder_id = ?3)",
        params![account_id, message_id, folder_id],
    )?;
    enqueue_op(conn, account_id, "draft-delete", &serde_json::json!({ "dstPath": path, "messageIdHeader": message_id }), 0)?;
    Ok(Some(account_id))
}

// ---------- settings, rules, misc ----------

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    Ok(conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)).optional()?)
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params![key, value])?;
    Ok(())
}

pub fn folder_by_name(conn: &Connection, account_id: i64, name: &str) -> Result<Option<i64>> {
    Ok(conn
        .query_row(
            "SELECT id FROM folders WHERE account_id = ?1 AND (name = ?2 COLLATE NOCASE OR role = lower(?2)) ORDER BY id LIMIT 1",
            params![account_id, name],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn list_rules(conn: &Connection) -> Result<Vec<crate::rules::Rule>> {
    let mut stmt = conn.prepare("SELECT id, name, enabled, conditions, actions FROM rules ORDER BY position, id")?;
    let rows = stmt.query_map([], |r| {
        let conditions: serde_json::Value = serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default();
        let actions: serde_json::Value = serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or_default();
        let text = |v: &serde_json::Value, key: &str| v[key].as_str().unwrap_or_default().to_string();
        Ok(crate::rules::Rule {
            id: r.get(0)?,
            name: r.get(1)?,
            enabled: r.get(2)?,
            from_contains: text(&conditions, "from"),
            subject_contains: text(&conditions, "subject"),
            action: text(&actions, "action"),
            target: text(&actions, "target"),
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn save_rule(conn: &Connection, rule: &crate::rules::Rule) -> Result<i64> {
    let conditions = serde_json::json!({ "from": rule.from_contains, "subject": rule.subject_contains }).to_string();
    let actions = serde_json::json!({ "action": rule.action, "target": rule.target }).to_string();
    if rule.id == 0 {
        conn.execute("INSERT INTO rules (name, enabled, conditions, actions) VALUES (?1, ?2, ?3, ?4)", params![rule.name, rule.enabled, conditions, actions])?;
        Ok(conn.last_insert_rowid())
    } else {
        conn.execute("UPDATE rules SET name = ?2, enabled = ?3, conditions = ?4, actions = ?5 WHERE id = ?1", params![rule.id, rule.name, rule.enabled, conditions, actions])?;
        Ok(rule.id)
    }
}

pub fn delete_rule(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM rules WHERE id = ?1", [id])?;
    Ok(())
}

/// Every message from the same sender in the same folder as `id` (for Sweep).
pub fn same_sender_in_folder(conn: &Connection, id: i64) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT m.id FROM messages m JOIN message_folders mf ON mf.message_id = m.id
          WHERE mf.folder_id = (SELECT folder_id FROM message_folders WHERE message_id = ?1)
            AND m.from_address = (SELECT from_address FROM messages WHERE id = ?1)",
    )?;
    let rows = stmt.query_map([id], |r| r.get(0))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// Move a sender between Focused and Other: all their mail in this account.
pub fn set_sender_focus(conn: &Connection, id: i64, focused: bool) -> Result<String> {
    let (account_id, address): (i64, String) = conn.query_row("SELECT account_id, from_address FROM messages WHERE id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    conn.execute("UPDATE messages SET focused = ?3 WHERE account_id = ?1 AND from_address = ?2", params![account_id, address, focused])?;
    Ok(address)
}
