//! Keeping the local database in step with an IMAP account.
//!
//! Two passes (PLAN.md 4.1): headers and flags for every message, newest first,
//! with no age limit; then bodies in the background.

use std::collections::HashMap;

use crate::db::{self, Db, NewMessage};
use crate::error::{Error, Result};
use crate::imap::{self, Session};
use crate::model::Progress;
use crate::parse;

/// How the sync engine reports to the outside (the UI in the app, nothing in tests).
pub trait Notifier: Send + Sync {
    fn progress(&self, progress: Progress);
    /// New unread mail arrived in the inbox after the first sync: (sender, subject) each.
    fn new_mail(&self, _account_id: i64, _mail: &[(String, String)]) {}
    /// Folders or messages of this account changed; lists should be re-read.
    fn changed(&self, account_id: i64);
}

pub struct Silent;
impl Notifier for Silent {
    fn progress(&self, _: Progress) {}
    fn changed(&self, _: i64) {}
}

const HEADER_QUERY: &str = "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER])";
const HEADER_CHUNK: usize = 200;
const BODY_CHUNK: usize = 20;
/// Bodies downloaded right after the inbox's headers, ahead of everything else.
const NEWEST_FIRST: u32 = 60;

fn report(notifier: &dyn Notifier, account_id: i64, phase: &str, done: u32, total: u32, message: &str) {
    notifier.progress(Progress { account_id, phase: phase.into(), done, total, message: message.into() });
}

/// Pass 1: folders, then every folder's headers and flags.
pub async fn sync_headers(db: &Db, session: &mut Session, account_id: i64, notifier: &dyn Notifier) -> Result<()> {
    report(notifier, account_id, "folders", 0, 0, "");
    let remote = imap::list_folders(session).await?;
    let folders: Vec<(i64, String, String)> = {
        let conn = db::lock(db);
        let mut out = Vec::new();
        for f in &remote {
            out.push((db::upsert_folder(&conn, account_id, &f.path, &f.name, f.role)?, f.path.clone(), f.name.clone()));
        }
        db::keep_only_folders(&conn, account_id, &out.iter().map(|f| f.0).collect::<Vec<_>>())?;
        out
    };
    notifier.changed(account_id);

    // Inbox first, so the most useful mail appears first.
    let mut ordered = folders;
    ordered.sort_by_key(|f| !f.1.eq_ignore_ascii_case("INBOX"));
    for (folder_id, path, name) in ordered {
        sync_folder(db, session, account_id, folder_id, &path, &name, notifier).await?;
        if path.eq_ignore_ascii_case("INBOX") {
            // The newest mail is what gets opened first: download its text now,
            // before the other folders, so it opens without a wait.
            sync_bodies(db, session, account_id, NEWEST_FIRST, 0, notifier).await?;
        }
    }
    Ok(())
}

async fn sync_folder(db: &Db, session: &mut Session, account_id: i64, folder_id: i64, path: &str, name: &str, notifier: &dyn Notifier) -> Result<()> {
    let mailbox = session.select(path).await?;
    let is_inbox = path.eq_ignore_ascii_case("INBOX");
    let blocked = if is_inbox { crate::blocked::list(&db::lock(db))? } else { Vec::new() };
    let mut to_junk: Vec<i64> = Vec::new();
    let (rules, overrides, focused_inbox) = {
        let conn = db::lock(db);
        let focused_inbox = db::get_setting(&conn, "focused_inbox")?.as_deref() != Some("off");
        let overrides: std::collections::HashMap<String, bool> =
            db::get_setting(&conn, "focus_overrides")?.and_then(|json| serde_json::from_str(&json).ok()).unwrap_or_default();
        (if is_inbox { db::list_rules(&conn)? } else { Vec::new() }, overrides, focused_inbox)
    };
    let mut arrived: Vec<(String, String)> = Vec::new();
    let mut to_rule: Vec<(i64, parse::Header)> = Vec::new();

    // A changed UIDVALIDITY means the server renumbered everything: start over.
    {
        let conn = db::lock(db);
        let known = db::folder_uid_validity(&conn, folder_id)?;
        if known.is_some() && known != mailbox.uid_validity {
            db::delete_folder_messages(&conn, folder_id)?;
        }
        db::set_folder_uid_validity(&conn, folder_id, mailbox.uid_validity)?;
    }

    let remote = if mailbox.exists == 0 { Default::default() } else { session.uid_search("ALL").await? };
    let local = db::local_uids(&db::lock(db), folder_id)?;

    // Messages queued to leave this folder are no longer shown here; do not bring them back.
    let leaving = db::pending_move_uids(&db::lock(db), account_id, path)?;

    let gone: Vec<u32> = local.difference(&remote).copied().collect();
    if !gone.is_empty() {
        db::delete_uids(&db::lock(db), folder_id, &gone)?;
        notifier.changed(account_id);
    }

    // Flags of messages we already have (read elsewhere, flagged elsewhere).
    if local.len() > gone.len() {
        let fetches = imap::fetch(session, "1:*", "(UID FLAGS)").await?;
        let mut changed = false;
        {
            let conn = db::lock(db);
            for f in &fetches {
                if let Some(uid) = f.uid.filter(|uid| local.contains(uid)) {
                    let (unread, flagged) = imap::flags_of(f);
                    changed |= db::update_flags(&conn, folder_id, uid, unread, flagged)?;
                }
            }
        }
        if changed {
            notifier.changed(account_id);
        }
    }

    // New headers, newest first, in chunks so the list fills while syncing.
    let mut new: Vec<u32> = remote.difference(&local).filter(|uid| !leaving.contains(uid)).copied().collect();
    new.sort_unstable_by(|a, b| b.cmp(a));
    let total = new.len() as u32;
    let mut done = 0;
    for chunk in new.chunks(HEADER_CHUNK) {
        let fetches = imap::fetch(session, &imap::uid_set(chunk), HEADER_QUERY).await?;
        {
            let mut conn = db::lock(db);
            let tx = conn.transaction()?;
            for f in &fetches {
                let Some(uid) = f.uid else { continue };
                let header = parse::parse_header(f.header().unwrap_or_default());
                // A message moved here by the user is already shown; just record its new UID.
                if let Some(id) = &header.message_id {
                    if db::adopt_placeholder(&tx, folder_id, id, uid)? {
                        continue;
                    }
                }
                let (unread, flagged) = imap::flags_of(f);
                let mut header = header;
                if let Some(focused) = overrides.get(&header.from_address.to_lowercase()) {
                    header.focused = *focused; // "always move to Focused / Other" for this sender
                }
                let id = db::insert_message(
                    &tx,
                    &NewMessage {
                        account_id,
                        folder_id,
                        uid: Some(uid),
                        header: &header,
                        fallback_date: f.internal_date().map(|d| d.timestamp()).unwrap_or(0),
                        size: f.size.unwrap_or(0),
                        unread,
                        flagged,
                    },
                )?;
                // Mail from a blocked sender goes to Junk: no notification, no rules.
                if is_inbox && !local.is_empty() && crate::blocked::is_blocked(&blocked, &header.from_address) {
                    to_junk.push(id);
                } else if is_inbox && unread && !local.is_empty() {
                    // With the Focused inbox off, every new message is announced.
                    if header.focused || !focused_inbox {
                        arrived.push((header.from_name.clone(), header.subject.clone()));
                    }
                    to_rule.push((id, header));
                }
            }
            tx.commit()?;
        }
        done += chunk.len() as u32;
        report(notifier, account_id, "headers", done, total, name);
        notifier.changed(account_id);
    }
    db::drop_stale_placeholders(&db::lock(db), account_id, folder_id)?;
    for id in &to_junk {
        // No undo window: nobody is watching. An account without a Junk folder keeps the message.
        let _ = crate::actions::move_to_role(db, *id, "junk", chrono::Utc::now().timestamp() - crate::actions::UNDO_WINDOW);
    }
    for (id, header) in &to_rule {
        crate::rules::apply(db, &rules, account_id, *id, header, chrono::Utc::now().timestamp())?;
    }
    if !arrived.is_empty() {
        notifier.new_mail(account_id, &arrived);
    }
    Ok(())
}

async fn move_on_server(session: &mut Session, src: &str, uid: u32, dst: &str) -> Result<()> {
    session.select(src).await?;
    if session.uid_mv(uid.to_string(), dst).await.is_ok() {
        return Ok(());
    }
    // Servers without MOVE: copy, mark the original deleted, expunge.
    session.uid_copy(uid.to_string(), dst).await?;
    remove_on_server(session, src, uid).await
}

pub async fn remove_on_server(session: &mut Session, folder: &str, uid: u32) -> Result<()> {
    use futures::TryStreamExt;
    store_flag(session, folder, uid, "\\Deleted", true).await?;
    if let Ok(stream) = session.uid_expunge(uid.to_string()).await {
        let _: Vec<_> = stream.try_collect().await?;
        return Ok(());
    }
    let _: Vec<_> = session.expunge().await?.try_collect().await?;
    Ok(())
}

/// Mark every unread message of a folder as read on the server.
async fn mark_all_read(session: &mut Session, folder: &str) -> Result<()> {
    use futures::TryStreamExt;
    session.select(folder).await?;
    let mut unread: Vec<u32> = session.uid_search("UNSEEN").await?.into_iter().collect();
    unread.sort_unstable();
    for chunk in unread.chunks(500) {
        let _: Vec<_> = session.uid_store(imap::uid_set(chunk), "+FLAGS.SILENT (\\Seen)").await?.try_collect().await?;
    }
    Ok(())
}

/// Replay queued operations (moves, permanent deletes, flag changes) on the server.
/// Returns how many were carried out.
pub async fn run_ops(db: &Db, session: &mut Session, account_id: i64) -> Result<u32> {
    let ops = db::due_ops(&db::lock(db), account_id, chrono::Utc::now().timestamp())?;
    let mut ran = 0;
    for op in ops {
        let text = |key: &str| op.payload[key].as_str().unwrap_or_default().to_string();
        let uid = op.payload["uid"].as_u64().unwrap_or(0) as u32;
        let result = match op.kind.as_str() {
            "move" => move_on_server(session, &text("srcPath"), uid, &text("dstPath")).await,
            "expunge" => remove_on_server(session, &text("srcPath"), uid).await,
            "flag" => store_flag(session, &text("srcPath"), uid, &text("flag"), op.payload["on"].as_bool().unwrap_or(false)).await,
            "mark-read" => mark_all_read(session, &text("srcPath")).await,
            "draft-upload" => crate::drafts::upload(db, session, op.payload["draftId"].as_i64().unwrap_or(0)).await,
            "draft-delete" => crate::drafts::remove_copies(session, &text("dstPath"), &text("messageIdHeader"), false).await,
            _ => Ok(()),
        };
        let conn = db::lock(db);
        match result {
            Ok(()) => {
                db::remove_op(&conn, op.id)?;
                ran += 1;
            }
            // After repeated failures give up, so one bad operation cannot block the rest forever.
            Err(_) if op.attempts >= 5 => {
                db::remove_op(&conn, op.id)?;
            }
            Err(e) => db::fail_op(&conn, op.id, &e.0)?,
        }
    }
    Ok(ran)
}

/// Download and store the bodies of the given (message id, uid) pairs in one folder.
pub async fn fetch_bodies(db: &Db, session: &mut Session, folder_path: &str, items: &[(i64, u32)]) -> Result<()> {
    session.select(folder_path).await?;
    let uids: Vec<u32> = items.iter().map(|i| i.1).collect();
    let fetches = imap::fetch(session, &imap::uid_set(&uids), "(UID BODY.PEEK[])").await?;
    let bodies: HashMap<u32, parse::Body> =
        fetches.iter().filter_map(|f| Some((f.uid?, parse::parse_body(f.body()?)))).collect();
    let mut conn = db::lock(db);
    for (id, uid) in items {
        // A message the server no longer returns still gets an empty body, so it is not retried forever.
        let empty = parse::Body::default();
        db::save_body(&mut conn, *id, bodies.get(uid).unwrap_or(&empty))?;
    }
    Ok(())
}

/// Read the sender checks and unsubscribe options of mail synced before those
/// were kept, newest first, in the background. Returns how many are still unread.
pub async fn sync_header_info(db: &Db, session: &mut Session, account_id: i64, limit: u32) -> Result<u32> {
    let missing = db::missing_header_info(&db::lock(db), account_id, limit)?;
    let mut by_folder: HashMap<&str, Vec<(i64, u32)>> = HashMap::new();
    for (id, path, uid) in &missing {
        by_folder.entry(path.as_str()).or_default().push((*id, *uid));
    }
    for (path, items) in by_folder {
        session.select(path).await?;
        for chunk in items.chunks(HEADER_CHUNK) {
            let uids: Vec<u32> = chunk.iter().map(|i| i.1).collect();
            let fetched = imap::fetch(session, &imap::uid_set(&uids), "(UID BODY.PEEK[HEADER])").await?;
            let found: HashMap<u32, (String, String)> = fetched.iter().filter_map(|f| Some((f.uid?, parse::header_info(f.header()?)))).collect();
            let conn = db::lock(db);
            for (id, uid) in chunk {
                // A message the server no longer returns is marked as read too, so it is not asked for again.
                let (auth, unsubscribe) = found.get(uid).cloned().unwrap_or_default();
                db::set_header_info(&conn, *id, &auth, &unsubscribe)?;
            }
        }
    }
    Ok(db::missing_header_info(&db::lock(db), account_id, 1)?.len() as u32)
}

/// Make sure one message's body is stored, fetching it if needed.
pub async fn ensure_body(db: &Db, session: &mut Session, message_id: i64) -> Result<()> {
    let location = {
        let conn = db::lock(db);
        if db::has_body(&conn, message_id)? {
            return Ok(());
        }
        db::location(&conn, message_id)?.ok_or(Error("This message is no longer on the server.".into()))?
    };
    fetch_bodies(db, session, &location.folder_path, &[(message_id, location.uid)]).await
}

/// Pass 2: download up to `limit` missing bodies, newest first.
/// Returns how many are still missing afterwards.
/// `not_older_than` (Unix seconds) limits how far back message text is kept; 0 = everything.
pub async fn sync_bodies(db: &Db, session: &mut Session, account_id: i64, limit: u32, not_older_than: i64, notifier: &dyn Notifier) -> Result<u32> {
    let missing = db::missing_bodies(&db::lock(db), account_id, limit, not_older_than)?;
    for chunk in missing.chunks(BODY_CHUNK) {
        let mut by_folder: HashMap<&str, Vec<(i64, u32)>> = HashMap::new();
        for (id, path, uid) in chunk {
            by_folder.entry(path.as_str()).or_default().push((*id, *uid));
        }
        for (path, items) in by_folder {
            fetch_bodies(db, session, path, &items).await?;
        }
        let (have, all) = db::body_counts(&db::lock(db), account_id)?;
        report(notifier, account_id, "bodies", have, all, "");
        notifier.changed(account_id);
    }
    Ok(db::missing_bodies(&db::lock(db), account_id, 1, not_older_than)?.len() as u32)
}

/// Tell the server about a flag change made here.
pub async fn store_flag(session: &mut Session, folder_path: &str, uid: u32, flag: &str, on: bool) -> Result<()> {
    use futures::TryStreamExt;
    session.select(folder_path).await?;
    let command = format!("{}FLAGS.SILENT ({flag})", if on { "+" } else { "-" });
    let _: Vec<_> = session.uid_store(uid.to_string(), command).await?.try_collect().await?;
    Ok(())
}
