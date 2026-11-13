//! Rules: things done automatically to new mail in the inbox.

use serde::{Deserialize, Serialize};

use crate::db::{self, Db};
use crate::error::Result;
use crate::parse::Header;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// 0 for a rule that is not saved yet.
    #[serde(default)]
    pub id: i64,
    pub name: String,
    #[serde(default = "enabled")]
    pub enabled: bool,
    /// Matches when the sender's name or address contains this (ignoring case). Empty = any sender.
    #[serde(default)]
    pub from_contains: String,
    /// Matches when the subject contains this (ignoring case). Empty = any subject.
    #[serde(default)]
    pub subject_contains: String,
    /// "move", "category", "flag", "read" or "delete".
    pub action: String,
    /// Folder name for "move", category name for "category".
    #[serde(default)]
    pub target: String,
}

fn enabled() -> bool {
    true
}

impl Rule {
    pub fn matches(&self, header: &Header) -> bool {
        let has = |text: &str, needle: &str| needle.trim().is_empty() || text.to_lowercase().contains(&needle.trim().to_lowercase());
        // A rule with no conditions would hit every message; treat it as never matching.
        if self.from_contains.trim().is_empty() && self.subject_contains.trim().is_empty() {
            return false;
        }
        self.enabled && has(&format!("{} {}", header.from_name, header.from_address), &self.from_contains) && has(&header.subject, &self.subject_contains)
    }
}

/// Run the rules on one new inbox message. The first matching rule wins.
pub fn apply(db: &Db, rules: &[Rule], account_id: i64, message_id: i64, header: &Header, now: i64) -> Result<()> {
    let Some(rule) = rules.iter().find(|r| r.matches(header)) else { return Ok(()) };
    match rule.action.as_str() {
        "move" => {
            let target = db::folder_by_name(&db::lock(db), account_id, &rule.target)?;
            if let Some(folder_id) = target {
                // No undo window: nobody is watching a rule run.
                crate::actions::move_to_folder(db, message_id, folder_id, now - crate::actions::UNDO_WINDOW)?;
            }
        }
        "delete" => {
            crate::actions::move_to_role(db, message_id, "trash", now - crate::actions::UNDO_WINDOW)?;
        }
        "category" => db::set_categories(&db::lock(db), message_id, std::slice::from_ref(&rule.target))?,
        "flag" | "read" => {
            let conn = db::lock(db);
            let (flag, on, unread, flagged) = if rule.action == "flag" { ("\\Flagged", true, None, Some(true)) } else { ("\\Seen", true, Some(false), None) };
            db::set_local_flags(&conn, message_id, unread, flagged, None)?;
            if let Some(location) = db::location(&conn, message_id)? {
                let payload = serde_json::json!({ "srcPath": location.folder_path, "uid": location.uid, "flag": flag, "on": on });
                db::enqueue_op(&conn, account_id, "flag", &payload, 0)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(from: &str, subject: &str) -> Rule {
        Rule { id: 1, name: "r".into(), enabled: true, from_contains: from.into(), subject_contains: subject.into(), action: "flag".into(), target: String::new() }
    }

    fn header(from: &str, subject: &str) -> Header {
        Header { from_name: from.into(), from_address: "deals@news.trainline.example".into(), subject: subject.into(), ..Header::default() }
    }

    #[test]
    fn matches_sender_and_subject_ignoring_case() {
        let h = header("Trainline Deals", "Autumn fares");
        assert!(rule("TRAINLINE", "").matches(&h));
        assert!(rule("news.trainline", "fares").matches(&h));
        assert!(!rule("trainline", "invoice").matches(&h));
        assert!(!rule("", "").matches(&h), "a rule without conditions must not match everything");
        assert!(!Rule { enabled: false, ..rule("trainline", "") }.matches(&h));
    }
}
