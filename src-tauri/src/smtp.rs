//! Building outgoing messages and handing them to an SMTP server.

use std::str::FromStr;

use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use crate::error::{Error, Result};
use crate::model::{Security, ServerSettings};

pub struct FilePart {
    pub name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

#[derive(Default)]
pub struct Outgoing {
    pub from_name: String,
    pub from_address: String,
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub html: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub files: Vec<FilePart>,
    /// Images shown inside the message; `name` is the content id the HTML refers to as `cid:<name>`.
    pub inline: Vec<FilePart>,
    /// Use this Message-ID (without angle brackets) instead of a new one.
    pub message_id: Option<String>,
    /// A draft may still lack recipients or have half-typed ones.
    pub draft: bool,
}

pub struct Built {
    /// The complete message as it goes on the wire and into the Sent folder.
    pub raw: Vec<u8>,
    pub mail_from: String,
    /// Every address the message is delivered to (To, Cc and Bcc).
    pub recipients: Vec<String>,
}

/// Split a field like "Ann <a@x.org>, b@y.org; c@z.org" into mailboxes.
pub fn parse_recipients(field: &str) -> Result<Vec<Mailbox>> {
    field
        .split([',', ';'])
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(|part| Mailbox::from_str(part).map_err(|_| Error(format!("\"{part}\" is not a valid email address."))))
        .collect()
}

/// A plain-text version of composer HTML, for mail clients that do not show HTML.
pub fn plain_from_html(html: &str) -> String {
    mail_parser::decoders::html::html_to_text(html).trim().to_string()
}

pub fn build(o: &Outgoing) -> Result<Built> {
    // In a draft, addresses that are not finished yet are simply left out.
    let recipients = |field: &str| -> Result<Vec<Mailbox>> {
        if o.draft {
            Ok(field.split([',', ';']).filter_map(|part| Mailbox::from_str(part.trim()).ok()).collect())
        } else {
            parse_recipients(field)
        }
    };
    let to = recipients(&o.to)?;
    let cc = recipients(&o.cc)?;
    let bcc = recipients(&o.bcc)?;
    if !o.draft && to.is_empty() && cc.is_empty() && bcc.is_empty() {
        return Err(Error("Add at least one recipient.".into()));
    }
    let from_address = Address::from_str(&o.from_address)?;
    let from_name = if o.from_name.is_empty() { None } else { Some(o.from_name.clone()) };
    let mut builder = Message::builder().from(Mailbox::new(from_name, from_address.clone())).subject(o.subject.as_str());
    if o.draft {
        // A draft is stored, never delivered, so it needs no real recipients.
        builder = builder.envelope(lettre::address::Envelope::new(Some(from_address.clone()), vec![from_address])?);
    }
    if let Some(id) = o.message_id.as_ref().filter(|s| !s.is_empty()) {
        builder = builder.message_id(Some(format!("<{}>", id.trim_matches(['<', '>']))));
    }
    for m in &to {
        builder = builder.to(m.clone());
    }
    for m in &cc {
        builder = builder.cc(m.clone());
    }
    for m in &bcc {
        builder = builder.bcc(m.clone());
    }
    if let Some(id) = o.in_reply_to.as_ref().filter(|s| !s.is_empty()) {
        builder = builder.in_reply_to(format!("<{}>", id.trim_matches(['<', '>'])));
    }
    if let Some(refs) = o.references.as_ref().filter(|s| !s.is_empty()) {
        let list: Vec<String> = refs.split_whitespace().map(|r| format!("<{}>", r.trim_matches(['<', '>']))).collect();
        builder = builder.references(list.join(" "));
    }
    let body = if o.inline.is_empty() {
        MultiPart::alternative_plain_html(plain_from_html(&o.html), o.html.clone())
    } else {
        let mut related = MultiPart::related().singlepart(SinglePart::html(o.html.clone()));
        for image in &o.inline {
            related = related.singlepart(Attachment::new_inline(image.name.clone()).body(image.data.clone(), ContentType::parse(&image.mime_type)?));
        }
        MultiPart::alternative().singlepart(SinglePart::plain(plain_from_html(&o.html))).multipart(related)
    };
    let message = if o.files.is_empty() {
        builder.multipart(body)?
    } else {
        let mut mixed = MultiPart::mixed().multipart(body);
        for f in &o.files {
            let kind = ContentType::parse(&f.mime_type).unwrap_or(ContentType::parse("application/octet-stream")?);
            mixed = mixed.singlepart(Attachment::new(f.name.clone()).body(f.data.clone(), kind));
        }
        builder.multipart(mixed)?
    };
    let recipients = to.iter().chain(&cc).chain(&bcc).map(|m| m.email.to_string()).collect();
    // lettre leaves the Bcc header out of the formatted message.
    Ok(Built { raw: message.formatted(), mail_from: o.from_address.clone(), recipients })
}

pub use crate::model::Secret;

fn transport(settings: &ServerSettings, secret: &Secret) -> Result<AsyncSmtpTransport<Tokio1Executor>> {
    let builder = match settings.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&settings.host)?,
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&settings.host)?,
        Security::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(settings.host.as_str()),
    };
    let builder = match secret {
        Secret::Password(p) => builder.credentials(Credentials::new(settings.username.clone(), p.clone())),
        Secret::OAuthToken(t) => builder
            .credentials(Credentials::new(settings.username.clone(), t.clone()))
            .authentication(vec![Mechanism::Xoauth2]),
    };
    Ok(builder.port(settings.port).timeout(Some(std::time::Duration::from_secs(60))).build())
}

/// Check that the outgoing server answers and accepts the sign-in.
pub async fn check(settings: &ServerSettings, secret: &Secret) -> Result<()> {
    match transport(settings, secret)?.test_connection().await {
        Ok(true) => Ok(()),
        Ok(false) => Err(Error(format!("The outgoing server {} did not respond.", settings.host))),
        Err(e) => Err(Error(format!("The outgoing server did not accept the sign-in: {e}"))),
    }
}

pub async fn send(settings: &ServerSettings, secret: &Secret, mail_from: &str, recipients: &[String], raw: &[u8]) -> Result<()> {
    let transport = transport(settings, secret)?;
    let to = recipients.iter().map(|r| Address::from_str(r)).collect::<std::result::Result<Vec<_>, _>>()?;
    let envelope = lettre::address::Envelope::new(Some(Address::from_str(mail_from)?), to)?;
    transport
        .send_raw(&envelope, raw)
        .await
        .map_err(|e| Error(format!("The outgoing server did not accept the message: {e}")))?;
    Ok(())
}

/// A reasonable content type from a file name.
pub fn mime_for(name: &str) -> &'static str {
    match name.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "txt" | "log" | "md" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "json" => "application/json",
        "zip" => "application/zip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "eml" => "message/rfc822",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse;

    fn draft() -> Outgoing {
        Outgoing {
            from_name: "Katy Reid".into(),
            from_address: "katy@work.test".into(),
            to: "Mona Kane <mona@contoso.example>; elvia@contoso.example".into(),
            cc: String::new(),
            bcc: "boss@contoso.example".into(),
            subject: "Re: Tilbud på tryk".into(),
            html: "<p>Hi <b>Mona</b>,</p><p>Looks good.</p>".into(),
            in_reply_to: Some("abc@openwren.test".into()),
            references: Some("root@openwren.test abc@openwren.test".into()),
            files: vec![FilePart { name: "notes.txt".into(), mime_type: "text/plain".into(), data: b"hello".to_vec() }],
            ..Default::default()
        }
    }

    #[test]
    fn builds_a_message_other_clients_can_read() {
        let built = build(&draft()).unwrap();
        assert_eq!(built.recipients, ["mona@contoso.example", "elvia@contoso.example", "boss@contoso.example"]);
        let text = String::from_utf8_lossy(&built.raw).to_string();
        assert!(!text.contains("boss@contoso.example"), "Bcc leaked into the headers");
        let header = parse::parse_header(&built.raw);
        assert_eq!(header.subject, "Re: Tilbud på tryk");
        assert_eq!(header.from_name, "Katy Reid");
        assert_eq!(header.to_list, "Mona Kane; elvia@contoso.example");
        assert_eq!(header.thread_key().as_deref(), Some("root@openwren.test"));
        let body = parse::parse_body(&built.raw);
        assert!(body.html.unwrap().contains("<b>Mona</b>"));
        assert!(body.plain.contains("Looks good."));
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.attachments[0].name, "notes.txt");
    }

    #[test]
    fn rejects_bad_or_missing_recipients() {
        let mut d = draft();
        d.to = "not an address".into();
        assert!(build(&d).err().unwrap().0.contains("not a valid email address"));
        d.to = String::new();
        d.bcc = String::new();
        assert!(build(&d).err().unwrap().0.contains("at least one recipient"));
    }

    #[test]
    fn a_signature_picture_travels_inside_the_message() {
        let mut d = draft();
        d.html = "<p>Hi</p><img src=\"cid:signature-image\" width=\"96\">".into();
        d.inline = vec![FilePart { name: "signature-image".into(), mime_type: "image/png".into(), data: vec![0x89, b'P', b'N', b'G'] }];
        let body = parse::parse_body(&build(&d).unwrap().raw);
        assert!(body.html.unwrap().contains("src=\"data:image/png;base64,iVBORw==\""));
        assert_eq!(body.attachments.iter().filter(|a| a.content_id.is_none()).count(), 1, "only notes.txt is a real attachment");
    }

    #[test]
    fn a_draft_needs_no_recipients_and_keeps_its_id() {
        let mut d = draft();
        d.draft = true;
        d.to = "half typ".into();
        d.bcc = String::new();
        d.message_id = Some("draft-1@work.test".into());
        let header = parse::parse_header(&build(&d).unwrap().raw);
        assert_eq!(header.message_id.as_deref(), Some("draft-1@work.test"));
        assert_eq!(header.to_list, "");
    }

    #[test]
    fn guesses_content_types() {
        assert_eq!(mime_for("Report.PDF"), "application/pdf");
        assert_eq!(mime_for("mystery"), "application/octet-stream");
    }
}
