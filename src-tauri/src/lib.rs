pub mod actions;
pub mod autostart;
pub mod blocked;
pub mod db;
pub mod drafts;
pub mod error;
pub mod imap;
pub mod model;
pub mod oauth;
pub mod parse;
pub mod rules;
pub mod sample_data;
pub mod search;
pub mod smtp;
pub mod stats;
pub mod store;
pub mod sync;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Notify;

use db::Db;
use error::{Error, Result};
use imap::Session;
use model::*;
use tauri_plugin_notification::NotificationExt;

const KEYRING_SERVICE: &str = "OpenWren";

static STARTED: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

/// Note the moment the program started, for the start-up timing below. Called first thing in `main`.
pub fn mark_start() {
    let _ = STARTED.set(std::time::Instant::now());
}

/// The interface calls this once, right after it has drawn the first message list.
/// With `OPENWREN_TIMING` set it prints how long start-up took; `OPENWREN_TIMING=exit`
/// also quits, so a script can measure many starts in a row. Otherwise it does nothing.
#[tauri::command]
fn mark_ready(app: AppHandle) {
    static DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let Some(mode) = std::env::var_os("OPENWREN_TIMING") else { return };
    if DONE.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if let Some(started) = STARTED.get() {
        eprintln!("openwren-ready-ms {}", started.elapsed().as_millis());
    }
    if mode == "exit" {
        app.exit(0);
    }
}

// The app was called OpenLook at first. What it stored under that name is adopted on first start.
const OLD_KEYRING_SERVICE: &str = "OpenLook";
const OLD_DATA_DIR: &str = "org.openlook.app";
const OLD_DATABASE: &str = "openlook.db";
const DATABASE: &str = "openwren.db";

/// Move the data folder of the app's earlier name into place, database included.
fn adopt_old_data(dir: &std::path::Path) {
    let Some(old) = dir.parent().map(|parent| parent.join(OLD_DATA_DIR)) else { return };
    if dir.join(DATABASE).exists() || !old.join(OLD_DATABASE).exists() {
        return;
    }
    // The new folder may already exist, empty or with nothing but web view files.
    let _ = std::fs::remove_dir_all(dir);
    if std::fs::rename(&old, dir).is_err() {
        return;
    }
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::rename(dir.join(format!("{OLD_DATABASE}{suffix}")), dir.join(format!("{DATABASE}{suffix}")));
    }
}

/// Move one keyring entry from the app's earlier name to the current one.
fn adopt_old_secret(user: &str) {
    let (Ok(new), Ok(old)) = (keyring::Entry::new(KEYRING_SERVICE, user), keyring::Entry::new(OLD_KEYRING_SERVICE, user)) else { return };
    if !matches!(new.get_password(), Err(keyring::Error::NoEntry)) {
        return;
    }
    if let Ok(secret) = old.get_password() {
        if new.set_password(&secret).is_ok() {
            let _ = old.delete_credential();
        }
    }
}
/// Bodies downloaded between two header syncs, so new mail is never far behind.
const BODIES_PER_ROUND: u32 = 400;
/// Sender checks re-read between two header syncs.
const HEADER_INFO_PER_ROUND: u32 = 4000;
const RETRY_AFTER: Duration = Duration::from_secs(30);
const IDLE_FOR: Duration = Duration::from_secs(20 * 60);
const POLL_EVERY: Duration = Duration::from_secs(120);

pub struct AppState {
    db: Db,
    /// One spare connection per account for things the user is waiting on
    /// (opening a message, changing a flag). Background sync has its own.
    interactive: tokio::sync::Mutex<HashMap<i64, Session>>,
    /// Wakes an account's background task out of its idle wait.
    wakers: Mutex<HashMap<i64, Arc<Notify>>>,
    /// Wakes the outbox worker when something is queued.
    outbox_wake: Notify,
    /// True once the tray icon exists, so the window may hide there instead of quitting.
    tray: std::sync::atomic::AtomicBool,
    /// Google access tokens per account, with their expiry (Unix seconds).
    tokens: Mutex<HashMap<i64, (String, i64)>>,
}

// ---------- passwords ----------

async fn save_password(address: String, password: String) -> Result<()> {
    tokio::task::spawn_blocking(move || -> Result<()> {
        keyring::Entry::new(KEYRING_SERVICE, &address)?.set_password(&password)?;
        Ok(())
    })
    .await?
    .map_err(|e| Error(format!("Could not save the password in the system keyring: {}", e.0)))
}

async fn load_password(address: String) -> Result<String> {
    tokio::task::spawn_blocking(move || -> Result<String> { Ok(keyring::Entry::new(KEYRING_SERVICE, &address)?.get_password()?) })
        .await?
        .map_err(|e| Error(format!("Could not read the password from the system keyring: {}", e.0)))
}

/// The key of the encrypted database, kept in the system keyring.
/// Made on first use; never recreated when a database already depends on it.
pub fn database_key(database: &std::path::Path) -> std::result::Result<String, String> {
    let keyring_error = |e: keyring::Error| format!("OpenWren could not use the system keyring, which holds the key of its mail database: {e}");
    adopt_old_secret("database-key");
    let entry = keyring::Entry::new(KEYRING_SERVICE, "database-key").map_err(keyring_error)?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) if database.exists() && !store::is_plain(database) => Err(format!(
            "The key for the mail database is missing from the system keyring. To start again with an empty app, delete {}.",
            database.display()
        )),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|e| format!("No random numbers available: {e}"))?;
            let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            entry.set_password(&key).map_err(keyring_error)?;
            Ok(key)
        }
        Err(e) => Err(keyring_error(e)),
    }
}

fn google_config(db: &Db) -> Result<oauth::Config> {
    let conn = db::lock(db);
    let id = db::get_setting(&conn, "google_client_id")?.filter(|v| !v.trim().is_empty());
    let secret = db::get_setting(&conn, "google_client_secret")?.unwrap_or_default();
    match id {
        Some(id) => Ok(oauth::Config::google(id.trim().to_string(), secret.trim().to_string())),
        None => Err(Error("Enter your Google client ID in Settings, under Accounts, first.".into())),
    }
}

/// The account's address, settings and a secret that works right now:
/// its password, or a fresh Google access token.
async fn account_secret(state: &AppState, account_id: i64) -> Result<(String, AccountSettings, Secret)> {
    let (address, settings) = db::account_settings(&db::lock(&state.db), account_id)?;
    let stored = load_password(address.clone()).await?;
    if !settings.oauth {
        return Ok((address, settings, Secret::Password(stored)));
    }
    if let Some((token, expires)) = state.tokens.lock().unwrap().get(&account_id).cloned() {
        if expires > now() + 60 {
            return Ok((address, settings, Secret::OAuthToken(token)));
        }
    }
    // For Google accounts the keyring holds the refresh token.
    let tokens = oauth::refresh(&google_config(&state.db)?, &stored).await?;
    state.tokens.lock().unwrap().insert(account_id, (tokens.access_token.clone(), now() + tokens.expires_in));
    Ok((address, settings, Secret::OAuthToken(tokens.access_token)))
}

async fn connect_account(state: &AppState, account_id: i64) -> Result<Session> {
    let (_, settings, secret) = account_secret(state, account_id).await?;
    let imap = settings.imap.ok_or(Error("This account has no IMAP server.".into()))?;
    imap::connect_with(&imap, &secret).await
}

/// Borrow the account's interactive connection, opening one if needed.
async fn take_session(state: &AppState, account_id: i64) -> Result<Session> {
    if let Some(session) = state.interactive.lock().await.remove(&account_id) {
        return Ok(session);
    }
    connect_account(state, account_id).await
}

async fn return_session(state: &AppState, account_id: i64, session: Session) {
    state.interactive.lock().await.insert(account_id, session);
}

// ---------- background sync ----------

struct UiNotifier(AppHandle);

impl sync::Notifier for UiNotifier {
    fn progress(&self, progress: Progress) {
        let _ = self.0.emit("sync-progress", progress);
    }
    fn changed(&self, account_id: i64) {
        let _ = self.0.emit("mail-changed", account_id);
    }
    fn new_mail(&self, _account_id: i64, mail: &[(String, String)]) {
        let state = self.0.state::<AppState>();
        if db::get_setting(&db::lock(&state.db), "notifications").ok().flatten().as_deref() == Some("off") {
            return;
        }
        let (title, body) = match mail {
            [(from, subject)] => (from.clone(), subject.clone()),
            many => (format!("{} new messages", many.len()), many.iter().take(3).map(|m| m.0.as_str()).collect::<Vec<_>>().join(", ")),
        };
        let _ = self.0.notification().builder().title(title).body(body).show();
    }
}

/// Wait for the server to announce a change in the inbox, a wake-up, or a timeout.
async fn wait_for_news(mut session: Session, wake: &Notify) -> Result<Session> {
    if !session.capabilities().await?.has_str("IDLE") {
        tokio::select! { _ = tokio::time::sleep(POLL_EVERY) => {}, _ = wake.notified() => {} }
        return Ok(session);
    }
    session.select("INBOX").await?;
    let mut handle = session.idle();
    handle.init().await?;
    {
        let (wait, stop) = handle.wait_with_timeout(IDLE_FOR);
        tokio::select! { result = wait => { result?; }, _ = wake.notified() => {} }
        drop(stop);
    }
    Ok(handle.done().await?)
}

/// One connection's worth of syncing. Returns only on error.
async fn sync_loop(app: &AppHandle, account_id: i64, wake: &Notify) -> Result<()> {
    let state = app.state::<AppState>();
    let notifier = UiNotifier(app.clone());
    let mut session = connect_account(&state, account_id).await?;
    loop {
        sync::run_ops(&state.db, &mut session, account_id).await?;
        sync::sync_headers(&state.db, &mut session, account_id, &notifier).await?;
        // Sender checks of mail synced by an earlier version come before message text:
        // they are small, and logos and warnings depend on them. Newest mail first.
        let unread_headers = sync::sync_header_info(&state.db, &mut session, account_id, HEADER_INFO_PER_ROUND).await?;
        // Which server's sender checks to believe is learned from the mailbox as a whole.
        if db::learn_auth_server(&db::lock(&state.db), account_id)? || unread_headers > 0 {
            sync::Notifier::changed(&notifier, account_id);
        }
        // "Keep message text for": 0 means everything, otherwise a number of days.
        let days: i64 = db::get_setting(&db::lock(&state.db), "body_days")?.and_then(|v| v.parse().ok()).unwrap_or(0);
        let not_older_than = if days > 0 { now() - days * 86_400 } else { 0 };
        let left = sync::sync_bodies(&state.db, &mut session, account_id, BODIES_PER_ROUND, not_older_than, &notifier).await?;
        if left > 0 || unread_headers > 0 {
            continue;
        }
        sync::Notifier::progress(&notifier, Progress { account_id, phase: "idle".into(), done: 0, total: 0, message: String::new() });
        session = wait_for_news(session, wake).await?;
    }
}

fn spawn_account(app: AppHandle, account_id: i64) {
    let wake = Arc::new(Notify::new());
    app.state::<AppState>().wakers.lock().unwrap().insert(account_id, wake.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            if !db::account_exists(&db::lock(&app.state::<AppState>().db), account_id).unwrap_or(false) {
                return; // the account was removed
            }
            if let Err(e) = sync_loop(&app, account_id, &wake).await {
                let _ = app.emit("sync-progress", Progress { account_id, phase: "error".into(), done: 0, total: 0, message: e.0 });
            }
            tokio::select! { _ = tokio::time::sleep(RETRY_AFTER) => {}, _ = wake.notified() => {} }
        }
    });
}

// ---------- commands ----------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    schema_version: i64,
    /// Where the mail database is kept.
    data_dir: String,
    /// The SQLCipher version encrypting the database.
    cipher: String,
    /// The font this desktop is set to use ("Segoe UI"), or empty when it cannot be read.
    system_font: String,
    /// True when the desktop uses the light weight of that font.
    system_font_light: bool,
}

/// The desktop's interface font, from the GNOME setting (also honoured by most GTK desktops).
/// The setting reads like "Segoe UI Light 11": family, optional style words, size.
fn desktop_font() -> (String, bool) {
    let setting = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.interface", "font-name"])
        .output()
        .ok()
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().trim_matches('\'').to_string())
        .unwrap_or_default();
    parse_desktop_font(&setting)
}

fn parse_desktop_font(setting: &str) -> (String, bool) {
    const STYLES: &[&str] = &["thin", "extra-light", "ultra-light", "light", "semi-light", "book", "regular", "normal", "medium", "semi-bold", "demi-bold", "bold", "extra-bold", "ultra-bold", "black", "heavy", "italic", "oblique", "condensed", "semi-condensed", "expanded"];
    let mut words: Vec<&str> = setting.split_whitespace().collect();
    if words.last().is_some_and(|w| w.parse::<f32>().is_ok()) {
        words.pop();
    }
    let mut light = false;
    while let Some(last) = words.last().map(|w| w.to_lowercase()) {
        if !STYLES.contains(&last.as_str()) || words.len() == 1 {
            break;
        }
        light |= last.contains("light") || last == "thin";
        words.pop();
    }
    // Only letters, digits, spaces and hyphens: the name is put into a style rule.
    let family: String = words.join(" ").chars().filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-').collect();
    (family, light)
}

#[tauri::command]
fn app_info(app: AppHandle, state: State<'_, AppState>) -> Result<AppInfo> {
    let (system_font, system_font_light) = desktop_font();
    let conn = db::lock(&state.db);
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        schema_version: store::schema_version(&conn)?,
        data_dir: app.path().app_data_dir().map(|d| d.display().to_string()).unwrap_or_default(),
        cipher: conn.query_row("PRAGMA cipher_version", [], |r| r.get(0)).unwrap_or_default(),
        system_font,
        system_font_light,
    })
}

#[tauri::command]
fn list_accounts(state: State<'_, AppState>) -> Result<Vec<Account>> {
    db::list_accounts(&db::lock(&state.db))
}

#[tauri::command]
fn list_folders(state: State<'_, AppState>) -> Result<Vec<Folder>> {
    db::list_folders(&db::lock(&state.db))
}

/// Mark every message of a folder as read; -1 means the inboxes of all accounts.
#[tauri::command]
fn mark_folder_read(app: AppHandle, state: State<'_, AppState>, folder_id: i64) -> Result<()> {
    let accounts = db::mark_folder_read(&db::lock(&state.db), folder_id)?;
    for account in accounts {
        wake_account(&state, account);
    }
    let _ = app.emit("mail-changed", 0);
    Ok(())
}

/// Block the sender of a message (or everyone at their domain): their inbox mail
/// moves to Junk now, and new mail from them goes there as it arrives.
/// Returns ids that `undo_moves` accepts for a few seconds (for the moves, not the block).
#[tauri::command]
fn block_sender(app: AppHandle, state: State<'_, AppState>, id: i64, whole_domain: bool) -> Result<Vec<i64>> {
    let ids = {
        let conn = db::lock(&state.db);
        let address: String = conn.query_row("SELECT from_address FROM messages WHERE id = ?1", [id], |r| r.get(0))?;
        let entry = blocked::entry_for(&address, whole_domain).ok_or(Error("This message has no sender address to block.".into()))?;
        let mut entries = blocked::list(&conn)?;
        if !entries.contains(&entry) {
            entries.push(entry.clone());
            blocked::save(&conn, &entries)?;
        }
        blocked::inbox_messages(&conn, &entry)?
    };
    let accounts = accounts_of(&state.db, &ids);
    let mut ops = Vec::new();
    for id in &ids {
        // An account without a Junk folder keeps the message where it is.
        ops.extend(actions::move_to_role(&state.db, *id, "junk", now()).ok().flatten());
    }
    let _ = app.emit("mail-changed", 0);
    wake_later(&app, accounts, Duration::from_secs(actions::UNDO_WINDOW as u64 + 1));
    Ok(ops)
}

/// Show a folder under Favorites, or stop showing it there.
#[tauri::command]
fn set_favorite(app: AppHandle, state: State<'_, AppState>, folder_id: i64, favorite: bool) -> Result<()> {
    db::set_favorite(&db::lock(&state.db), folder_id, favorite)?;
    let _ = app.emit("mail-changed", 0);
    Ok(())
}

/// How long after the last change a draft is uploaded to the server.
const DRAFT_UPLOAD_AFTER: i64 = 5;

fn wake_account(state: &AppState, account_id: i64) {
    if let Some(wake) = state.wakers.lock().unwrap().get(&account_id) {
        wake.notify_one();
    }
}

/// Save a draft here at once, and on the server shortly after.
/// `message_id` is given when the draft continues one that is already on the server.
#[tauri::command]
fn save_draft(app: AppHandle, state: State<'_, AppState>, id: Option<i64>, account_id: i64, content: String, message_id: Option<String>) -> Result<i64> {
    let conn = db::lock(&state.db);
    let message_id = match message_id.filter(|m| !m.trim().is_empty()) {
        Some(existing) => existing.trim_matches(['<', '>']).to_string(),
        None => {
            let (address, _, _) = db::account_identity(&conn, account_id)?;
            let mut bytes = [0u8; 16];
            getrandom::fill(&mut bytes).map_err(|e| Error(format!("No random numbers available: {e}")))?;
            format!("{}@{}", bytes.iter().map(|b| format!("{b:02x}")).collect::<String>(), address.rsplit('@').next().unwrap_or("openwren.local"))
        }
    };
    let saved = db::save_draft(&conn, id, account_id, &content, &message_id, now())?;
    db::queue_draft_upload(&conn, account_id, saved, now() + DRAFT_UPLOAD_AFTER)?;
    wake_later(&app, vec![account_id], Duration::from_secs(DRAFT_UPLOAD_AFTER as u64 + 1));
    Ok(saved)
}

#[tauri::command]
fn list_drafts(state: State<'_, AppState>) -> Result<Vec<LocalDraft>> {
    db::list_drafts(&db::lock(&state.db))
}

/// Delete a draft here and on the server (when it is sent or discarded).
#[tauri::command]
fn delete_draft(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<()> {
    if let Some(account_id) = db::delete_draft(&db::lock(&state.db), id)? {
        wake_account(&state, account_id);
        let _ = app.emit("mail-changed", account_id);
    }
    Ok(())
}

/// True for an address on the public internet: not this computer, not a home or office network.
fn is_public(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    let v4_public = |a: std::net::Ipv4Addr| {
        let [first, second, ..] = a.octets();
        !(a.is_private() || a.is_loopback() || a.is_link_local() || a.is_unspecified() || a.is_broadcast() || a.is_multicast() || a.is_documentation())
            && first != 0
            && !(first == 100 && (64..128).contains(&second)) // shared address space used by internet providers
    };
    match ip {
        IpAddr::V4(a) => v4_public(a),
        IpAddr::V6(a) => match a.to_ipv4_mapped() {
            Some(mapped) => v4_public(mapped),
            None => {
                let first = a.segments()[0];
                !(a.is_loopback() || a.is_unspecified() || a.is_multicast() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80)
            }
        },
    }
}

/// What an unsubscribe-by-mail request may contain: (recipient, subject, text).
///
/// The `mailto:` address comes from the message, so its author must not be able to
/// write a mail in the reader's name: exactly one plain address, no further
/// recipients, and a short one-line subject and text.
fn unsubscribe_mail(mailto: &str) -> Option<(String, String, String)> {
    let target = reqwest::Url::parse(mailto).ok().filter(|u| u.scheme() == "mailto")?;
    let to = target.path();
    let (local, domain) = to.split_once('@')?;
    let plain = |part: &str, extra: &str| !part.is_empty() && part.len() <= 128 && part.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    if !plain(local, "._+-=") || !plain(domain, ".-") || !domain.contains('.') {
        return None;
    }
    let mut subject = None;
    let mut body = None;
    for (key, value) in target.query_pairs() {
        match key.to_ascii_lowercase().as_str() {
            "subject" => subject = Some(value.into_owned()),
            "body" => body = Some(value.into_owned()),
            // to, cc, bcc or any other header: not something an unsubscribe request needs.
            _ => return None,
        }
    }
    let short = |text: Option<String>, max: usize| {
        let line: String = text.unwrap_or_default().chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect();
        let line = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() { "unsubscribe".to_string() } else { line }
    };
    Some((to.to_string(), short(subject, 120), short(body, 200)))
}

/// Ask a mailing's sender to stop writing. Returns what was done:
/// "posted" (request sent directly), "mailed" (unsubscribe mail queued) or "opened" (web page opened).
#[tauri::command]
async fn unsubscribe(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<String> {
    use tauri_plugin_opener::OpenerExt;
    let (account_id, confirmed, options) = db::unsubscribe_info(&db::lock(&state.db), id)?;
    match (options.kind(confirmed), options.https, options.mailto) {
        (Some("one-click"), Some(url), _) => {
            // The address comes from the message, so it is treated as hostile: it must be a
            // public website, and the request goes to exactly the address checked here.
            let target = reqwest::Url::parse(&url).ok().filter(|u| u.scheme() == "https");
            let (Some(target), Some(host)) = (target.clone(), target.as_ref().and_then(|u| u.host_str().map(str::to_string))) else {
                return Err(Error("The unsubscribe address in this message is not valid.".into()));
            };
            let port = target.port().unwrap_or(443);
            let addresses: Vec<std::net::SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
                .await
                .map_err(|_| Error(format!("The sender's unsubscribe site {host} could not be found.")))?
                .collect();
            let Some(address) = addresses.first().copied().filter(|_| addresses.iter().all(|a| is_public(a.ip()))) else {
                return Err(Error(format!("The unsubscribe address points to {host}, which is not a public website. Nothing was sent.")));
            };
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .user_agent("OpenWren")
                .redirect(reqwest::redirect::Policy::none())
                // A proxy would look the name up itself and undo the address check above.
                .no_proxy()
                .resolve(&host, address)
                .build()?;
            let response = client
                .post(target)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body("List-Unsubscribe=One-Click")
                .send()
                .await
                .map_err(|e| Error(format!("The sender's unsubscribe address did not answer: {e}")))?;
            if !response.status().is_success() {
                return Err(Error(format!("The sender refused the unsubscribe request ({}).", response.status())));
            }
            Ok("posted".into())
        }
        (Some("mail"), _, Some(mailto)) => {
            let (to, subject, body) = unsubscribe_mail(&mailto).ok_or(Error("The unsubscribe address in this message is not valid.".into()))?;
            let (address, display_name, _) = db::account_identity(&db::lock(&state.db), account_id)?;
            let built = smtp::build(&smtp::Outgoing {
                from_name: display_name,
                from_address: address,
                to: to.clone(),
                subject: subject.clone(),
                html: format!("<p>{}</p>", body.replace('&', "&amp;").replace('<', "&lt;")),
                ..Default::default()
            })?;
            db::queue_outgoing(&db::lock(&state.db), account_id, &built.raw, &built.mail_from, &built.recipients, &to, &subject, now())?;
            state.outbox_wake.notify_one();
            Ok("mailed".into())
        }
        (Some("link"), Some(url), _) => {
            app.opener().open_url(url, None::<&str>).map_err(|e| Error(format!("Could not open the browser: {e}")))?;
            Ok("opened".into())
        }
        _ => Err(Error("This message does not say how to unsubscribe.".into())),
    }
}

#[tauri::command]
fn list_messages(state: State<'_, AppState>, folder_id: i64, focused: Option<bool>, limit: u32, offset: u32, only: Option<String>) -> Result<Vec<MessageSummary>> {
    db::list_filtered(&db::lock(&state.db), folder_id, focused, only.as_deref(), limit.min(500), offset, now())
}

#[tauri::command]
fn list_pinned(state: State<'_, AppState>, folder_id: i64, focused: Option<bool>) -> Result<Vec<MessageSummary>> {
    db::list_pinned(&db::lock(&state.db), folder_id, focused)
}

#[tauri::command]
fn search_messages(state: State<'_, AppState>, query: String, filters: SearchFilters) -> Result<Vec<MessageSummary>> {
    db::search(&db::lock(&state.db), &query, &filters, chrono::Utc::now(), 300)
}

/// A message with its body. Fetches the body from the server the first time.
#[tauri::command]
async fn get_message(state: State<'_, AppState>, id: i64) -> Result<MessageDetail> {
    // Only a message whose text is not downloaded yet needs the server; everything else opens from disk.
    let location = {
        let conn = db::lock(&state.db);
        if db::has_body(&conn, id)? { None } else { db::location(&conn, id)? }
    };
    if let Some(location) = location {
        let mut session = take_session(&state, location.account_id).await?;
        sync::ensure_body(&state.db, &mut session, id).await?;
        return_session(&state, location.account_id, session).await;
    }
    db::message_detail(&db::lock(&state.db), id)
}

/// Change read, flagged or pinned. Applied locally first, then sent to the server.
#[tauri::command]
async fn set_flags(app: AppHandle, state: State<'_, AppState>, id: i64, unread: Option<bool>, flagged: Option<bool>, pinned: Option<bool>) -> Result<()> {
    let location = {
        let conn = db::lock(&state.db);
        db::set_local_flags(&conn, id, unread, flagged, pinned)?;
        db::location(&conn, id)?
    };
    // A message that is still being moved has no server copy to update yet, but lists still need refreshing.
    let Some(location) = location else {
        let _ = app.emit("mail-changed", 0);
        return Ok(());
    };
    let _ = app.emit("mail-changed", location.account_id);
    if unread.is_none() && flagged.is_none() {
        return Ok(()); // pinning is local only
    }
    // Send to the server now; if that is not possible (offline), queue it for the next sync.
    let mut changes = Vec::new();
    if let Some(unread) = unread {
        changes.push(("\\Seen", !unread));
    }
    if let Some(flagged) = flagged {
        changes.push(("\\Flagged", flagged));
    }
    let mut session = take_session(&state, location.account_id).await.ok();
    for (flag, on) in changes {
        let sent = match session.as_mut() {
            Some(s) => sync::store_flag(s, &location.folder_path, location.uid, flag, on).await.is_ok(),
            None => false,
        };
        if !sent {
            session = None;
            let payload = serde_json::json!({ "srcPath": location.folder_path, "uid": location.uid, "flag": flag, "on": on });
            db::enqueue_op(&db::lock(&state.db), location.account_id, "flag", &payload, 0)?;
        }
    }
    if let Some(session) = session {
        return_session(&state, location.account_id, session).await;
    }
    Ok(())
}

// ---------- moving, deleting, conversations ----------

/// Wake an account's background task once the undo window has passed, so queued moves go out.
fn wake_later(app: &AppHandle, account_ids: Vec<i64>, after: Duration) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(after).await;
        let state = app.state::<AppState>();
        for id in account_ids {
            if let Some(wake) = state.wakers.lock().unwrap().get(&id) {
                wake.notify_one();
            }
        }
    });
}

fn accounts_of(db: &Db, ids: &[i64]) -> Vec<i64> {
    let conn = db::lock(db);
    let mut out: Vec<i64> = ids.iter().filter_map(|id| db::placement(&conn, *id).ok().flatten().map(|p| p.0)).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// Move messages to a folder (by id) or to a role such as "archive".
/// Returns ids that `undo_moves` accepts for a few seconds.
#[tauri::command]
fn move_messages(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>, folder_id: Option<i64>, role: Option<String>) -> Result<Vec<i64>> {
    let accounts = accounts_of(&state.db, &ids);
    let mut ops = Vec::new();
    for id in &ids {
        let op = match (folder_id, &role) {
            (Some(folder), _) => actions::move_to_folder(&state.db, *id, folder, now())?,
            (None, Some(role)) => actions::move_to_role(&state.db, *id, role, now())?,
            (None, None) => return Err(Error("No destination folder given.".into())),
        };
        ops.extend(op);
    }
    for account in &accounts {
        let _ = app.emit("mail-changed", account);
    }
    wake_later(&app, accounts, Duration::from_secs(actions::UNDO_WINDOW as u64 + 1));
    Ok(ops)
}

/// Delete messages: to Deleted items, or permanently when already there.
#[tauri::command]
fn delete_messages(app: AppHandle, state: State<'_, AppState>, ids: Vec<i64>) -> Result<Vec<i64>> {
    let accounts = accounts_of(&state.db, &ids);
    let mut ops = Vec::new();
    for id in &ids {
        ops.extend(actions::delete(&state.db, *id, now())?);
    }
    for account in &accounts {
        let _ = app.emit("mail-changed", account);
    }
    wake_later(&app, accounts, Duration::from_secs(actions::UNDO_WINDOW as u64 + 1));
    Ok(ops)
}

/// Undo moves that have not been sent to the server yet. Returns how many were undone.
#[tauri::command]
fn undo_moves(app: AppHandle, state: State<'_, AppState>, ops: Vec<i64>) -> Result<u32> {
    let mut undone = 0;
    for op in ops {
        if actions::undo(&state.db, op)? {
            undone += 1;
        }
    }
    let _ = app.emit("mail-changed", 0);
    Ok(undone)
}

#[tauri::command]
fn thread_messages(state: State<'_, AppState>, id: i64) -> Result<Vec<MessageSummary>> {
    db::thread_messages(&db::lock(&state.db), id)
}

#[tauri::command]
fn set_categories(app: AppHandle, state: State<'_, AppState>, id: i64, categories: Vec<String>) -> Result<()> {
    db::set_categories(&db::lock(&state.db), id, &categories)?;
    let _ = app.emit("mail-changed", 0);
    Ok(())
}

/// Hide a message until `until` (Unix seconds); None brings it back now.
#[tauri::command]
fn snooze(app: AppHandle, state: State<'_, AppState>, id: i64, until: Option<i64>) -> Result<()> {
    db::set_snooze(&db::lock(&state.db), id, until)?;
    let _ = app.emit("mail-changed", 0);
    Ok(())
}

/// Ask the mail servers to search message text that is not downloaded yet,
/// and download what they find. Returns how many messages were fetched.
#[tauri::command]
async fn search_server(app: AppHandle, state: State<'_, AppState>, query: String, account_id: Option<i64>) -> Result<u32> {
    let words = search::parse(&query).words;
    if words.is_empty() {
        return Ok(0);
    }
    if !words.iter().all(|w| w.is_ascii()) {
        return Err(Error("Server search only supports plain English letters and digits for now.".into()));
    }
    let criteria = words.iter().map(|w| format!("TEXT \"{}\"", w.replace(['\\', '"'], ""))).collect::<Vec<_>>().join(" ");
    let accounts: Vec<i64> = db::list_accounts(&db::lock(&state.db))?
        .into_iter()
        .filter(|a| account_id.is_none_or(|id| id == a.id))
        .map(|a| a.id)
        .collect();
    let mut fetched = 0;
    for account in accounts {
        let mut session = take_session(&state, account).await?;
        let folders = db::account_folders(&db::lock(&state.db), account)?;
        for (folder_id, path) in folders {
            if session.select(&path).await.is_err() {
                continue;
            }
            let hits: Vec<u32> = session.uid_search(&criteria).await?.into_iter().collect();
            let missing = db::without_body(&db::lock(&state.db), folder_id, &hits)?;
            for chunk in missing.chunks(20).take(10) {
                sync::fetch_bodies(&state.db, &mut session, &path, chunk).await?;
                fetched += chunk.len() as u32;
            }
        }
        return_session(&state, account, session).await;
        let _ = app.emit("mail-changed", account);
    }
    Ok(fetched)
}

/// Check the servers accept the sign-in, then save the account and start syncing it.
#[tauri::command]
async fn add_account(app: AppHandle, state: State<'_, AppState>, account: NewAccount) -> Result<Account> {
    let address = account.address.trim().to_lowercase();
    if address.is_empty() || !address.contains('@') {
        return Err(Error("Enter a full email address.".into()));
    }
    if db::list_accounts(&db::lock(&state.db))?.iter().any(|a| a.address == address) {
        return Err(Error("That account is already added.".into()));
    }
    // Prove the sign-in works before saving anything.
    let imap = account.imap.clone().ok_or(Error("Enter the incoming mail server.".into()))?;
    let session = imap::connect(&imap, &account.password).await?;
    if let Some(smtp) = &account.smtp {
        smtp::check(smtp, &smtp::Secret::Password(account.password.clone())).await?;
    }
    save_password(address.clone(), account.password.clone()).await?;
    let settings = AccountSettings { imap: Some(imap), smtp: account.smtp.clone(), oauth: false };
    let kind = if settings.is_gmail() { "gmail" } else { "imap" };
    let id = db::insert_account(&db::lock(&state.db), &address, account.display_name.trim(), kind, &settings)?;
    return_session(&state, id, session).await;
    spawn_account(app, id);
    Ok(Account { id, address, display_name: account.display_name.trim().to_string(), kind: kind.into(), auth_server: None })
}

/// Remove an account, its local mail and its saved password. Nothing changes on the server.
#[tauri::command]
async fn remove_account(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<()> {
    let (address, _, _) = db::account_identity(&db::lock(&state.db), id)?;
    db::delete_account(&db::lock(&state.db), id)?;
    state.interactive.lock().await.remove(&id);
    if let Some(wake) = state.wakers.lock().unwrap().remove(&id) {
        wake.notify_one(); // its background task notices the account is gone and stops
    }
    let _ = tokio::task::spawn_blocking(move || keyring::Entry::new(KEYRING_SERVICE, &address).and_then(|e| e.delete_credential())).await;
    let _ = app.emit("mail-changed", id);
    Ok(())
}

// ---------- sending ----------

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The type and bytes of a `data:image/...;base64,` URL. Only common picture types are accepted.
fn decode_image(data_url: &str) -> Result<(String, Vec<u8>)> {
    use base64::Engine;
    let bad = || Error("The picture must be a PNG, JPEG or GIF image.".into());
    let (kind, data) = data_url.strip_prefix("data:").and_then(|rest| rest.split_once(";base64,")).ok_or_else(bad)?;
    if !["image/png", "image/jpeg", "image/gif"].contains(&kind) {
        return Err(bad());
    }
    Ok((kind.to_string(), base64::engine::general_purpose::STANDARD.decode(data).map_err(|_| bad())?))
}

/// Build the message and put it in the outbox. It leaves at `send_at`,
/// which is a few seconds ahead for "undo send" or later for "send later".
#[tauri::command]
async fn send_message(state: State<'_, AppState>, draft: OutgoingDraft) -> Result<i64> {
    let (address, display_name, _) = db::account_identity(&db::lock(&state.db), draft.account_id)?;
    let mut files = Vec::new();
    for path in &draft.attachments {
        if !db::was_picked(&db::lock(&state.db), path)? {
            return Err(Error(format!("{path} was not chosen with \"Attach\". Remove it and attach it again.")));
        }
        let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("attachment").to_string();
        let data = tokio::fs::read(path).await.map_err(|e| Error(format!("Could not read {name}: {e}")))?;
        files.push(smtp::FilePart { mime_type: smtp::mime_for(&name).to_string(), name, data });
    }
    let mut inline = Vec::new();
    for image in &draft.inline_images {
        let (mime_type, data) = decode_image(&image.data_url)?;
        inline.push(smtp::FilePart { name: image.cid.clone(), mime_type, data });
    }
    let built = smtp::build(&smtp::Outgoing {
        from_name: display_name,
        from_address: address,
        to: draft.to.clone(),
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject.clone(),
        html: draft.html,
        in_reply_to: draft.in_reply_to,
        references: draft.references,
        files,
        inline,
        ..Default::default()
    })?;
    let id = db::queue_outgoing(&db::lock(&state.db), draft.account_id, &built.raw, &built.mail_from, &built.recipients, &draft.to, &draft.subject, draft.send_at)?;
    state.outbox_wake.notify_one();
    Ok(id)
}

/// Take a message back out of the outbox. False when it has already been sent.
#[tauri::command]
fn cancel_send(state: State<'_, AppState>, id: i64) -> Result<bool> {
    db::remove_outgoing(&db::lock(&state.db), id)
}

#[tauri::command]
fn list_outbox(state: State<'_, AppState>) -> Result<Vec<OutboxItem>> {
    db::list_outbox(&db::lock(&state.db))
}

async fn deliver(state: &AppState, item: &db::Queued) -> Result<()> {
    let (_, settings, secret) = account_secret(state, item.account_id).await?;
    let smtp_settings = settings.smtp.clone().ok_or(Error("This account has no outgoing (SMTP) server.".into()))?;
    smtp::send(&smtp_settings, &secret, &item.mail_from, &item.recipients, &item.raw).await?;

    // From here on the message is sent; problems below must not cause a second send.
    {
        let conn = db::lock(&state.db);
        for recipient in &item.recipients {
            let _ = db::remember_contact(&conn, "", recipient, 5, now());
        }
    }
    let sent = db::folder_by_role(&db::lock(&state.db), item.account_id, "sent")?;
    // Gmail files its own copy of sent mail; adding one would duplicate it.
    if let (Some((_, path)), true) = (sent, settings.imap.is_some() && !settings.is_gmail()) {
        if let Ok(mut session) = take_session(state, item.account_id).await {
            if session.append(&path, Some("(\\Seen)"), None, &item.raw).await.is_ok() {
                return_session(state, item.account_id, session).await;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SendFailed {
    id: i64,
    subject: String,
    error: String,
}

/// Sends whatever is due in the outbox, retrying failures with a growing delay.
async fn outbox_worker(app: AppHandle) {
    let state = app.state::<AppState>();
    loop {
        tokio::select! { _ = tokio::time::sleep(Duration::from_secs(1)) => {}, _ = state.outbox_wake.notified() => {} }
        remove_old_opened_attachments(&app);
        count_usage(&app);
        if let Ok(accounts) = db::wake_snoozed(&db::lock(&state.db), now()) {
            for account in accounts {
                let _ = app.emit("mail-changed", account);
            }
        }
        let due = match db::due_outgoing(&db::lock(&state.db), now()) {
            Ok(due) => due,
            Err(_) => continue,
        };
        for item in due {
            match deliver(&state, &item).await {
                Ok(()) => {
                    let _ = db::remove_outgoing(&db::lock(&state.db), item.id);
                    let _ = app.emit("outbox-changed", item.id);
                    if let Some(wake) = state.wakers.lock().unwrap().get(&item.account_id) {
                        wake.notify_one(); // pick up the copy in Sent
                    }
                }
                Err(e) => {
                    let retry_at = now() + 60 * (item.attempts + 1).min(30);
                    let _ = db::fail_outgoing(&db::lock(&state.db), item.id, &e.0, retry_at);
                    let _ = app.emit("send-failed", SendFailed { id: item.id, subject: item.subject.clone(), error: e.0 });
                }
            }
        }
    }
}

// ---------- signatures and contacts ----------

#[tauri::command]
fn list_signatures(state: State<'_, AppState>) -> Result<Vec<Signature>> {
    db::list_signatures(&db::lock(&state.db))
}

#[tauri::command]
fn save_signature(state: State<'_, AppState>, signature: Signature) -> Result<i64> {
    if signature.name.trim().is_empty() {
        return Err(Error("Give the signature a name.".into()));
    }
    let layout = if ["left", "above"].contains(&signature.layout.as_str()) && !signature.image.is_empty() { signature.layout.clone() } else { "text".into() };
    if !signature.image.is_empty() {
        decode_image(&signature.image)?;
        if signature.image.len() > 400_000 {
            return Err(Error("The picture is too large. Choose a smaller one.".into()));
        }
    }
    let clean = Signature { html: parse::sanitize_html(&signature.html), layout, ..signature };
    db::save_signature(&db::lock(&state.db), &clean, &smtp::plain_from_html(&clean.html))
}

#[tauri::command]
fn delete_signature(state: State<'_, AppState>, id: i64) -> Result<()> {
    db::delete_signature(&db::lock(&state.db), id)
}

#[tauri::command]
fn signature_defaults(state: State<'_, AppState>) -> Result<Vec<SignatureDefaults>> {
    db::signature_defaults(&db::lock(&state.db))
}

#[tauri::command]
fn set_signature_defaults(state: State<'_, AppState>, defaults: SignatureDefaults) -> Result<()> {
    db::set_signature_defaults(&db::lock(&state.db), &defaults)
}

#[tauri::command]
fn suggest_contacts(state: State<'_, AppState>, typed: String) -> Result<Vec<Contact>> {
    db::suggest_contacts(&db::lock(&state.db), &typed, 8)
}

/// Wake every account's background task so it syncs now.
#[tauri::command]
fn sync_now(state: State<'_, AppState>) {
    for wake in state.wakers.lock().unwrap().values() {
        wake.notify_one();
    }
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// The icon in the system tray, with a small menu.
fn add_tray_icon(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    let open = MenuItem::with_id(app, "open", "Open OpenWren", true, None::<&str>)?;
    let sync = MenuItem::with_id(app, "sync", "Sync now", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let mut tray = tauri::tray::TrayIconBuilder::with_id("main").tooltip("OpenWren").menu(&Menu::with_items(app, &[&open, &sync, &quit])?);
    // A plain envelope with a clear outline: the app icon's pale background turns into a white blob at tray size.
    match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(icon) => tray = tray.icon(icon),
        Err(_) => {
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
        }
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "open" => show_window(app),
        "sync" => sync_now(app.state::<AppState>()),
        "quit" => app.exit(0),
        _ => {}
    })
    .build(app)?;
    Ok(())
}

// ---------- Google sign-in ----------

/// Sign in to Gmail in the system browser and add the account.
#[tauri::command]
async fn google_sign_in(app: AppHandle, state: State<'_, AppState>, address: String, display_name: String) -> Result<Account> {
    use tauri_plugin_opener::OpenerExt;
    let address = address.trim().to_lowercase();
    if !address.contains('@') {
        return Err(Error("Enter your full Gmail address.".into()));
    }
    if db::list_accounts(&db::lock(&state.db))?.iter().any(|a| a.address == address) {
        return Err(Error("That account is already added.".into()));
    }
    let config = google_config(&state.db)?;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let redirect = format!("http://127.0.0.1:{}", listener.local_addr()?.port());
    let verifier = oauth::random_token()?;
    let csrf = oauth::random_token()?;
    let url = oauth::authorize_url(&config, &redirect, &oauth::challenge_for(&verifier), &csrf, &address)?;
    app.opener().open_url(url, None::<&str>).map_err(|e| Error(format!("Could not open the browser: {e}")))?;
    let code = oauth::wait_for_code(listener, &csrf, Duration::from_secs(300)).await?;
    let tokens = oauth::exchange_code(&config, &code, &verifier, &redirect).await?;
    let refresh = tokens.refresh_token.ok_or(Error("Google did not return a refresh token. Remove OpenWren under \"Third-party access\" in your Google account and try again.".into()))?;

    let server = |host: &str, port: u16| ServerSettings { host: host.into(), port, security: Security::Tls, username: address.clone() };
    let imap = server("imap.gmail.com", 993);
    let session = imap::connect_with(&imap, &Secret::OAuthToken(tokens.access_token.clone())).await?;
    save_password(address.clone(), refresh).await?;
    let settings = AccountSettings { imap: Some(imap), smtp: Some(server("smtp.gmail.com", 465)), oauth: true };
    let id = db::insert_account(&db::lock(&state.db), &address, display_name.trim(), "gmail", &settings)?;
    state.tokens.lock().unwrap().insert(id, (tokens.access_token, now() + tokens.expires_in));
    return_session(&state, id, session).await;
    spawn_account(app, id);
    Ok(Account { id, address, display_name: display_name.trim().to_string(), kind: "gmail".into(), auth_server: None })
}

// ---------- settings, rules, files ----------

#[tauri::command]
fn get_setting(state: State<'_, AppState>, key: String) -> Result<Option<String>> {
    db::get_setting(&db::lock(&state.db), &key)
}

#[tauri::command]
fn set_setting(app: AppHandle, state: State<'_, AppState>, key: String, value: String) -> Result<()> {
    db::set_setting(&db::lock(&state.db), &key, &value)?;
    if key == "start_at_login" {
        autostart::apply(&app, value != "off");
    }
    Ok(())
}

#[tauri::command]
fn list_rules(state: State<'_, AppState>) -> Result<Vec<rules::Rule>> {
    db::list_rules(&db::lock(&state.db))
}

#[tauri::command]
fn save_rule(state: State<'_, AppState>, rule: rules::Rule) -> Result<i64> {
    if rule.name.trim().is_empty() {
        return Err(Error("Give the rule a name.".into()));
    }
    if rule.from_contains.trim().is_empty() && rule.subject_contains.trim().is_empty() {
        return Err(Error("Add a sender or a subject to match.".into()));
    }
    db::save_rule(&db::lock(&state.db), &rule)
}

#[tauri::command]
fn delete_rule(state: State<'_, AppState>, id: i64) -> Result<()> {
    db::delete_rule(&db::lock(&state.db), id)
}

/// Delete every message from the same sender in the same folder. Returns undo ids.
#[tauri::command]
fn sweep(app: AppHandle, state: State<'_, AppState>, id: i64) -> Result<Vec<i64>> {
    let ids = db::same_sender_in_folder(&db::lock(&state.db), id)?;
    delete_messages(app, state, ids)
}

/// Always show this sender in Focused (or Other), now and for future mail.
#[tauri::command]
fn set_sender_focus(app: AppHandle, state: State<'_, AppState>, id: i64, focused: bool) -> Result<()> {
    let conn = db::lock(&state.db);
    let address = db::set_sender_focus(&conn, id, focused)?;
    let mut overrides: HashMap<String, bool> = db::get_setting(&conn, "focus_overrides")?.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default();
    overrides.insert(address.to_lowercase(), focused);
    db::set_setting(&conn, "focus_overrides", &serde_json::to_string(&overrides)?)?;
    let _ = app.emit("mail-changed", 0);
    Ok(())
}

/// The complete original message, fetched from the server.
async fn fetch_raw(state: &AppState, id: i64) -> Result<Vec<u8>> {
    let location = db::location(&db::lock(&state.db), id)?.ok_or(Error("This message is still being moved. Try again in a moment.".into()))?;
    let mut session = take_session(state, location.account_id).await?;
    session.select(&location.folder_path).await?;
    let fetched = imap::fetch(&mut session, &location.uid.to_string(), "(UID BODY.PEEK[])").await?;
    let raw = fetched.first().and_then(|f| f.body()).map(<[u8]>::to_vec);
    return_session(state, location.account_id, session).await;
    raw.ok_or(Error("This message is no longer on the server.".into()))
}

/// Ask the user where to save a file. The dialog is shown by the engine, so the
/// interface can never name a path on its own.
async fn ask_save_path(app: &AppHandle, suggested: &str) -> Result<Option<std::path::PathBuf>> {
    use tauri_plugin_dialog::DialogExt;
    let name = std::path::Path::new(suggested).file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string();
    let app = app.clone();
    let chosen = tokio::task::spawn_blocking(move || app.dialog().file().set_file_name(name).blocking_save_file()).await?;
    Ok(chosen.and_then(|path| path.into_path().ok()))
}

/// Let the user choose files to attach. Only files chosen here can be attached later.
#[tauri::command]
async fn pick_attachments(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<String>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = tokio::task::spawn_blocking(move || app.dialog().file().blocking_pick_files()).await?.unwrap_or_default();
    let paths: Vec<String> = picked.into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.to_string_lossy().into_owned()).collect();
    let conn = db::lock(&state.db);
    for path in &paths {
        db::remember_picked(&conn, path)?;
    }
    Ok(paths)
}

/// Save one attachment (by its position in the message) where the user chooses. False when cancelled.
#[tauri::command]
async fn save_attachment(app: AppHandle, state: State<'_, AppState>, id: i64, index: usize, name: String) -> Result<bool> {
    let Some(path) = ask_save_path(&app, &name).await? else { return Ok(false) };
    let raw = fetch_raw(&state, id).await?;
    let data = parse::attachment_bytes(&raw, index).ok_or(Error("That attachment could not be read.".into()))?;
    tokio::fs::write(&path, data).await.map_err(|e| Error(format!("Could not save the file: {e}")))?;
    Ok(true)
}

/// Save the whole message as an .eml file where the user chooses. False when cancelled.
#[tauri::command]
async fn save_message(app: AppHandle, state: State<'_, AppState>, id: i64, name: String) -> Result<bool> {
    let Some(path) = ask_save_path(&app, &name).await? else { return Ok(false) };
    let raw = fetch_raw(&state, id).await?;
    tokio::fs::write(&path, raw).await.map_err(|e| Error(format!("Could not save the file: {e}")))?;
    Ok(true)
}

/// Open a web or mail address in the system's browser or mail handler.
/// Only http, https and mailto are accepted: the address may come from a message.
#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| Error("That link is not a valid address.".into()))?;
    if !matches!(parsed.scheme(), "http" | "https" | "mailto") {
        return Err(Error(format!("OpenWren does not open \"{}\" links.", parsed.scheme())));
    }
    app.opener().open_url(parsed.as_str(), None::<&str>).map_err(|e| Error(format!("Could not open the browser: {e}")))
}

/// The complete message as it arrived, headers included, for technical inspection.
/// Very long messages are cut; "Save as file" gives all of it.
#[tauri::command]
async fn message_source(state: State<'_, AppState>, id: i64) -> Result<String> {
    const LIMIT: usize = 1_000_000;
    let raw = fetch_raw(&state, id).await?;
    let mut text = String::from_utf8_lossy(&raw[..raw.len().min(LIMIT)]).into_owned();
    if raw.len() > LIMIT {
        text.push_str("\n\n[The message is longer than this. Save it as a file to see all of it.]");
    }
    Ok(text)
}

/// File types OpenWren hands to another program: documents, pictures, sound, video
/// and archives. The name and content of an attachment are chosen by the sender, so
/// everything else (programs, scripts, web pages, installers, files without a type)
/// can only be saved, never opened from here.
const OPENABLE: &[&str] = &[
    "pdf", "txt", "csv", "tsv", "md", "log", "rtf", "ics", "vcf", "eml", "epub",
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif",
    "mp3", "wav", "ogg", "oga", "flac", "m4a", "opus", "mp4", "m4v", "mkv", "webm", "mov", "avi",
    "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar",
];

fn opened_attachments_dir(app: &AppHandle) -> Result<std::path::PathBuf> {
    Ok(app.path().app_cache_dir().map_err(|e| Error(e.to_string()))?.join("opened-attachments"))
}

/// Send today's anonymous usage request if it has not gone out yet (see stats.rs).
/// Called often; tries a few minutes after start and then at most once an hour.
fn count_usage(app: &AppHandle) {
    static NEXT_TRY: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    use std::sync::atomic::Ordering::Relaxed;
    if NEXT_TRY.load(Relaxed) == 0 {
        // Within the first 30 seconds: not at the very moment of starting, and not at the same second for everyone.
        let mut random = [0u8; 2];
        let _ = getrandom::fill(&mut random);
        NEXT_TRY.store(now() + 10 + i64::from(u16::from_le_bytes(random)) % 20, Relaxed);
    }
    if now() < NEXT_TRY.load(Relaxed) {
        return;
    }
    NEXT_TRY.store(now() + 3600, Relaxed);
    let state = app.state::<AppState>();
    let ping = {
        let conn = db::lock(&state.db);
        if !stats::enabled(&conn) {
            return;
        }
        match stats::next(&conn, chrono::Utc::now(), &app.package_info().version.to_string()) {
            Ok(Some(ping)) => ping,
            _ => return,
        }
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if stats::send(&ping).await.is_ok() {
            let _ = stats::record(&db::lock(&app.state::<AppState>().db), &ping, chrono::Utc::now());
        }
    });
}

/// What the usage count would send right now, for showing in Settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsPreview {
    /// The request as JSON, or None when today's has already been sent.
    request: Option<stats::Ping>,
    /// Where it goes.
    endpoint: &'static str,
    /// False in development builds and under `OPENWREN_NO_STATS`, whatever the setting says.
    active: bool,
}

#[tauri::command]
fn stats_preview(app: AppHandle, state: State<'_, AppState>) -> Result<StatsPreview> {
    let conn = db::lock(&state.db);
    Ok(StatsPreview {
        request: stats::next(&conn, chrono::Utc::now(), &app.package_info().version.to_string())?,
        endpoint: stats::ENDPOINT,
        active: stats::enabled(&conn),
    })
}

/// How long an opened attachment stays in the temporary folder.
const OPENED_FOR: Duration = Duration::from_secs(30 * 60);

/// Remove opened attachments that have been lying around for a while.
/// Called often; looks at the folder about once a minute.
fn remove_old_opened_attachments(app: &AppHandle) {
    static LAST: std::sync::atomic::AtomicI64 = std::sync::atomic::AtomicI64::new(0);
    if now() - LAST.load(std::sync::atomic::Ordering::Relaxed) < 60 {
        return;
    }
    LAST.store(now(), std::sync::atomic::Ordering::Relaxed);
    let Ok(entries) = opened_attachments_dir(app).and_then(|dir| Ok(std::fs::read_dir(dir)?)) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().and_then(|m| m.modified()).ok().and_then(|at| at.elapsed().ok()).is_some_and(|age| age > OPENED_FOR);
        if old {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// Open one attachment in the program this computer uses for its type.
/// The file is written to a private temporary folder that is emptied when OpenWren starts.
#[tauri::command]
async fn open_attachment(app: AppHandle, state: State<'_, AppState>, id: i64, index: usize, name: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    // Only the file name itself: a name from a message must never choose the folder.
    let name = std::path::Path::new(&name).file_name().and_then(|n| n.to_str()).unwrap_or("attachment").to_string();
    let extension = name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if !OPENABLE.contains(&extension.as_str()) {
        return Err(Error(format!("For your safety OpenWren does not open this kind of file from mail. Save {name} first if you trust the sender.")));
    }
    let raw = fetch_raw(&state, id).await?;
    let data = parse::attachment_bytes(&raw, index).ok_or(Error("That attachment could not be read.".into()))?;
    let dir = opened_attachments_dir(&app)?.join(format!("{id}-{index}"));
    tokio::fs::create_dir_all(&dir).await?;
    let path = dir.join(&name);
    tokio::fs::write(&path, data).await.map_err(|e| Error(format!("Could not write the file: {e}")))?;
    // The copy is not encrypted: keep it readable by this user only. (On Windows the
    // temporary folder is already private to the user.)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| Error(format!("No program on this computer opens {name}: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{is_public, parse_desktop_font, unsubscribe_mail, OPENABLE};
    use crate::model::{AccountSettings, Security, ServerSettings};

    #[test]
    fn unsubscribe_mail_cannot_be_turned_into_a_message_of_the_senders_choosing() {
        let ok = unsubscribe_mail("mailto:leave+42@lists.shop.example?subject=unsubscribe%20news").unwrap();
        assert_eq!(ok, ("leave+42@lists.shop.example".to_string(), "unsubscribe news".to_string(), "unsubscribe".to_string()));
        let long = unsubscribe_mail(&format!("mailto:a@b.example?subject=I%20resign%0D%0ABcc:%20x@y.example&body={}", "x".repeat(500))).unwrap();
        assert_eq!(long.1, "I resign Bcc: x@y.example", "one line");
        assert_eq!(long.2.len(), 200);
        for bad in [
            "mailto:boss@corp.example,hr@corp.example?subject=I%20resign",
            "mailto:a@b.example?cc=boss@corp.example",
            "mailto:a@b.example?to=boss@corp.example",
            "mailto:a%40b.example%2Cboss@corp.example",
            "mailto:?to=boss@corp.example",
            "mailto:nobody",
            "https://shop.example/leave",
        ] {
            assert!(unsubscribe_mail(bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn only_documents_and_media_open_from_mail() {
        for no in ["html", "htm", "svg", "desktop", "sh", "exe", "jar", "js", "flatpakref", "docm", ""] {
            assert!(!OPENABLE.contains(&no), "{no}");
        }
        assert!(OPENABLE.contains(&"pdf") && OPENABLE.contains(&"docx") && OPENABLE.contains(&"png"));
    }

    #[test]
    fn a_gmail_mailbox_is_recognised_however_it_signs_in() {
        let on = |host: &str| AccountSettings { imap: Some(ServerSettings { host: host.into(), port: 993, security: Security::Tls, username: "a@b.c".into() }), ..Default::default() };
        assert!(on("imap.gmail.com").is_gmail(), "app password");
        assert!(on(" IMAP.Gmail.com ").is_gmail());
        assert!(on("imap.googlemail.com").is_gmail());
        assert!(!on("imap.fastmail.com").is_gmail());
        assert!(!on("imap.gmail.com.evil.example").is_gmail());
        assert!(AccountSettings { oauth: true, ..on("imap.example.org") }.is_gmail(), "Google sign-in");
    }

    #[test]
    fn reads_the_family_and_weight_of_the_desktop_font() {
        assert_eq!(parse_desktop_font("Segoe UI Light 11"), ("Segoe UI".to_string(), true));
        assert_eq!(parse_desktop_font("Ubuntu 11"), ("Ubuntu".to_string(), false));
        assert_eq!(parse_desktop_font("Noto Sans Semi-Bold Italic 10.5"), ("Noto Sans".to_string(), false));
        assert_eq!(parse_desktop_font("Cantarell"), ("Cantarell".to_string(), false));
        assert_eq!(parse_desktop_font(""), (String::new(), false));
    }

    #[test]
    fn only_public_addresses_may_receive_an_unsubscribe_request() {
        for private in ["127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.4.4", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:192.168.1.1"] {
            assert!(!is_public(private.parse().unwrap()), "{private}");
        }
        for public in ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"] {
            assert!(is_public(public.parse().unwrap()), "{public}");
        }
    }
}

pub fn run() {
    let builder = tauri::Builder::default();
    // Start at login on macOS and Windows; Linux writes its own entry (autostart.rs).
    #[cfg(not(target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec![autostart::HIDDEN])));
    builder
        // Starting OpenWren again shows the window of the one already running.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            adopt_old_data(&dir);
            std::fs::create_dir_all(&dir)?;
            let _ = std::fs::remove_dir(dir.join("raw")); // left empty by the removed POP3 support
            // Attachments opened last time were written out unencrypted: remove them.
            if let Ok(opened) = opened_attachments_dir(app.handle()) {
                let _ = std::fs::remove_dir_all(opened);
            }
            let _ = tokio_rustls::rustls::crypto::ring::default_provider().install_default();
            let database = dir.join(DATABASE);
            let conn = store::open(&database, &database_key(&database)?)?;
            let accounts = db::list_accounts(&conn).map_err(|e| e.0)?;
            // Start at login unless switched off; this also follows the program when it moves.
            autostart::apply(app.handle(), db::get_setting(&conn, "start_at_login").ok().flatten().as_deref() != Some("off"));
            for account in &accounts {
                adopt_old_secret(&account.address);
            }
            app.manage(AppState {
                db: Arc::new(Mutex::new(conn)),
                interactive: Default::default(),
                wakers: Default::default(),
                outbox_wake: Notify::new(),
                tray: Default::default(),
                tokens: Default::default(),
            });
            match add_tray_icon(app) {
                Ok(()) => app.state::<AppState>().tray.store(true, std::sync::atomic::Ordering::Relaxed),
                Err(e) => eprintln!("No tray icon: {e}"), // the app works without one; closing the window then quits
            }
            // Started at login: stay in the tray. Without a tray there would be no way back, so show the window.
            let hidden = std::env::args().any(|arg| arg == autostart::HIDDEN) && app.state::<AppState>().tray.load(std::sync::atomic::Ordering::Relaxed);
            if !hidden {
                show_window(app.handle());
            }
            tauri::async_runtime::spawn(outbox_worker(app.handle().clone()));
            for account in accounts {
                spawn_account(app.handle().clone(), account.id);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window keeps OpenWren in the tray, so new mail is still announced.
            let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
            let app = window.app_handle();
            let state = app.state::<AppState>();
            let conn = db::lock(&state.db);
            let wanted = db::get_setting(&conn, "close_to_tray").ok().flatten().as_deref() != Some("off");
            if !wanted || !state.tray.load(std::sync::atomic::Ordering::Relaxed) {
                return;
            }
            api.prevent_close();
            let _ = window.hide();
            if db::get_setting(&conn, "tray_hint_shown").ok().flatten().is_none() {
                let _ = db::set_setting(&conn, "tray_hint_shown", "yes");
                let _ = app.notification().builder().title("OpenWren is still running").body("It stays in the tray to tell you about new mail. Use the tray icon to open it or quit.").show();
            }
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            list_accounts,
            list_folders,
            list_messages,
            set_favorite,
            block_sender,
            mark_folder_read,
            save_draft,
            list_drafts,
            delete_draft,
            unsubscribe,
            list_pinned,
            search_messages,
            get_message,
            set_flags,
            add_account,
            remove_account,
            sync_now,
            send_message,
            cancel_send,
            list_outbox,
            list_signatures,
            save_signature,
            delete_signature,
            signature_defaults,
            set_signature_defaults,
            suggest_contacts,
            move_messages,
            delete_messages,
            undo_moves,
            thread_messages,
            set_categories,
            snooze,
            search_server,
            google_sign_in,
            get_setting,
            set_setting,
            list_rules,
            save_rule,
            delete_rule,
            sweep,
            set_sender_focus,
            save_attachment,
            message_source,
            open_link,
            stats_preview,
            mark_ready,
            pick_attachments,
            open_attachment,
            save_message
        ])
        .build(tauri::generate_context!())
        .expect("error while starting OpenWren")
        .run(|app, event| {
            // Attachments opened during this session were written out unencrypted: remove them on the way out.
            if let tauri::RunEvent::Exit = event {
                if let Ok(opened) = opened_attachments_dir(app) {
                    let _ = std::fs::remove_dir_all(opened);
                }
            }
        });
}
