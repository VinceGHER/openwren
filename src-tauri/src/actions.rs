//! Things the user does to messages. Each is applied to the local database at
//! once and, for IMAP accounts, queued to be replayed on the server.

use serde_json::json;

use crate::db::{self, Db};
use crate::error::{Error, Result};

/// Seconds a move waits before it is sent to the server, so it can be undone.
pub const UNDO_WINDOW: i64 = 6;

/// Move a message to another folder of its account. Returns the queued
/// operation's id when there is something to replay (and undo).
pub fn move_to_folder(db: &Db, id: i64, target_folder_id: i64, now: i64) -> Result<Option<i64>> {
    let conn = db::lock(db);
    let (account_id, folder_id, src_path, _, uid) = db::placement(&conn, id)?.ok_or(Error("This message no longer exists.".into()))?;
    if folder_id == target_folder_id {
        return Ok(None);
    }
    let (target_account, dst_path) = db::folder_path(&conn, target_folder_id)?;
    if target_account != account_id {
        return Err(Error("Messages can only be moved within their own account.".into()));
    }
    let Some(uid) = uid else {
        return Err(Error("This message is still being moved. Try again in a moment.".into()));
    };
    db::move_local(&conn, id, target_folder_id, None)?;
    let payload = json!({ "messageId": id, "srcFolderId": folder_id, "srcPath": src_path, "uid": uid, "dstPath": dst_path });
    Ok(Some(db::enqueue_op(&conn, account_id, "move", &payload, now + UNDO_WINDOW)?))
}

/// Move to the account's folder with the given role ("trash", "archive", "junk", "inbox").
pub fn move_to_role(db: &Db, id: i64, role: &str, now: i64) -> Result<Option<i64>> {
    let target = {
        let conn = db::lock(db);
        let (account_id, ..) = db::placement(&conn, id)?.ok_or(Error("This message no longer exists.".into()))?;
        db::folder_by_role(&conn, account_id, role)?.ok_or(Error(format!("This account has no {role} folder.")))?.0
    };
    move_to_folder(db, id, target, now)
}

/// Delete: to Deleted items, or for good when the message is already there.
pub fn delete(db: &Db, id: i64, now: i64) -> Result<Option<i64>> {
    let placement = db::placement(&db::lock(db), id)?.ok_or(Error("This message no longer exists.".into()))?;
    let (account_id, _, src_path, role, uid) = placement;
    if role != "trash" {
        return move_to_role(db, id, "trash", now);
    }
    let conn = db::lock(db);
    db::delete_message(&conn, id)?;
    if let Some(uid) = uid {
        db::enqueue_op(&conn, account_id, "expunge", &json!({ "srcPath": src_path, "uid": uid }), now)?;
    }
    Ok(None)
}

/// Take back a move that has not reached the server yet. False when it is too late.
pub fn undo(db: &Db, op_id: i64) -> Result<bool> {
    let conn = db::lock(db);
    let Some(op) = db::get_op(&conn, op_id)? else { return Ok(false) };
    if op.kind != "move" || !db::remove_op(&conn, op_id)? {
        return Ok(false);
    }
    let field = |key: &str| op.payload[key].as_i64().unwrap_or(0);
    db::move_local(&conn, field("messageId"), field("srcFolderId"), Some(field("uid") as u32))?;
    Ok(true)
}
