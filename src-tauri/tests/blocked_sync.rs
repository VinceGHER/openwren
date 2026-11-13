//! Blocked senders against the local Dovecot test server:
//! `OPENWREN_TEST_IMAP=127.0.0.1:3143 cargo test --test blocked_sync`

use std::sync::{Arc, Mutex};

use openwren_lib::db::{self, Db};
use openwren_lib::model::{AccountSettings, ImapSettings, Security};
use openwren_lib::sync::{self, Silent};
use openwren_lib::{blocked, imap, store};

#[tokio::test]
async fn new_mail_from_a_blocked_sender_goes_to_junk() {
    let Ok(target) = std::env::var("OPENWREN_TEST_IMAP") else {
        eprintln!("OPENWREN_TEST_IMAP not set; skipping");
        return;
    };
    let (host, port) = target.split_once(':').unwrap();
    let user = format!("blocker-{}@work.test", std::process::id());
    let settings = ImapSettings { host: host.into(), port: port.parse().unwrap(), security: Security::None, username: user.clone() };
    let db: Db = Arc::new(Mutex::new(store::open_in_memory().unwrap()));
    let account = db::insert_account(&db::lock(&db), &user, "Blocker", "imap", &AccountSettings { imap: Some(settings.clone()), ..Default::default() }).unwrap();
    let mut session = imap::connect(&settings, "pass").await.unwrap();
    let mail = |from: &str, subject: &str| format!("From: {from}\r\nTo: {user}\r\nSubject: {subject}\r\nMessage-ID: <{subject}@openwren.test>\r\n\r\nHello\r\n");

    // One message so the inbox is not on its first sync (which never files or announces anything).
    session.append("INBOX", None, None, mail("Friend <friend@contoso.example>", "first")).await.unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    let folder = |role: &str| db::folder_by_role(&db::lock(&db), account, role).unwrap().unwrap().0;
    let subjects = |id: i64| -> Vec<String> { db::list_messages(&db::lock(&db), id, None, 50, 0, i64::MAX).unwrap().into_iter().map(|m| m.subject).collect() };

    blocked::save(&db::lock(&db), &[blocked::entry_for("deals@spam.example", true).unwrap()]).unwrap();
    session.append("INBOX", None, None, mail("Deals <deals@mail.spam.example>", "blocked")).await.unwrap();
    session.append("INBOX", None, None, mail("Friend <friend@contoso.example>", "welcome")).await.unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();

    // Here it is filed at once...
    assert_eq!(subjects(folder("junk")), ["blocked"]);
    let mut inbox = subjects(folder("inbox"));
    inbox.sort();
    assert_eq!(inbox, ["first", "welcome"]);

    // ...and on the server once the queued move has run.
    assert_eq!(sync::run_ops(&db, &mut session, account).await.unwrap(), 1);
    session.select("Junk").await.unwrap();
    assert_eq!(session.uid_search("SUBJECT blocked").await.unwrap().len(), 1);
    session.select("INBOX").await.unwrap();
    assert!(session.uid_search("SUBJECT blocked").await.unwrap().is_empty());

    // Blocking later finds what is already in the inbox.
    assert_eq!(blocked::inbox_messages(&db::lock(&db), "friend@contoso.example").unwrap().len(), 2);
    assert!(blocked::inbox_messages(&db::lock(&db), "@spam.example").unwrap().is_empty());
}
