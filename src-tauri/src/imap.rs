//! Talking to an IMAP server: connecting, listing folders, fetching.

use std::fmt::Debug;
use std::sync::Arc;
use std::time::Duration;

use async_imap::types::{Fetch, Flag, NameAttribute};
use futures::TryStreamExt;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio_rustls::rustls::{ClientConfig, RootCertStore};
use tokio_rustls::TlsConnector;

use crate::error::{Error, Result};
use crate::model::{ImapSettings, Secret, Security};

/// Either a plain or a TLS connection, behind one type.
pub trait IoStream: AsyncRead + AsyncWrite + Unpin + Send + Debug {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + Debug> IoStream for T {}

pub type Session = async_imap::Session<Box<dyn IoStream>>;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) async fn tls(host: &str, tcp: TcpStream) -> Result<Box<dyn IoStream>> {
    let roots = RootCertStore::from_iter(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    let config = ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
    let name = rustls_pki_types::ServerName::try_from(host.to_string())?;
    Ok(Box::new(TlsConnector::from(Arc::new(config)).connect(name, tcp).await?))
}

struct XOAuth2(String);

impl async_imap::Authenticator for XOAuth2 {
    type Response = String;
    fn process(&mut self, _challenge: &[u8]) -> String {
        self.0.clone()
    }
}

async fn open(settings: &ImapSettings, secret: &Secret) -> Result<Session> {
    let tcp = TcpStream::connect((settings.host.as_str(), settings.port)).await?;
    let client = match settings.security {
        Security::Tls => {
            let mut client = async_imap::Client::new(tls(&settings.host, tcp).await?);
            client.read_response().await?.ok_or(Error("The server closed the connection.".into()))?;
            client
        }
        Security::Starttls => {
            let mut plain = async_imap::Client::new(tcp);
            plain.read_response().await?.ok_or(Error("The server closed the connection.".into()))?;
            plain.run_command_and_check_ok("STARTTLS", None).await?;
            async_imap::Client::new(tls(&settings.host, plain.into_inner()).await?)
        }
        Security::None => {
            let mut client = async_imap::Client::new(Box::new(tcp) as Box<dyn IoStream>);
            client.read_response().await?.ok_or(Error("The server closed the connection.".into()))?;
            client
        }
    };
    match secret {
        Secret::Password(password) => client
            .login(&settings.username, password)
            .await
            .map_err(|(e, _)| Error(format!("The server did not accept the sign-in: {e}"))),
        Secret::OAuthToken(token) => client
            .authenticate("XOAUTH2", XOAuth2(crate::oauth::xoauth2(&settings.username, token)))
            .await
            .map_err(|(e, _)| Error(format!("The server did not accept the Google sign-in: {e}"))),
    }
}

/// Connect and sign in with a password.
pub async fn connect(settings: &ImapSettings, password: &str) -> Result<Session> {
    connect_with(settings, &Secret::Password(password.to_string())).await
}

pub async fn connect_with(settings: &ImapSettings, secret: &Secret) -> Result<Session> {
    match tokio::time::timeout(CONNECT_TIMEOUT, open(settings, secret)).await {
        Ok(result) => result,
        Err(_) => Err(Error(format!("Connecting to {} timed out.", settings.host))),
    }
}

#[derive(Debug, PartialEq)]
pub struct RemoteFolder {
    pub path: String,
    pub name: String,
    pub role: &'static str,
}

fn role_from_name(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "inbox" => "inbox",
        "drafts" | "draft" => "drafts",
        "sent" | "sent items" | "sent mail" | "sent messages" => "sent",
        "trash" | "deleted items" | "deleted messages" | "bin" => "trash",
        "junk" | "spam" | "junk email" | "junk e-mail" | "bulk mail" => "junk",
        "archive" | "archives" => "archive",
        _ => "custom",
    }
}

/// Folder names travel in IMAP's "modified UTF-7": "Messages envoy&AOk-s" is "Messages envoyés".
/// The encoded form stays the folder's path; this is only for showing it.
pub fn decode_folder_name(encoded: &str) -> String {
    use base64::Engine;
    let mut out = String::new();
    let mut rest = encoded;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('-') else {
            out.push_str(&rest[start..]); // not valid encoding: show it as it is
            return out;
        };
        let code = &after[..end];
        if code.is_empty() {
            out.push('&');
        } else {
            let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(code.replace(',', "/")).unwrap_or_default();
            let units: Vec<u16> = bytes.chunks_exact(2).map(|pair| u16::from_be_bytes([pair[0], pair[1]])).collect();
            match String::from_utf16(&units) {
                Ok(text) if !text.is_empty() => out.push_str(&text),
                _ => out.push_str(&rest[start..start + end + 2]),
            }
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

/// All selectable folders, with the role each plays.
pub async fn list_folders(session: &mut Session) -> Result<Vec<RemoteFolder>> {
    let names: Vec<_> = session.list(Some(""), Some("*")).await?.try_collect().await?;
    let mut out = Vec::new();
    for n in &names {
        let attrs = n.attributes();
        // Skip folders that cannot hold mail, and virtual views of mail that lives
        // elsewhere (Gmail's "All Mail" and "Starred"), which would show everything twice.
        if attrs.iter().any(|a| matches!(a, NameAttribute::NoSelect | NameAttribute::All | NameAttribute::Flagged)) {
            continue;
        }
        if n.name().ends_with("/Important") && n.name().starts_with("[G") {
            continue;
        }
        let path = n.name().to_string();
        let leaf = match n.delimiter() {
            Some(d) if !d.is_empty() => path.rsplit(d).next().unwrap_or(&path),
            _ => path.as_str(),
        };
        let by_attribute = attrs.iter().find_map(|a| match a {
            NameAttribute::Sent => Some("sent"),
            NameAttribute::Drafts => Some("drafts"),
            NameAttribute::Trash => Some("trash"),
            NameAttribute::Junk => Some("junk"),
            NameAttribute::Archive => Some("archive"),
            _ => None,
        });
        let role = if path.eq_ignore_ascii_case("INBOX") { "inbox" } else { by_attribute.unwrap_or("") };
        let name = if role == "inbox" { "Inbox".to_string() } else { decode_folder_name(leaf) };
        out.push(RemoteFolder { path, name, role });
    }
    // Folders the server did not mark get a role from their name, but only a role no
    // other folder has: next to Gmail's "Brouillons", a label called "Drafts" is just a label.
    for i in 0..out.len() {
        if out[i].role.is_empty() {
            let guess = role_from_name(&out[i].name);
            out[i].role = if guess != "custom" && out.iter().any(|f| f.role == guess) { "custom" } else { guess };
        }
    }
    Ok(out)
}

/// (unread, flagged) from a fetch result.
pub fn flags_of(fetch: &Fetch) -> (bool, bool) {
    let mut seen = false;
    let mut flagged = false;
    for flag in fetch.flags() {
        match flag {
            Flag::Seen => seen = true,
            Flag::Flagged => flagged = true,
            _ => {}
        }
    }
    (!seen, flagged)
}

/// Comma-separated UID set for a command.
pub fn uid_set(uids: &[u32]) -> String {
    uids.iter().map(u32::to_string).collect::<Vec<_>>().join(",")
}

pub async fn fetch(session: &mut Session, uids: &str, query: &str) -> Result<Vec<Fetch>> {
    Ok(session.uid_fetch(uids, query).await?.try_collect().await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guesses_roles_from_common_names() {
        assert_eq!(role_from_name("Sent Items"), "sent");
        assert_eq!(role_from_name("Spam"), "junk");
        assert_eq!(role_from_name("Deleted Messages"), "trash");
        assert_eq!(role_from_name("Invoices"), "custom");
    }

    #[test]
    fn decodes_folder_names() {
        assert_eq!(decode_folder_name("Messages envoy&AOk-s"), "Messages envoyés");
        assert_eq!(decode_folder_name("Entw&APw-rfe"), "Entwürfe");
        assert_eq!(decode_folder_name("R&AOk-ception &- Co"), "Réception & Co");
        assert_eq!(decode_folder_name("&ZeVnLIqe-"), "日本語");
        assert_eq!(decode_folder_name("Plain"), "Plain");
        assert_eq!(decode_folder_name("A & B"), "A & B");
    }

    #[test]
    fn formats_uid_sets() {
        assert_eq!(uid_set(&[3, 1, 20]), "3,1,20");
    }
}
