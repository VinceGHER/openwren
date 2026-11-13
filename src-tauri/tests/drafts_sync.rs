//! Drafts are kept on the server too. Against the local Dovecot test server:
//! `OPENWREN_TEST_IMAP=127.0.0.1:3143 cargo test --test drafts_sync`

use std::sync::{Arc, Mutex};

use openwren_lib::db::{self, Db};
use openwren_lib::model::{AccountSettings, ImapSettings, Security};
use openwren_lib::sync::{self, Silent};
use openwren_lib::{imap, store};

#[tokio::test]
async fn a_draft_is_uploaded_replaced_and_removed() {
    let Ok(target) = std::env::var("OPENWREN_TEST_IMAP") else {
        eprintln!("OPENWREN_TEST_IMAP not set; skipping");
        return;
    };
    let (host, port) = target.split_once(':').unwrap();
    let user = format!("drafter-{}@work.test", std::process::id());
    let settings = ImapSettings { host: host.into(), port: port.parse().unwrap(), security: Security::None, username: user.clone() };
    let db: Db = Arc::new(Mutex::new(store::open_in_memory().unwrap()));
    let account = db::insert_account(&db::lock(&db), &user, "Drafter", "imap", &AccountSettings { imap: Some(settings.clone()), ..Default::default() }).unwrap();
    let mut session = imap::connect(&settings, "pass").await.unwrap();
    sync::sync_headers(&db, &mut session, account, &Silent).await.unwrap();
    let (drafts_folder, _) = db::folder_by_role(&db::lock(&db), account, "drafts").unwrap().expect("no Drafts folder");
    let on_server = |db: &Db| db::list_messages(&db::lock(db), drafts_folder, None, 50, 0, i64::MAX).unwrap();
    // A new draft with no recipient yet goes to the server's Drafts folder.
    let first = r#"{"to":"","subject":"Budget idea","html":"<p>First thoughts</p>"}"#;
    let id = db::save_draft(&db::lock(&db), None, account, first, "draft-test@work.test", 100).unwrap();
    db::queue_draft_upload(&db::lock(&db), account, id, 0).unwrap();
    assert_eq!(run(&db, &settings, account).await, 1);
    // The server copy is hidden in the list while the draft is also kept here...
    assert!(on_server(&db).is_empty());
    // ...but it is there: without the local draft it would show.
    let copies = |db: &Db| -> Vec<String> {
        let conn = db::lock(db);
        let mut stmt = conn.prepare("SELECT subject FROM messages WHERE message_id = 'draft-test@work.test'").unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        rows
    };
    assert_eq!(copies(&db), ["Budget idea"]);

    // Saving again replaces the copy instead of adding a second one.
    let second = r#"{"to":"Mona <mona@work.test>","subject":"Budget idea, v2","html":"<p>Better</p>"}"#;
    assert_eq!(db::save_draft(&db::lock(&db), Some(id), account, second, "ignored", 200).unwrap(), id);
    db::queue_draft_upload(&db::lock(&db), account, id, 0).unwrap();
    db::queue_draft_upload(&db::lock(&db), account, id, 0).unwrap(); // queued twice, uploaded once
    assert_eq!(run(&db, &settings, account).await, 1);
    assert_eq!(copies(&db), ["Budget idea, v2"]);

    // Sending or discarding removes it here and on the server.
    assert_eq!(db::delete_draft(&db::lock(&db), id).unwrap(), Some(account));
    assert!(db::list_drafts(&db::lock(&db)).unwrap().is_empty());
    assert_eq!(run(&db, &settings, account).await, 1);
    assert!(copies(&db).is_empty());
    assert!(on_server(&db).is_empty());
}

/// Carry out queued operations, then sync, as the background task does.
async fn run(db: &Db, settings: &ImapSettings, account: i64) -> u32 {
    let mut session = imap::connect(settings, "pass").await.unwrap();
    let ran = sync::run_ops(db, &mut session, account).await.unwrap();
    sync::sync_headers(db, &mut session, account, &Silent).await.unwrap();
    ran
}
