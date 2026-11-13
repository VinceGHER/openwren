//! Sending through the local SMTP test sink, which delivers into Dovecot.
//! Needs `sh tests/mail-server.sh`; run with
//! `OPENWREN_TEST_IMAP=127.0.0.1:3143 OPENWREN_TEST_SMTP=127.0.0.1:3025 cargo test --test smtp_send`.

use openwren_lib::model::{Security, ServerSettings};
use openwren_lib::{imap, parse, smtp};

fn server(var: &str, user: &str) -> Option<ServerSettings> {
    let target = std::env::var(var).ok()?;
    let (host, port) = target.split_once(':')?;
    Some(ServerSettings { host: host.into(), port: port.parse().ok()?, security: Security::None, username: user.into() })
}

#[tokio::test]
async fn a_sent_message_arrives_with_its_attachment() {
    let (Some(smtp_settings), Some(imap_settings)) = (server("OPENWREN_TEST_SMTP", "katy@work.test"), server("OPENWREN_TEST_IMAP", "receiver@work.test")) else {
        eprintln!("OPENWREN_TEST_SMTP / OPENWREN_TEST_IMAP not set; skipping");
        return;
    };
    let secret = smtp::Secret::Password("pass".into());
    smtp::check(&smtp_settings, &secret).await.unwrap();

    let subject = format!("Send test {}", chrono::Utc::now().timestamp_millis());
    let built = smtp::build(&smtp::Outgoing {
        from_name: "Katy Reid".into(),
        from_address: "katy@work.test".into(),
        to: "Receiver <receiver@work.test>".into(),
        cc: String::new(),
        bcc: String::new(),
        subject: subject.clone(),
        html: "<p>Hello from <b>OpenWren</b>.</p><p>Kind regards,<br>Katy</p>".into(),
        in_reply_to: None,
        references: None,
        files: vec![smtp::FilePart { name: "notes.txt".into(), mime_type: "text/plain".into(), data: b"attached text".to_vec() }],
        ..Default::default()
    })
    .unwrap();
    smtp::send(&smtp_settings, &secret, &built.mail_from, &built.recipients, &built.raw).await.unwrap();

    // The receiver finds it in their inbox, readable and complete.
    let mut session = imap::connect(&imap_settings, "pass").await.unwrap();
    session.select("INBOX").await.unwrap();
    let uids = session.uid_search(format!("SUBJECT \"{subject}\"")).await.unwrap();
    assert_eq!(uids.len(), 1, "message not delivered");
    let uid = uids.into_iter().next().unwrap().to_string();
    let fetched = imap::fetch(&mut session, &uid, "(UID BODY.PEEK[])").await.unwrap();
    let raw = fetched[0].body().unwrap();
    let header = parse::parse_header(raw);
    assert_eq!(header.from_name, "Katy Reid");
    assert_eq!(header.subject, subject);
    let body = parse::parse_body(raw);
    assert!(body.html.unwrap().contains("<b>OpenWren</b>"));
    assert!(body.plain.contains("Kind regards"));
    assert_eq!(body.attachments.len(), 1);
    assert_eq!(body.attachments[0].name, "notes.txt");

    // A recipient the server refuses produces a readable error, not a silent success.
    let refused = smtp::send(&smtp_settings, &secret, "katy@work.test", &["reject@work.test".to_string()], &built.raw).await;
    assert!(refused.err().unwrap().0.contains("did not accept"));
}
