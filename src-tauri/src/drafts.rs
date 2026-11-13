//! Keeping drafts on the server too, so other devices see them.
//!
//! A draft is saved locally first (see `db::save_draft`). A few seconds after
//! the last change it is appended to the account's Drafts folder, and the copy
//! of the previous version is removed. All versions carry the same Message-ID,
//! which is how the copies are found.

use crate::db::{self, Db};
use crate::error::Result;
use crate::imap::Session;
use crate::model::DraftContent;
use crate::smtp;

/// The draft as a complete message, with the Drafts folder it belongs in.
/// None when the draft is gone or the account has no Drafts folder.
fn build(db: &Db, draft_id: i64) -> Result<Option<(String, String, Vec<u8>)>> {
    let (account_id, content, message_id, path, address, name) = {
        let conn = db::lock(db);
        let Some((account_id, content, Some(message_id))) = db::draft(&conn, draft_id)? else { return Ok(None) };
        let Some((_, path)) = db::folder_by_role(&conn, account_id, "drafts")? else { return Ok(None) };
        let (address, name, _) = db::account_identity(&conn, account_id)?;
        (account_id, content, message_id, path, address, name)
    };
    let _ = account_id;
    let draft: DraftContent = serde_json::from_str(&content)?;
    // Attachments that have been moved or deleted since are left out.
    let files = draft
        .attachments
        .iter()
        // Only files the user chose in the file dialog are ever read.
        .filter(|path| db::was_picked(&db::lock(db), path).unwrap_or(false))
        .filter_map(|path| {
            let name = std::path::Path::new(path).file_name()?.to_str()?.to_string();
            Some(smtp::FilePart { mime_type: smtp::mime_for(&name).to_string(), name, data: std::fs::read(path).ok()? })
        })
        .collect();
    let built = smtp::build(&smtp::Outgoing {
        from_name: name,
        from_address: address,
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        html: if draft.quote.is_empty() { draft.html } else { format!("{}<br>{}", draft.html, draft.quote) },
        in_reply_to: draft.in_reply_to,
        references: draft.references,
        files,
        message_id: Some(message_id.clone()),
        draft: true,
        ..Default::default()
    })?;
    Ok(Some((path, message_id, built.raw)))
}

/// Put the current version of a draft in the server's Drafts folder and remove older copies.
pub async fn upload(db: &Db, session: &mut Session, draft_id: i64) -> Result<()> {
    let Some((path, message_id, raw)) = build(db, draft_id)? else { return Ok(()) };
    session.append(&path, Some("(\\Draft \\Seen)"), None, &raw).await?;
    remove_copies(session, &path, &message_id, true).await
}

/// Remove the copies of a draft from the server; `keep_newest` leaves the one just uploaded.
pub async fn remove_copies(session: &mut Session, path: &str, message_id: &str, keep_newest: bool) -> Result<()> {
    session.select(path).await?;
    let id = message_id.replace(['"', '\\', '\r', '\n'], "");
    let mut uids: Vec<u32> = session.uid_search(format!("HEADER Message-ID \"{id}\"")).await?.into_iter().collect();
    uids.sort_unstable();
    if keep_newest {
        uids.pop();
    }
    for uid in uids {
        crate::sync::remove_on_server(session, path, uid).await?;
    }
    Ok(())
}
