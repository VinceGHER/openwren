//! Data shapes shared with the interface. Field names are camelCase in JSON.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// TLS from the first byte (usually port 993).
    Tls,
    /// Plain connection upgraded with STARTTLS (usually port 143).
    Starttls,
    /// No encryption. Only for local test servers; needs an explicit choice in the UI.
    None,
}

/// How to reach one server (IMAP or SMTP).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSettings {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
}
pub type ImapSettings = ServerSettings;

/// What is stored in `accounts.settings`: IMAP for incoming mail, SMTP for outgoing mail.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSettings {
    #[serde(default)]
    pub imap: Option<ServerSettings>,
    #[serde(default)]
    pub smtp: Option<ServerSettings>,
    /// Sign in with a Google OAuth token instead of a password.
    #[serde(default)]
    pub oauth: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewAccount {
    pub address: String,
    pub display_name: String,
    pub password: String,
    #[serde(default)]
    pub imap: Option<ServerSettings>,
    #[serde(default)]
    pub smtp: Option<ServerSettings>,
}

/// A message written in the composer, ready to queue for sending.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingDraft {
    pub account_id: i64,
    pub to: String,
    #[serde(default)]
    pub cc: String,
    #[serde(default)]
    pub bcc: String,
    pub subject: String,
    pub html: String,
    #[serde(default)]
    pub in_reply_to: Option<String>,
    #[serde(default)]
    pub references: Option<String>,
    /// Paths of files to attach.
    #[serde(default)]
    pub attachments: Vec<String>,
    /// Images shown inside the message (a signature picture), referred to as `cid:<cid>` in the HTML.
    #[serde(default)]
    pub inline_images: Vec<InlineImage>,
    /// Unix seconds; the message leaves the outbox at or after this time.
    pub send_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InlineImage {
    pub cid: String,
    /// `data:image/png;base64,...`
    pub data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxItem {
    pub id: i64,
    pub account_id: i64,
    pub to: String,
    pub subject: String,
    pub send_at: i64,
    pub attempts: i64,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    /// 0 for a signature that is not saved yet.
    #[serde(default)]
    pub id: i64,
    pub name: String,
    pub html: String,
    /// "text", "left" (image left of the text) or "above".
    #[serde(default)]
    pub layout: String,
    /// The signature's picture as a data URL, or empty.
    #[serde(default)]
    pub image: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureDefaults {
    pub account_id: i64,
    pub new_id: Option<i64>,
    pub reply_id: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Contact {
    pub name: String,
    pub address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: i64,
    pub address: String,
    pub display_name: String,
    pub kind: String,
    /// The mail server whose sender checks this account trusts; None until enough mail has been seen.
    pub auth_server: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: i64,
    pub account_id: i64,
    pub name: String,
    pub role: String,
    pub favorite: bool,
    pub unread: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSummary {
    pub id: i64,
    pub account_id: i64,
    pub folder_id: i64,
    pub folder_name: String,
    pub account_address: String,
    pub from_name: String,
    pub from_address: String,
    pub to: String,
    pub subject: String,
    pub preview: String,
    /// Unix seconds, UTC.
    pub date: i64,
    pub unread: bool,
    pub flagged: bool,
    pub pinned: bool,
    pub focused: bool,
    pub has_attachment: bool,
    /// Colour categories, by name.
    pub categories: Vec<String>,
    /// Unix seconds; hidden from its folder until then.
    pub snoozed_until: Option<i64>,
    /// The receiving server's sender checks, such as "spf=pass;dkim=pass;dmarc=fail". None when not read yet.
    pub auth: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub name: String,
    pub mime_type: String,
    pub size: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDetail {
    #[serde(flatten)]
    pub summary: MessageSummary,
    pub cc: String,
    /// Sanitised HTML, when the message has an HTML part.
    pub html: Option<String>,
    pub plain: String,
    pub attachments: Vec<Attachment>,
    /// The Message-ID and References headers, needed to reply in the same conversation.
    pub message_id_header: Option<String>,
    pub references: Option<String>,
    /// Recipients as "Name <address>" lists, for Reply all.
    pub to_addresses: String,
    pub cc_addresses: String,
    /// How this mailing can be unsubscribed from: "one-click", "mail" or "link".
    pub unsubscribe: Option<String>,
    /// Where the unsubscribe request goes: a mail address or a website name.
    pub unsubscribe_to: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    pub account_id: Option<i64>,
    #[serde(default)]
    pub has_attachment: bool,
    /// "any", "past-year", "older-1y", "older-2y" or "custom".
    #[serde(default)]
    pub date: String,
    /// Unix seconds, used when `date` is "custom".
    #[serde(default)]
    pub after: Option<i64>,
    #[serde(default)]
    pub before: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub account_id: i64,
    /// "folders", "headers", "bodies", "idle" or "error".
    pub phase: String,
    pub done: u32,
    pub total: u32,
    pub message: String,
}

/// How an account proves who it is: a password, or a Google OAuth access token.
pub enum Secret {
    Password(String),
    OAuthToken(String),
}

/// A message being written, kept on this computer until it is sent or discarded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDraft {
    pub id: i64,
    pub account_id: i64,
    /// The composer's state as JSON; only the interface reads it.
    pub content: String,
    pub updated_at: i64,
}

/// The composer's state inside a saved draft (`LocalDraft::content`).
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DraftContent {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub html: String,
    /// The quoted original of a reply or forward.
    pub quote: String,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
    pub attachments: Vec<String>,
}

/// What a List-Unsubscribe header offers.
#[derive(Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Unsubscribe {
    pub https: Option<String>,
    pub mailto: Option<String>,
    /// The sender accepts an unsubscribe request without a web page (RFC 8058).
    pub one_click: bool,
}

impl AccountSettings {
    /// True for a Gmail mailbox, whether it signs in with Google or with an app password.
    /// Gmail files a copy of every sent message itself, so none must be added.
    pub fn is_gmail(&self) -> bool {
        self.oauth || self.imap.as_ref().is_some_and(|imap| matches!(imap.host.trim().to_ascii_lowercase().as_str(), "imap.gmail.com" | "imap.googlemail.com"))
    }
}

impl Unsubscribe {
    /// The way to unsubscribe. `confirmed` says the mail server confirmed the sender;
    /// only then may a request be sent on the reader's behalf without a web page (RFC 8058).
    pub fn kind(&self, confirmed: bool) -> Option<&'static str> {
        match self {
            Unsubscribe { https: Some(_), one_click: true, .. } if confirmed => Some("one-click"),
            Unsubscribe { mailto: Some(_), .. } => Some("mail"),
            Unsubscribe { https: Some(_), .. } => Some("link"),
            _ => None,
        }
    }

    /// Where the request goes, for showing before it is sent.
    pub fn destination(&self, kind: &str) -> Option<String> {
        if kind == "mail" {
            let address = self.mailto.as_deref()?.get(7..)?; // after "mailto:"
            return Some(address.split('?').next().unwrap_or(address).to_string());
        }
        let rest = self.https.as_deref()?.get(8..)?; // after "https://"
        Some(rest.split(['/', '?', '#']).next().unwrap_or(rest).to_string())
    }
}
