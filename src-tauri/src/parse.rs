//! Turning raw mail into the fields we store.

use mail_parser::{Address, HeaderValue, Message, MessageParser, MessagePart, MimeHeaders, PartType};

#[derive(Debug, Default)]
pub struct Header {
    pub from_name: String,
    pub from_address: String,
    pub to_list: String,
    pub cc_list: String,
    /// Recipients as "Name <address>" entries separated by commas, for replying.
    pub to_addresses: String,
    pub cc_addresses: String,
    pub subject: String,
    /// Unix seconds from the Date header, if it parsed.
    pub date: Option<i64>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub refs: Option<String>,
    /// False for newsletters and other bulk mail, which go to "Other".
    pub focused: bool,
    /// A guess from the header alone; corrected once the body is parsed.
    pub maybe_attachment: bool,
    /// Sender checks and unsubscribe options; see `header_info`.
    pub auth: String,
    pub unsubscribe: String,
}

/// Read two things from a message's headers:
/// - the receiving server's sender checks, as "id=mx.example.com;spf=pass;dkim=pass;dmarc=fail"
///   (the server that made them, then only the checks present);
/// - how to unsubscribe, as JSON (`model::Unsubscribe`), or empty when the message offers none.
pub fn header_info(raw: &[u8]) -> (String, String) {
    let Some(msg) = MessageParser::default().parse(raw) else { return Default::default() };
    let named = |name: &'static str| msg.headers_raw().filter(move |(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v);

    // The topmost Authentication-Results header is the one our own mail server added.
    let from = msg.from().and_then(|a| a.first()).and_then(|a| a.address()).unwrap_or_default();
    let auth = named("Authentication-Results").next().map(|results| auth_results(results, from)).unwrap_or_default();

    let mut unsubscribe = crate::model::Unsubscribe::default();
    if let Some(list) = named("List-Unsubscribe").next() {
        for target in list.split('<').skip(1).filter_map(|part| part.split('>').next()).map(|t| t.split_whitespace().collect::<String>()) {
            let lower = target.to_ascii_lowercase();
            if lower.starts_with("https://") && unsubscribe.https.is_none() {
                unsubscribe.https = Some(target);
            } else if lower.starts_with("mailto:") && unsubscribe.mailto.is_none() {
                unsubscribe.mailto = Some(target);
            }
        }
        unsubscribe.one_click = named("List-Unsubscribe-Post").any(|v| v.to_ascii_lowercase().contains("one-click"));
    }
    let unsubscribe = if unsubscribe.kind(true).is_some() { serde_json::to_string(&unsubscribe).unwrap_or_default() } else { String::new() };
    (auth, unsubscribe)
}

fn people(list: Option<&Address>) -> String {
    let Some(list) = list else { return String::new() };
    list.iter()
        .filter_map(|a| a.name().or(a.address()))
        .collect::<Vec<_>>()
        .join("; ")
}

fn mailboxes(list: Option<&Address>) -> String {
    let Some(list) = list else { return String::new() };
    list.iter()
        .filter_map(|a| {
            let address = a.address()?;
            Some(match a.name() {
                Some(name) if name != address => format!("{} <{address}>", name.replace([',', ';', '<', '>', '"'], " ")),
                _ => address.to_string(),
            })
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn ids(value: &HeaderValue) -> Option<String> {
    match value {
        HeaderValue::Text(t) => Some(t.to_string()),
        HeaderValue::TextList(l) => Some(l.join(" ")),
        _ => None,
    }
}

impl Header {
    /// Messages that share this key form one conversation: the first id in
    /// References, else In-Reply-To, else the message's own id.
    pub fn thread_key(&self) -> Option<String> {
        self.refs
            .as_deref()
            .and_then(|r| r.split_whitespace().next())
            .or(self.in_reply_to.as_deref().and_then(|r| r.split_whitespace().next()))
            .or(self.message_id.as_deref())
            .map(str::to_string)
    }
}

/// An Authentication-Results header with its comments removed and every quoted
/// string emptied. Both can hold text chosen by the sender (an envelope address
/// such as `"x;dmarc=pass"@evil.example`), which must never be read as a result.
fn without_comments_and_quotes(header: &str) -> String {
    let mut out = String::with_capacity(header.len());
    let (mut depth, mut quoted, mut escaped) = (0u32, false, false);
    for c in header.chars() {
        if escaped {
            escaped = false;
        } else if (quoted || depth > 0) && c == '\\' {
            escaped = true;
        } else if quoted {
            quoted = c != '"';
        } else if c == '(' {
            depth += 1;
        } else if c == ')' && depth > 0 {
            depth -= 1;
            out.push(' ');
        } else if depth == 0 {
            if c == '"' {
                quoted = true;
                out.push_str("\"\"");
            } else {
                out.push(c);
            }
        }
    }
    out
}

/// True when a DKIM signing domain speaks for the From address: the same domain,
/// or one is a subdomain of the other (DMARC's relaxed alignment).
fn aligned(signer: &str, from_domain: &str) -> bool {
    let (signer, from_domain) = (signer.trim_matches('.'), from_domain.trim_matches('.'));
    !signer.is_empty()
        && !from_domain.is_empty()
        && (signer == from_domain || from_domain.ends_with(&format!(".{signer}")) || signer.ends_with(&format!(".{from_domain}")))
}

/// The receiving server's checks from one Authentication-Results header (RFC 8601), as
/// "id=mx.example.com;spf=pass;dkim=pass;dmarc=fail". `from` is the address in From.
///
/// SPF and DMARC give one verdict each, so the first is taken. A message can carry
/// several DKIM signatures: "pass" is reported only when one that passed was made by
/// the From domain, and "unaligned" when the only good signatures are someone else's.
fn auth_results(header: &str, from: &str) -> String {
    let cleaned = without_comments_and_quotes(header).to_ascii_lowercase();
    let from_domain = from.rsplit('@').next().unwrap_or_default().to_ascii_lowercase();
    let mut parts = cleaned.split(';');
    let mut auth = Vec::new();
    // The header starts with the name of the server that did the checking.
    if let Some(server) = parts.next().and_then(|first| first.split_whitespace().next()).filter(|s| !s.contains('=')) {
        auth.push(format!("id={server}"));
    }
    let (mut spf, mut dmarc, mut dkim): (Option<&str>, Option<&str>, Option<&str>) = (None, None, None);
    let mut signed_by_sender = false;
    for part in parts {
        let mut words = part.split_whitespace();
        let Some((method, rest)) = words.next().and_then(|first| first.split_once('=')) else { continue };
        let verdict = rest.split(|c: char| !c.is_ascii_alphabetic()).next().unwrap_or_default();
        match method {
            "spf" => spf = spf.or(Some(verdict)),
            "dmarc" => dmarc = dmarc.or(Some(verdict)),
            "dkim" => {
                if verdict == "pass" {
                    // header.d names the signing domain; header.i is an address or "@domain" within it.
                    let signer = words.find_map(|w| w.strip_prefix("header.d=").or_else(|| w.strip_prefix("header.i=").map(|i| i.rsplit('@').next().unwrap_or_default())));
                    if signer.is_some_and(|signer| aligned(signer, &from_domain)) {
                        signed_by_sender = true;
                    }
                    if dkim != Some("pass") {
                        dkim = Some("pass");
                    }
                } else {
                    dkim = dkim.or(Some(verdict));
                }
            }
            _ => {}
        }
    }
    let dkim = match dkim {
        Some("pass") if !signed_by_sender => Some("unaligned"),
        other => other,
    };
    for (method, verdict) in [("spf", spf), ("dkim", dkim), ("dmarc", dmarc)] {
        if let Some(verdict) = verdict.filter(|v| !v.is_empty()) {
            auth.push(format!("{method}={verdict}"));
        }
    }
    auth.join(";")
}

/// True when the account's own mail server (`server`, see `db::auth_server`) confirmed
/// the sender: DMARC passed, or without a DMARC verdict the DKIM signature did.
/// Results that name another server may have been written by the sender and count for nothing.
pub fn sender_confirmed(auth: &str, server: Option<&str>) -> bool {
    let result = |key: &str| auth.split(';').find_map(|part| part.strip_prefix(key)?.strip_prefix('='));
    match (server, result("id")) {
        (Some(server), Some(id)) if id == server => {}
        _ => return false,
    }
    match result("dmarc") {
        Some(verdict) => verdict == "pass",
        None => result("dkim") == Some("pass"),
    }
}

pub fn parse_header(raw: &[u8]) -> Header {
    let Some(msg) = MessageParser::default().parse(raw) else {
        return Header { focused: true, ..Header::default() };
    };
    let (auth, unsubscribe) = header_info(raw);
    let from = msg.from().and_then(|a| a.first());
    let from_address = from.and_then(|a| a.address()).unwrap_or_default().to_string();
    let from_name = from.and_then(|a| a.name()).map(str::to_string).unwrap_or_else(|| from_address.clone());
    let precedence = msg
        .header("Precedence")
        .and_then(|v| v.as_text())
        .map(|p| p.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let bulk = !msg.list_unsubscribe().is_empty()
        || !msg.list_id().is_empty()
        || matches!(precedence.as_str(), "bulk" | "list" | "junk");
    Header {
        from_name,
        from_address,
        to_list: people(msg.to()),
        cc_list: people(msg.cc()),
        to_addresses: mailboxes(msg.to()),
        cc_addresses: mailboxes(msg.cc()),
        subject: msg.subject().unwrap_or_default().to_string(),
        date: msg.date().map(|d| d.to_timestamp()),
        message_id: msg.message_id().map(str::to_string),
        in_reply_to: ids(msg.in_reply_to()),
        refs: ids(msg.references()),
        focused: !bulk,
        maybe_attachment: msg.is_content_type("multipart", "mixed"),
        auth,
        unsubscribe,
    }
}

#[derive(Debug)]
pub struct AttachmentMeta {
    pub name: String,
    pub mime_type: String,
    pub size: i64,
}

#[derive(Debug, Default)]
pub struct Body {
    pub html: Option<String>,
    pub plain: String,
    pub preview: String,
    pub attachments: Vec<AttachmentMeta>,
}

/// Remove everything active from mail HTML. Scripts, forms, embeds and event
/// handlers are dropped; layout attributes that mail relies on are kept.
/// Remote content is blocked separately by the reading pane's policy.
///
/// Image maps (`<map>`, `<area href>`) are removed: their links would skip the link
/// checks, which look at `<a href>` only. Positioning is removed from inline styles, so
/// a message cannot lay text over the rest of the page, such as a fake "verified" mark.
pub fn sanitize_html(html: &str) -> String {
    ammonia::Builder::default()
        .add_generic_attributes(["style", "align", "valign", "width", "height", "bgcolor", "color", "border", "cellpadding", "cellspacing"])
        .rm_tags(["map", "area"])
        .add_url_schemes(["cid"])
        .link_rel(Some("noopener noreferrer"))
        .attribute_filter(|_, attribute, value| Some(if attribute == "style" { without_positioning(value).into() } else { value.into() }))
        .clean(html)
        .to_string()
}

/// An inline style without `position`. Comments are removed first, and declarations
/// whose name is not plain letters and dashes (CSS escapes such as `p\osition`) are dropped.
fn without_positioning(style: &str) -> String {
    let mut text = String::with_capacity(style.len());
    let mut rest = style;
    while let Some(start) = rest.find("/*") {
        text.push_str(&rest[..start]);
        rest = rest[start + 2..].find("*/").map_or("", |end| &rest[start + 2 + end + 2..]);
    }
    text.push_str(rest);
    text.split(';')
        .filter(|declaration| {
            let name = declaration.split(':').next().unwrap_or_default().trim().to_ascii_lowercase();
            name.is_empty() || (name.chars().all(|c| c.is_ascii_lowercase() || c == '-') && name != "position")
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn preview_of(text: &str) -> String {
    let mut out = String::new();
    for word in text.split_whitespace() {
        if out.chars().count() + word.chars().count() > 200 {
            break;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(word);
    }
    out
}

/// The HTML of the message as the reader sees it, when it has a real HTML part.
/// mail-parser offers text parts as HTML too; those do not count.
fn shown_html(msg: &Message) -> Option<String> {
    let real = msg.html_part(0).is_some_and(|p| matches!(p.body, PartType::Html(_)));
    if real { msg.body_html(0).map(|h| sanitize_html(&h)) } else { None }
}

/// For a picture the message text shows: how the text refers to it (`cid:...`) and
/// its kind ("png"). A Content-ID alone does not make a part such a picture, since
/// many mail programs give one to every file they attach; the text has to use it.
fn shown_picture(part: &MessagePart, html: Option<&str>) -> Option<(String, String)> {
    let cid = part.content_id()?.trim_matches(['<', '>']);
    let kind = part.content_type()?;
    let subtype = kind.c_subtype.as_deref()?.to_ascii_lowercase();
    let reference = format!("cid:{cid}");
    let picture = kind.c_type.eq_ignore_ascii_case("image") && ["png", "jpeg", "jpg", "gif", "webp"].contains(&subtype.as_str());
    (picture && !cid.is_empty() && html?.contains(&reference)).then_some((reference, subtype))
}

/// The files of a message that can be opened, saved and forwarded: every attached
/// part except the pictures its text shows. The list under a message, the paperclip
/// and the positions used to open a file all come from here, so they always agree.
fn files<'a>(msg: &'a Message<'a>, html: Option<&str>) -> Vec<&'a MessagePart<'a>> {
    msg.attachments().filter(|part| shown_picture(part, html).is_none()).collect()
}

pub fn parse_body(raw: &[u8]) -> Body {
    let Some(msg) = MessageParser::default().parse(raw) else {
        return Body::default();
    };
    let mut html = shown_html(&msg);
    let attachments = files(&msg, html.as_deref())
        .into_iter()
        .map(|part| AttachmentMeta {
            name: part.attachment_name().unwrap_or("attachment").to_string(),
            mime_type: part
                .content_type()
                .map(|c| match &c.c_subtype {
                    Some(sub) => format!("{}/{}", c.c_type, sub),
                    None => c.c_type.to_string(),
                })
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            size: part.len() as i64,
        })
        .collect();
    // Pictures that travel inside the message (logos, signature images) are put
    // into the HTML itself, so they show without any network request.
    if let Some(html) = html.as_mut() {
        use base64::Engine;
        let mut budget = 1_500_000usize;
        for part in msg.attachments() {
            let Some((reference, kind)) = shown_picture(part, Some(html)) else { continue };
            if part.len() > budget {
                continue;
            }
            budget -= part.len();
            let data = base64::engine::general_purpose::STANDARD.encode(part.contents());
            *html = html.replace(&reference, &format!("data:image/{kind};base64,{data}"));
        }
    }
    let plain = msg.body_text(0).map(|t| t.to_string()).unwrap_or_default();
    Body { preview: preview_of(&plain), html, plain, attachments }
}

/// The decoded bytes of the `index`-th file of a message, in the same order as
/// `MessageDetail::attachments`.
pub fn attachment_bytes(raw: &[u8], index: usize) -> Option<Vec<u8>> {
    let msg = MessageParser::default().parse(raw)?;
    let part = *files(&msg, shown_html(&msg).as_deref()).get(index)?;
    Some(part.contents().to_vec())
}

/// The `index`-th file of a message as (file name, content type, bytes), for sending it on.
pub fn attachment_part(raw: &[u8], index: usize) -> Option<(String, String, Vec<u8>)> {
    let msg = MessageParser::default().parse(raw)?;
    let part = *files(&msg, shown_html(&msg).as_deref()).get(index)?;
    let name = part.attachment_name().unwrap_or("attachment").to_string();
    let mime_type = match part.content_type() {
        Some(kind) => match kind.subtype() {
            Some(subtype) => format!("{}/{}", kind.ctype(), subtype),
            None => kind.ctype().to_string(),
        },
        None => "application/octet-stream".to_string(),
    };
    Some((name, mime_type, part.contents().to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A message as Gmail and Apple Mail send it: every attached file has a Content-ID,
    /// but the text only shows the logo.
    const WITH_CONTENT_IDS: &[u8] = b"From: a@b.example\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n\
--x\r\nContent-Type: text/html\r\n\r\n<p>See attached.</p><img src=\"cid:logo@b.example\">\r\n\
--x\r\nContent-Type: image/png; name=\"logo.png\"\r\nContent-Disposition: inline; filename=\"logo.png\"\r\nContent-ID: <logo@b.example>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw==\r\n\
--x\r\nContent-Type: image/jpeg; name=\"photo.jpg\"\r\nContent-Disposition: attachment; filename=\"photo.jpg\"\r\nContent-ID: <f_photo>\r\nContent-Transfer-Encoding: base64\r\n\r\n/9j/\r\n\
--x\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-ID: <f_report>\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n\
--x--\r\n";

    #[test]
    fn a_file_with_a_content_id_is_still_an_attachment() {
        let body = parse_body(WITH_CONTENT_IDS);
        // The logo is shown in the text and is not offered as a file; the photo and the PDF are.
        assert!(body.html.unwrap().contains("src=\"data:image/png;base64,iVBORw==\""));
        assert_eq!(body.attachments.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["photo.jpg", "report.pdf"]);
        // Opening, saving and forwarding count the files the same way the list does.
        assert_eq!(attachment_bytes(WITH_CONTENT_IDS, 0).unwrap(), [0xff, 0xd8, 0xff]);
        assert_eq!(attachment_bytes(WITH_CONTENT_IDS, 1).unwrap(), b"%PDF-1.4");
        assert_eq!(attachment_part(WITH_CONTENT_IDS, 1).unwrap().0, "report.pdf");
        assert!(attachment_bytes(WITH_CONTENT_IDS, 2).is_none());
    }

    #[test]
    fn a_message_with_only_a_shown_picture_has_no_attachment() {
        let raw = b"From: a@b.example\r\nSubject: Hi\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related; boundary=\"x\"\r\n\r\n\
--x\r\nContent-Type: text/html\r\n\r\n<p>Hi</p><img src=\"cid:logo\">\r\n\
--x\r\nContent-Type: image/png\r\nContent-ID: <logo>\r\nContent-Transfer-Encoding: base64\r\n\r\niVBORw==\r\n\
--x--\r\n";
        assert!(parse_body(raw).attachments.is_empty());
        assert!(attachment_bytes(raw, 0).is_none());
    }

    #[test]
    fn an_attachment_can_be_taken_out_to_forward_it() {
        let raw = b"From: a@b.example\r\nSubject: Report\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=\"x\"\r\n\r\n\
--x\r\nContent-Type: text/plain\r\n\r\nSee attached.\r\n\
--x\r\nContent-Type: application/pdf; name=\"report.pdf\"\r\nContent-Disposition: attachment; filename=\"report.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\nJVBERi0xLjQ=\r\n\
--x\r\nContent-Type: text/csv; name=\"data.csv\"\r\nContent-Disposition: attachment; filename=\"data.csv\"\r\n\r\na,b\r\n1,2\r\n\
--x--\r\n";
        assert_eq!(attachment_part(raw, 0), Some(("report.pdf".to_string(), "application/pdf".to_string(), b"%PDF-1.4".to_vec())));
        let (name, kind, data) = attachment_part(raw, 1).unwrap();
        assert_eq!((name.as_str(), kind.as_str()), ("data.csv", "text/csv"));
        assert!(data.starts_with(b"a,b"));
        assert!(attachment_part(raw, 2).is_none());

        // Sent on in a new message, both files arrive intact.
        let files = (0..2).map(|i| attachment_part(raw, i).unwrap()).map(|(name, mime_type, data)| crate::smtp::FilePart { name, mime_type, data }).collect();
        let built = crate::smtp::build(&crate::smtp::Outgoing {
            from_name: "Katy".into(),
            from_address: "katy@work.test".into(),
            to: "mona@contoso.example".into(),
            subject: "Fw: Report".into(),
            html: "<p>See below.</p>".into(),
            files,
            ..Default::default()
        })
        .unwrap();
        let sent = parse_body(&built.raw);
        assert_eq!(sent.attachments.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["report.pdf", "data.csv"]);
        assert_eq!(attachment_bytes(&built.raw, 0).unwrap(), b"%PDF-1.4");
    }

    #[test]
    fn decodes_encoded_names_and_subjects() {
        let h = parse_header(
            b"From: =?utf-8?b?U8O4cmVuIMOYc3RlcmfDpXJk?= <soren@example.com>\r\n\
              To: Katy Reid <katy@work.test>, bob@example.com\r\n\
              Subject: =?utf-8?q?Tilbud_p=C3=A5_tryk?=\r\n\
              Date: Sat, 14 Sep 2025 09:02:00 +0000\r\n\r\n",
        );
        assert_eq!(h.from_name, "Søren Østergård");
        assert_eq!(h.from_address, "soren@example.com");
        assert_eq!(h.to_list, "Katy Reid; bob@example.com");
        assert_eq!(h.to_addresses, "Katy Reid <katy@work.test>, bob@example.com");
        assert_eq!(h.subject, "Tilbud på tryk");
        assert_eq!(h.date, Some(1757840520));
        assert!(h.focused);
    }

    #[test]
    fn decodes_gbk_headers_and_body() {
        let raw = b"From: =?gbk?B?1tDOxNb3zOI=?= <system@example.com>\r\n\
              Subject: =?gbk?B?1tDOxNb3zOI=?=\r\n\
              MIME-Version: 1.0\r\n\
              Content-Type: text/plain; charset=gbk\r\n\
              Content-Transfer-Encoding: base64\r\n\r\n\
              xOO6w6OsysC95w==\r\n";
        let header = parse_header(raw);
        let body = parse_body(raw);
        assert_eq!(header.from_name, "中文主题");
        assert_eq!(header.subject, "中文主题");
        assert_eq!(body.plain, "你好，世界");
        assert_eq!(body.preview, "你好，世界");
    }

    #[test]
    fn reads_sender_checks_and_unsubscribe_options() {
        let raw = b"Authentication-Results: mx.example.com;\r\n dkim=fail header.i=@x.y; dkim=pass header.i=@shop.example;\r\n spf=softfail smtp.mailfrom=a@b.c; dmarc=FAIL (p=none) header.from=shop.example\r\n\
Authentication-Results: forged.example; dmarc=pass\r\n\
From: Shop <news@shop.example>\r\nList-Unsubscribe: <mailto:leave@shop.example?subject=unsubscribe>,\r\n <https://shop.example/u?id=1>\r\n\
List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nSubject: Deals\r\n\r\nHi";
        let h = parse_header(raw);
        assert_eq!(h.auth, "id=mx.example.com;spf=softfail;dkim=pass;dmarc=fail");
        assert!(sender_confirmed("id=mx.example.com;spf=fail;dkim=pass;dmarc=pass", Some("mx.example.com")));
        assert!(sender_confirmed("id=mx.example.com;dkim=pass", Some("mx.example.com")));
        assert!(!sender_confirmed(&h.auth, Some("mx.example.com")), "DMARC failed");
        assert!(!sender_confirmed("id=forged.example;dmarc=pass", Some("mx.example.com")), "not our server's word");
        assert!(!sender_confirmed("id=mx.example.com;dmarc=pass", None), "our server is not known yet");
        assert!(!sender_confirmed("", Some("mx.example.com")));
        // Checks the sender cannot talk their way through.
        let from = "ceo@bank.example";
        assert_eq!(auth_results(r#"mx.example.com; spf=pass smtp.mailfrom="x;dmarc=pass"@evil.example; dmarc=fail header.from=bank.example"#, from), "id=mx.example.com;spf=pass;dmarc=fail", "quoted text is not a result");
        assert_eq!(auth_results("mx.example.com; dmarc=fail (was; dmarc=pass) header.from=bank.example; dmarc=pass", from), "id=mx.example.com;dmarc=fail", "comments are skipped and the first verdict stands");
        assert_eq!(auth_results("mx.example.com; dkim=pass header.d=evil.example", from), "id=mx.example.com;dkim=unaligned", "someone else's signature");
        assert!(!sender_confirmed("id=mx.example.com;dkim=unaligned", Some("mx.example.com")));
        assert_eq!(auth_results("mx.example.com; dkim=fail header.d=x.example; dkim=pass header.i=@mail.bank.example", from), "id=mx.example.com;dkim=pass", "a subdomain of the sender signs for it");
        assert_eq!(auth_results("mx.example.com; dkim=pass header.d=notbank.example", from), "id=mx.example.com;dkim=unaligned");
        assert_eq!(auth_results("mx.example.com; dkim=pass", from), "id=mx.example.com;dkim=unaligned", "no signing domain given");
        let u: crate::model::Unsubscribe = serde_json::from_str(&h.unsubscribe).unwrap();
        assert_eq!(u.https.as_deref(), Some("https://shop.example/u?id=1"));
        assert_eq!(u.mailto.as_deref(), Some("mailto:leave@shop.example?subject=unsubscribe"));
        assert_eq!(u.kind(true), Some("one-click"));
        assert_eq!(u.kind(false), Some("mail"), "an unconfirmed sender gets no automatic web request");
        assert_eq!(u.destination("one-click").as_deref(), Some("shop.example"));
        assert_eq!(u.destination("mail").as_deref(), Some("leave@shop.example"));

        let plain = parse_header(b"From: a@b.c\r\nSubject: Hi\r\n\r\nHello");
        assert_eq!((plain.auth.as_str(), plain.unsubscribe.as_str()), ("", ""));
    }

    #[test]
    fn newsletters_are_not_focused() {
        let h = parse_header(b"From: a@b.c\r\nList-Unsubscribe: <mailto:x@y.z>\r\nSubject: Deals\r\n\r\n");
        assert!(!h.focused);
        assert_eq!(h.from_name, "a@b.c");
    }

    #[test]
    fn sanitizing_keeps_a_hand_written_signature() {
        let clean = sanitize_html(
            r#"<table cellpadding="0"><tr><td style="color:#555;padding-right:12px"><b>Katy</b></td><td><img src="https://contoso.example/logo.png" width="96"></td></tr></table><style>td{color:red}</style><script>x()</script>"#,
        );
        assert!(clean.contains(r#"<td style="color:#555;padding-right:12px">"#), "{clean}");
        assert!(clean.contains(r#"<img src="https://contoso.example/logo.png" width="96">"#), "{clean}");
        assert!(!clean.contains("color:red") && !clean.contains("x()"), "{clean}");
    }

    #[test]
    fn sanitizing_removes_scripts_and_handlers() {
        let clean = sanitize_html(
            "<p onclick=\"evil()\">Hi <b>there</b></p><script>alert(1)</script>\
             <iframe src=\"https://x\"></iframe><a href=\"javascript:alert(1)\">x</a>\
             <a href=\"https://example.com\">ok</a>",
        );
        assert!(clean.contains("<b>there</b>"));
        assert!(clean.contains("https://example.com"));
        for bad in ["script", "onclick", "iframe", "javascript:"] {
            assert!(!clean.contains(bad), "{bad} survived: {clean}");
        }
    }

    #[test]
    fn mail_cannot_place_text_over_the_page_or_hide_links_in_image_maps() {
        let clean = sanitize_html(
            "<div style=\"color:red; position: fixed; top:0\">Verified sender</div>\
             <div style=\"POSITION:absolute\">a</div><div style=\"posi/**/tion:fixed\">b</div>\
             <div style=\"p\\osition:fixed;color:blue\">c</div>\
             <img src=\"cid:x\" usemap=\"#m\"><map name=\"m\"><area href=\"https://evil.example\" shape=\"rect\"></map>",
        );
        assert!(!clean.to_ascii_lowercase().contains("position"), "{clean}");
        assert!(!clean.contains("osition"), "{clean}");
        assert!(clean.contains("color:red") && clean.contains("color:blue"), "{clean}");
        assert!(!clean.contains("<area") && !clean.contains("evil.example"), "{clean}");
    }

    #[test]
    fn plain_only_mail_has_no_html() {
        let b = parse_body(b"From: a@b.c\r\nSubject: x\r\n\r\nHello   there\r\nfriend\r\n");
        assert!(b.html.is_none());
        assert_eq!(b.preview, "Hello there friend");
        assert!(b.attachments.is_empty());
    }
}
