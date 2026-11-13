//! Blocked senders: their new mail goes straight to Junk, without a notification.
//!
//! IMAP has no block list of its own, so the list is kept here (in the
//! "blocked_senders" setting) and applied whenever new inbox mail is synced.
//! An entry is a full address ("ann@shop.example") or a whole domain ("@shop.example").

use rusqlite::Connection;

use crate::db;
use crate::error::Result;

pub fn list(conn: &Connection) -> Result<Vec<String>> {
    Ok(db::get_setting(conn, "blocked_senders")?.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default())
}

pub fn save(conn: &Connection, entries: &[String]) -> Result<()> {
    db::set_setting(conn, "blocked_senders", &serde_json::to_string(entries)?)
}

/// The entry for a sender: their address, or "@domain" to block everyone there.
pub fn entry_for(address: &str, whole_domain: bool) -> Option<String> {
    let address = address.trim().to_lowercase();
    let (_, domain) = address.split_once('@')?;
    if domain.is_empty() {
        return None;
    }
    Some(if whole_domain { format!("@{domain}") } else { address })
}

/// True when `address` is covered by one of the entries. A domain entry also covers its subdomains.
pub fn is_blocked(entries: &[String], address: &str) -> bool {
    let address = address.trim().to_lowercase();
    let domain = address.split_once('@').map(|(_, d)| d).unwrap_or_default();
    entries.iter().any(|entry| match entry.strip_prefix('@') {
        Some(blocked) => !domain.is_empty() && (domain == blocked || domain.ends_with(&format!(".{blocked}"))),
        None => *entry == address,
    })
}

/// Inbox messages, in every account, from senders covered by `entry`.
pub fn inbox_messages(conn: &Connection, entry: &str) -> Result<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT m.id, m.from_address FROM messages m JOIN message_folders mf ON mf.message_id = m.id JOIN folders f ON f.id = mf.folder_id
          WHERE f.role = 'inbox' AND lower(m.from_address) LIKE ?1",
    )?;
    // The LIKE narrows the search; `is_blocked` makes the exact decision.
    let like = format!("%{}", entry.replace(['%', '_'], ""));
    let rows: Vec<(i64, String)> = stmt.query_map([like], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let entries = [entry.to_string()];
    Ok(rows.into_iter().filter(|(_, from)| is_blocked(&entries, from)).map(|(id, _)| id).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_an_address_or_a_whole_domain() {
        let entries = vec![entry_for("Deals@Shop.Example", false).unwrap(), entry_for("x@spam.example", true).unwrap()];
        assert_eq!(entries, ["deals@shop.example", "@spam.example"]);
        assert!(is_blocked(&entries, "deals@shop.example"));
        assert!(is_blocked(&entries, "DEALS@shop.example "));
        assert!(!is_blocked(&entries, "orders@shop.example"));
        assert!(is_blocked(&entries, "anyone@spam.example"));
        assert!(is_blocked(&entries, "anyone@mail.spam.example"));
        assert!(!is_blocked(&entries, "anyone@notspam.example"));
        assert!(!is_blocked(&entries, "no-address"));
        assert_eq!(entry_for("no-address", false), None);
    }
}
