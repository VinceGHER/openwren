//! End-to-end sync against the local Dovecot test server.
//!
//! Start the server with `sh tests/mail-server.sh` (from the repository root), then run
//! `OPENWREN_TEST_IMAP=127.0.0.1:3143 cargo test --test imap_sync -- --nocapture`.
//! Without that variable the test is skipped, so plain `cargo test` needs no server.

use std::sync::{Arc, Mutex};

use openwren_lib::db::{self, Db};
use openwren_lib::model::{AccountSettings, ImapSettings, SearchFilters, Security};
use openwren_lib::sync::{self, Silent};
use openwren_lib::{imap, store};

const USER: &str = "katy@work.test";

fn settings() -> Option<ImapSettings> {
    let target = std::env::var("OPENWREN_TEST_IMAP").ok()?;
    let (host, port) = target.split_once(':')?;
    Some(ImapSettings { host: host.into(), port: port.parse().ok()?, security: Security::None, username: USER.into() })
}

fn filters(date: &str) -> SearchFilters {
    SearchFilters { account_id: None, has_attachment: false, date: date.into(), after: None, before: None }
}

#[tokio::test]
async fn syncs_reads_and_searches_a_real_mailbox() {
    let Some(imap_settings) = settings() else {
        eprintln!("OPENWREN_TEST_IMAP not set; skipping");
        return;
    };
    let db: Db = Arc::new(Mutex::new(store::open_in_memory().unwrap()));
    let account = db::insert_account(&db::lock(&db), USER, "Katy Reid", "imap", &AccountSettings { imap: Some(imap_settings.clone()), ..Default::default() }).unwrap();

    // A wrong password is refused with a readable message.
    let refused = imap::connect(&imap_settings, "wrong").await.err().expect("wrong password accepted");
    assert!(refused.0.contains("sign-in"), "{}", refused.0);

    let mut session = imap::connect(&imap_settings, "pass").await.unwrap();

    // Pass 1: folders and every header, however old.
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    let folders = db::list_folders(&db::lock(&db)).unwrap();
    let roles: Vec<&str> = folders.iter().map(|f| f.role.as_str()).collect();
    assert_eq!(roles, ["inbox", "drafts", "sent", "trash", "junk", "archive"]);
    let inbox = &folders[0];
    assert_eq!(inbox.name, "Inbox");
    assert!(inbox.favorite);

    let all = db::list_messages(&db::lock(&db), inbox.id, None, 1000, 0, i64::MAX).unwrap();
    let seeded = all.len();
    assert!(seeded >= 307, "inbox has {seeded} messages");
    assert!(all.windows(2).all(|w| w[0].date >= w[1].date), "not newest first");
    let two_years = 2 * 365 * 24 * 3600;
    let oldest = all.last().unwrap();
    assert!(chrono::Utc::now().timestamp() - oldest.date > two_years, "oldest mail is not old");

    let newest = &all[0];
    assert_eq!(newest.subject, "September expense reports");
    assert_eq!(newest.from_name, "Laurence Gilbertson");
    assert!(newest.unread);
    assert!(all.iter().any(|m| m.from_name == "Søren Østergård" && m.subject == "Tilbud på tryk – økonomi"));

    // Focused / Other and paging.
    let focused = db::list_messages(&db::lock(&db), inbox.id, Some(true), 1000, 0, i64::MAX).unwrap();
    let other = db::list_messages(&db::lock(&db), inbox.id, Some(false), 1000, 0, i64::MAX).unwrap();
    assert_eq!(focused.len() + other.len(), seeded);
    assert!(other.iter().all(|m| m.from_name.starts_with("Newsletter") || m.from_name == "Trainline Deals"));
    let page2 = db::list_messages(&db::lock(&db), inbox.id, None, 50, 50, i64::MAX).unwrap();
    assert_eq!(page2[0].id, all[50].id);

    // Old mail is searchable by subject before any body is downloaded.
    let now = chrono::Utc::now();
    let by_subject = db::search(&db::lock(&db), "invoice 2023", &filters("older-2y"), now, 50).unwrap();
    assert_eq!(by_subject.len(), 1);
    assert_eq!(by_subject[0].subject, "Invoice 2023-1102");
    assert!(db::search(&db::lock(&db), "zebra-quartz", &filters("any"), now, 50).unwrap().is_empty());

    // Opening a message fetches its body on demand, sanitised.
    let mona = all.iter().find(|m| m.subject == "Event announcement content").unwrap();
    sync::ensure_body(&db, &mut session, mona.id).await.unwrap();
    let detail = db::message_detail(&db::lock(&db), mona.id).unwrap();
    let html = detail.html.expect("html part");
    assert!(html.contains("<b>draft</b>"), "{html}");
    assert!(!html.contains("<script") && !html.contains("alert("), "{html}");
    assert!(detail.plain.contains("draft of the announcement"));
    assert_eq!(detail.attachments.len(), 1);
    assert_eq!(detail.attachments[0].name, "announcement-draft.pdf");
    assert!(detail.summary.has_attachment);
    assert!(detail.summary.preview.starts_with("Hi team,"));

    // Pass 2: all bodies. Afterwards body text of old mail is searchable.
    let mut left = u32::MAX;
    while left > 0 {
        left = sync::sync_bodies(&db, &mut session, account, 200, 0, &Silent).await.unwrap();
    }
    let by_body = db::search(&db::lock(&db), "zebra-quartz", &filters("older-2y"), now, 50).unwrap();
    assert_eq!(by_body.len(), 1);
    assert_eq!(by_body[0].subject, "Invoice 2023-1102");
    assert!(by_body[0].has_attachment);
    // Date filters split results around one and two years.
    let invoices = |date: &str| db::search(&db::lock(&db), "invoice", &filters(date), now, 50).unwrap().len();
    assert_eq!(invoices("any"), 4);
    assert_eq!(invoices("past-year"), 1);
    assert_eq!(invoices("older-1y"), 3);
    assert_eq!(invoices("older-2y"), 1);
    // Prefix matching and the attachment filter.
    assert_eq!(db::search(&db::lock(&db), "invo", &filters("any"), now, 50).unwrap().len(), 4);
    let with_file = SearchFilters { has_attachment: true, ..filters("any") };
    assert_eq!(db::search(&db::lock(&db), "invoice", &with_file, now, 50).unwrap().len(), 2);

    // Syncing again changes nothing.
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    assert_eq!(db::list_messages(&db::lock(&db), inbox.id, None, 1000, 0, i64::MAX).unwrap().len(), seeded);

    // New mail and a flag change made elsewhere are picked up; a local flag change reaches the server.
    let mut other_client = imap::connect(&imap_settings, "pass").await.unwrap();
    other_client
        .append("INBOX", None, None, "From: Test Sender <t@example.com>\r\nSubject: Fresh arrival\r\n\r\nJust in.\r\n")
        .await
        .unwrap();
    let location = db::location(&db::lock(&db), newest.id).unwrap().unwrap();
    sync::store_flag(&mut other_client, &location.folder_path, location.uid, "\\Seen", true).await.unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    let after = db::list_messages(&db::lock(&db), inbox.id, None, 1000, 0, i64::MAX).unwrap();
    assert_eq!(after.len(), seeded + 1);
    let fresh = after.iter().find(|m| m.subject == "Fresh arrival").expect("new mail not synced");
    assert!(fresh.unread);
    assert!(!after.iter().find(|m| m.id == newest.id).unwrap().unread, "read state not synced");

    // A message deleted elsewhere disappears here, and from search.
    let fresh_location = db::location(&db::lock(&db), fresh.id).unwrap().unwrap();
    sync::store_flag(&mut other_client, "INBOX", fresh_location.uid, "\\Deleted", true).await.unwrap();
    {
        use futures::TryStreamExt;
        let _: Vec<_> = other_client.expunge().await.unwrap().try_collect().await.unwrap();
    }
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    assert_eq!(db::list_messages(&db::lock(&db), inbox.id, None, 1000, 0, i64::MAX).unwrap().len(), seeded);
    assert!(db::search(&db::lock(&db), "Fresh arrival", &filters("any"), now, 50).unwrap().is_empty());

    // ----- moving, undo, deleting -----
    use openwren_lib::actions;
    let count = |folder: i64| db::list_messages(&db::lock(&db), folder, None, 1000, 0, i64::MAX).unwrap().len();
    let archive = folders.iter().find(|f| f.role == "archive").unwrap().id;
    let trash = folders.iter().find(|f| f.role == "trash").unwrap().id;
    let archived_before = count(archive);
    let t0 = 1_000;

    // Archive, then undo before it reaches the server: nothing changed anywhere.
    let op = actions::move_to_role(&db, mona.id, "archive", t0).unwrap().expect("move queued");
    assert_eq!(count(inbox.id), seeded - 1);
    assert_eq!(count(archive), archived_before + 1);
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap(); // a sync during the undo window
    assert_eq!(count(inbox.id), seeded - 1, "sync brought a moved message back");
    assert_eq!(count(archive), archived_before + 1, "sync dropped the moved message");
    assert!(actions::undo(&db, op).unwrap());
    assert_eq!(count(inbox.id), seeded);
    assert_eq!(count(archive), archived_before);
    assert!(!actions::undo(&db, op).unwrap(), "undo worked twice");

    // Archive for real: after the queue runs and a sync, the server and the app agree,
    // the message keeps its body, and there is no duplicate.
    actions::move_to_role(&db, mona.id, "archive", t0).unwrap();
    {
        // not_before is in the past relative to the real clock, so the queue runs now
        assert_eq!(sync::run_ops(&db, &mut session, account).await.unwrap(), 1);
    }
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    assert_eq!(count(inbox.id), seeded - 1);
    assert_eq!(count(archive), archived_before + 1);
    let moved = db::message_detail(&db::lock(&db), mona.id).unwrap();
    assert_eq!(moved.summary.folder_id, archive);
    assert!(moved.html.is_some(), "body lost by the move");
    assert!(db::location(&db::lock(&db), mona.id).unwrap().is_some(), "moved message has no server UID");
    other_client.select("Archive").await.unwrap();
    assert_eq!(other_client.uid_search("SUBJECT \"Event announcement content\"").await.unwrap().len(), 1);

    // Delete goes to Deleted items; deleting there removes it for good, also on the server.
    actions::delete(&db, mona.id, t0).unwrap();
    sync::run_ops(&db, &mut session, account).await.unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    assert_eq!(db::message_detail(&db::lock(&db), mona.id).unwrap().summary.folder_id, trash);
    actions::delete(&db, mona.id, t0).unwrap();
    assert!(db::message_detail(&db::lock(&db), mona.id).is_err());
    sync::run_ops(&db, &mut session, account).await.unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    assert_eq!(count(trash), 0);
    other_client.select("Trash").await.unwrap();
    assert!(other_client.uid_search("ALL").await.unwrap().is_empty(), "message still on the server");

    // ----- search operators -----
    let ops_search = |q: &str| db::search(&db::lock(&db), q, &filters("any"), now, 400).unwrap();
    assert_eq!(ops_search("from:nordic").len(), 3); // two from Nordic Print, one from soren@nordicprint
    assert_eq!(ops_search("from:\"Nordic Print\" subject:2023").len(), 1);
    assert_eq!(ops_search("invoice in:archive").len(), 1);
    assert_eq!(ops_search("invoice has:attachment").len(), 2);
    assert_eq!(ops_search("is:unread from:trainline").len(), 1);
    let cutoff = (now - chrono::Duration::days(500)).format("%Y-%m-%d").to_string();
    assert_eq!(ops_search(&format!("invoice before:{cutoff}")).len(), 2);
    assert_eq!(ops_search(&format!("invoice after:{cutoff}")).len(), 2);
    assert!(ops_search("has:attachment").len() >= 2, "filters without text return nothing");

    // ----- conversations -----
    let root = all.iter().find(|m| m.subject == "Project tracker design doc").unwrap();
    let root_id = db::message_detail(&db::lock(&db), root.id).unwrap().message_id_header.unwrap();
    other_client
        .append("Sent", Some("(\\Seen)"), None, format!("From: Katy Reid <katy@work.test>\r\nTo: elvia@contoso.example\r\nSubject: Re: Project tracker design doc\r\nMessage-ID: <reply-1@openwren.test>\r\nIn-Reply-To: <{root_id}>\r\nReferences: <{root_id}>\r\n\r\nThanks Elvia.\r\n"))
        .await
        .unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    let thread = db::thread_messages(&db::lock(&db), root.id).unwrap();
    // The whole conversation, the open message included, oldest first; the same list from either end.
    assert_eq!(thread.iter().map(|m| m.subject.as_str()).collect::<Vec<_>>(), ["Project tracker design doc", "Re: Project tracker design doc"]);
    assert_eq!(thread[0].id, root.id);
    assert_eq!(thread[1].folder_name, "Sent");
    let from_reply = db::thread_messages(&db::lock(&db), thread[1].id).unwrap();
    assert_eq!(from_reply.iter().map(|m| m.id).collect::<Vec<_>>(), thread.iter().map(|m| m.id).collect::<Vec<_>>());

    // Put the mailbox back as the seed script left it.
    sync::store_flag(&mut other_client, &location.folder_path, location.uid, "\\Seen", false).await.unwrap();
}

/// The TLS path runs and rejects the test server's self-signed certificate
/// with an error instead of connecting or panicking.
#[tokio::test]
async fn tls_rejects_an_untrusted_certificate() {
    let Some(mut s) = settings() else { return };
    s.port = 3993;
    s.security = Security::Tls;
    let refused = imap::connect(&s, "pass").await.err().expect("self-signed certificate accepted");
    assert!(refused.0.to_lowercase().contains("certificate"), "{}", refused.0);
}
