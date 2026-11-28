//! Noticing that a mail server connection has died.
//!
//! A TCP connection that dies quietly, because the computer slept or its network changed, gives
//! no sign of it: a read on it waits for an answer that never comes, and syncing stops with it.
//! Two things end such a wait. When the system says it has woken up, or that the network has
//! changed, every connection opened before fails at once, and syncing connects again. And a
//! connection that is waiting for the server, outside IDLE, fails after `QUIET_LIMIT` without
//! a byte. Both are timers or signals, so a working connection costs nothing.

use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::futures::OwnedNotified;
use tokio::sync::Notify;
use tokio::time::Sleep;

/// How long a connection may wait for the server, outside IDLE, without a byte either way.
/// Servers answer in seconds, and long answers arrive as a steady stream.
pub const QUIET_LIMIT: Duration = Duration::from_secs(120);
/// Network changes come in bursts (an address goes, a route comes): act once it has been calm this long.
const SETTLE: Duration = Duration::from_secs(2);

/// Counts network changes. A connection opened before the latest one is not trusted.
static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Wakes connections waiting on the server when the network changes.
fn changes() -> &'static Arc<Notify> {
    static CHANGED: OnceLock<Arc<Notify>> = OnceLock::new();
    CHANGED.get_or_init(|| Arc::new(Notify::new()))
}
/// Reports from the system, before they have settled.
static REPORTS: Notify = Notify::const_new();
static LAST_CHANGE: Mutex<Option<Instant>> = Mutex::new(None);

tokio::task_local! {
    /// Set while waiting in IDLE, where hearing nothing for a long time is normal.
    static IDLING: ();
}

/// Run `f` as an IDLE wait: the connection may stay silent for as long as it takes.
pub async fn idling<F: Future>(f: F) -> F::Output {
    IDLING.scope((), f).await
}

pub fn generation() -> u64 {
    GENERATION.load(Ordering::SeqCst)
}

/// True when the network changed within `within`: a failure then is expected and passes quickly.
pub fn changed_within(within: Duration) -> bool {
    LAST_CHANGE.lock().unwrap().is_some_and(|at| at.elapsed() < within)
}

/// Resolves on the next network change.
pub async fn next_change() {
    changes().notified().await;
}

/// The network changed: every connection opened before fails, and those waiting wake up.
pub fn changed() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
    *LAST_CHANGE.lock().unwrap() = Some(Instant::now());
    changes().notify_waiters();
}

/// The system reported a change. It takes effect in `settle`, once the burst is over.
pub fn report() {
    REPORTS.notify_one();
}

/// Turn bursts of reports into one change each, calling `then` after it.
pub async fn settle(then: impl Fn()) {
    loop {
        REPORTS.notified().await;
        loop {
            tokio::select! {
                _ = REPORTS.notified() => {}
                _ = tokio::time::sleep(SETTLE) => break,
            }
        }
        changed();
        then();
    }
}

/// Listen for the system waking up and for network changes. Must run on the main thread,
/// whose GLib loop delivers the signals.
#[cfg(target_os = "linux")]
pub fn watch() {
    use gio::prelude::*;
    // The address or route set changed, or the network went away or came back.
    let monitor = gio::NetworkMonitor::default();
    monitor.connect_network_changed(|_, _| report());
    std::mem::forget(monitor);
    // logind announces sleep ("true") and waking ("false"). A connection can die during sleep
    // without the network changing, as the server and the router forget it.
    match gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE) {
        Ok(bus) => {
            bus.signal_subscribe(
                Some("org.freedesktop.login1"),
                Some("org.freedesktop.login1.Manager"),
                Some("PrepareForSleep"),
                Some("/org/freedesktop/login1"),
                None,
                gio::DBusSignalFlags::NONE,
                |_, _, _, _, _, _| report(),
            );
            std::mem::forget(bus);
        }
        Err(e) => eprintln!("Not told about sleep: {e}"),
    }
}

/// Elsewhere, only `QUIET_LIMIT` ends a wait on a dead connection.
#[cfg(not(target_os = "linux"))]
pub fn watch() {}

/// A connection that fails instead of waiting forever. See the module comment.
#[derive(Debug)]
pub struct Watched<S> {
    inner: S,
    opened: u64,
    limit: Duration,
    /// Registered while waiting, so that a network change wakes the wait.
    change: Option<Pin<Box<OwnedNotified>>>,
    /// Running while waiting, outside IDLE.
    quiet: Option<Pin<Box<Sleep>>>,
}

impl<S> Watched<S> {
    pub fn new(inner: S) -> Self {
        Self::with_limit(inner, QUIET_LIMIT)
    }

    /// With a shorter limit, for tests that use real sockets and so cannot pause the clock.
    fn with_limit(inner: S, limit: Duration) -> Self {
        Watched { inner, opened: generation(), limit, change: None, quiet: None }
    }

    fn check(&self) -> io::Result<()> {
        if generation() != self.opened {
            return Err(io::Error::new(io::ErrorKind::ConnectionAborted, "The network changed, so OpenWren connects again."));
        }
        Ok(())
    }

    /// The inner stream made progress: the next wait starts afresh.
    fn progress(&mut self) {
        self.change = None;
        self.quiet = None;
    }

    /// The inner stream has to wait. Fail if it waited too long, or once the network changes.
    fn waiting(&mut self, cx: &mut Context<'_>) -> io::Result<()> {
        let change = self.change.get_or_insert_with(|| Box::pin(changes().clone().notified_owned()));
        if change.as_mut().poll(cx).is_ready() {
            self.change = None;
        }
        // A change between the first check and registering above is caught here.
        self.check()?;
        if IDLING.try_with(|_| ()).is_ok() {
            self.quiet = None;
            return Ok(());
        }
        let limit = self.limit;
        let quiet = self.quiet.get_or_insert_with(|| Box::pin(tokio::time::sleep(limit)));
        if quiet.as_mut().poll(cx).is_ready() {
            self.quiet = None;
            return Err(io::Error::new(io::ErrorKind::TimedOut, format!("The server did not answer for {} seconds.", limit.as_secs())));
        }
        Ok(())
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for Watched<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        self.check()?;
        match Pin::new(&mut self.inner).poll_read(cx, buf) {
            Poll::Ready(result) => {
                self.progress();
                Poll::Ready(result)
            }
            Poll::Pending => {
                self.waiting(cx)?;
                Poll::Pending
            }
        }
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Watched<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        self.check()?;
        match Pin::new(&mut self.inner).poll_write(cx, data) {
            Poll::Ready(result) => {
                self.progress();
                Poll::Ready(result)
            }
            Poll::Pending => {
                self.waiting(cx)?;
                Poll::Pending
            }
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.check()?;
        match Pin::new(&mut self.inner).poll_flush(cx) {
            Poll::Ready(result) => {
                self.progress();
                Poll::Ready(result)
            }
            Poll::Pending => {
                self.waiting(cx)?;
                Poll::Pending
            }
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // The generation is global, so the tests that change it must not overlap the others.
    static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A wait that fails the test instead of stalling it. On a paused clock the hour passes at once.
    async fn bounded<F: Future>(f: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(3600), f).await.expect("the wait never ended")
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_server_times_out() {
        let _one = SERIAL.lock().await;
        let (client, _server) = tokio::io::duplex(64);
        let mut watched = Watched::new(client);
        let started = tokio::time::Instant::now();
        let err = bounded(watched.read(&mut [0; 8])).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert_eq!(started.elapsed(), QUIET_LIMIT);
    }

    #[tokio::test(start_paused = true)]
    async fn each_byte_restarts_the_limit() {
        let _one = SERIAL.lock().await;
        let (client, mut server) = tokio::io::duplex(64);
        let mut watched = Watched::new(client);
        let talk = tokio::spawn(async move {
            for _ in 0..3 {
                tokio::time::sleep(QUIET_LIMIT - Duration::from_secs(1)).await;
                server.write_all(b"x").await.unwrap();
            }
            server
        });
        let mut byte = [0; 1];
        for _ in 0..3 {
            watched.read_exact(&mut byte).await.unwrap();
        }
        let _server = talk.await.unwrap();
        assert_eq!(bounded(watched.read(&mut byte)).await.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[tokio::test(start_paused = true)]
    async fn idle_may_stay_silent() {
        let _one = SERIAL.lock().await;
        let (client, mut server) = tokio::io::duplex(64);
        let mut watched = Watched::new(client);
        let talk = tokio::spawn(async move {
            tokio::time::sleep(QUIET_LIMIT * 10).await;
            server.write_all(b"* 3 EXISTS\r\n").await.unwrap();
            server
        });
        let mut line = [0; 12];
        bounded(idling(watched.read_exact(&mut line))).await.unwrap();
        assert_eq!(&line, b"* 3 EXISTS\r\n");
        let _server = talk.await.unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn a_network_change_ends_a_wait_at_once() {
        let _one = SERIAL.lock().await;
        let (client, _server) = tokio::io::duplex(64);
        let mut watched = Watched::new(client);
        let started = tokio::time::Instant::now();
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_secs(5)).await;
            changed();
        });
        // Even in IDLE, which has no time limit.
        let err = bounded(idling(watched.read(&mut [0; 8]))).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);
        assert_eq!(started.elapsed(), Duration::from_secs(5));
        assert!(changed_within(Duration::from_secs(1)));
    }

    #[tokio::test(start_paused = true)]
    async fn a_connection_from_before_a_change_fails_on_next_use() {
        let _one = SERIAL.lock().await;
        let (client, mut server) = tokio::io::duplex(64);
        let mut watched = Watched::new(client);
        server.write_all(b"ok").await.unwrap();
        changed();
        assert_eq!(watched.read(&mut [0; 2]).await.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        assert_eq!(watched.write(b"x").await.unwrap_err().kind(), io::ErrorKind::ConnectionAborted);
        // One opened after the change works.
        let (client, mut server) = tokio::io::duplex(64);
        let mut fresh = Watched::new(client);
        server.write_all(b"ok").await.unwrap();
        fresh.read_exact(&mut [0; 2]).await.unwrap();
    }

    /// A server that signs the client in, then never answers again: the computer slept mid-command.
    async fn server_that_goes_silent() -> u16 {
        use tokio::io::AsyncBufReadExt;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = tokio::io::BufReader::new(read).lines();
            write.write_all(b"* OK ready\r\n").await.unwrap();
            let login = lines.next_line().await.unwrap().unwrap();
            let tag = login.split(' ').next().unwrap().to_string();
            write.write_all(format!("{tag} OK signed in\r\n").as_bytes()).await.unwrap();
            // Read the next command and keep the connection open without a word.
            let _ = lines.next_line().await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
            drop(write);
        });
        port
    }

    #[tokio::test]
    async fn a_command_stuck_on_a_dead_connection_ends_when_the_network_changes() {
        let _one = SERIAL.lock().await;
        let port = server_that_goes_silent().await;
        let settings = crate::model::ServerSettings { host: "127.0.0.1".into(), port, security: crate::model::Security::None, username: "me".into() };
        let mut session = crate::imap::connect(&settings, "pass").await.unwrap();
        let started = Instant::now();
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            changed();
        });
        // Bounded, so that a broken wake-up fails the test instead of stalling it.
        let err = tokio::time::timeout(Duration::from_secs(5), session.select("INBOX"))
            .await
            .expect("the network change did not end the command within five seconds")
            .unwrap_err();
        assert!(err.to_string().contains("network changed"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    /// A TLS server for "localhost" that completes the handshake, reads one line, then goes
    /// silent. Returns the client side, TLS over `Watched` as for a real account.
    async fn tls_to_a_server_that_goes_silent(limit: Duration) -> tokio_rustls::client::TlsStream<Watched<tokio::net::TcpStream>> {
        use tokio::io::AsyncBufReadExt;
        use tokio_rustls::rustls::{self, pki_types::PrivateKeyDer, ClientConfig, RootCertStore, ServerConfig};
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let key = PrivateKeyDer::Pkcs8(cert.key_pair.serialize_der().into());
        let server = ServerConfig::builder_with_provider(provider.clone())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert.cert.der().clone()], key)
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let tls = tokio_rustls::TlsAcceptor::from(Arc::new(server)).accept(socket).await.unwrap();
            let mut lines = tokio::io::BufReader::new(tls).lines();
            let _ = lines.next_line().await;
            tokio::time::sleep(Duration::from_secs(3600)).await;
            drop(lines);
        });
        let mut roots = RootCertStore::empty();
        roots.add(cert.cert.der().clone()).unwrap();
        let client = ClientConfig::builder_with_provider(provider).with_safe_default_protocol_versions().unwrap().with_root_certificates(roots).with_no_client_auth();
        let tcp = Watched::with_limit(tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap(), limit);
        let name = rustls::pki_types::ServerName::try_from("localhost").unwrap();
        let mut tls = tokio_rustls::TlsConnector::from(Arc::new(client)).connect(name, tcp).await.unwrap();
        tls.write_all(b"a1 NOOP\r\n").await.unwrap();
        tls.flush().await.unwrap();
        tls
    }

    #[tokio::test]
    async fn under_tls_a_silent_server_times_out() {
        let _one = SERIAL.lock().await;
        let limit = Duration::from_millis(300);
        let mut tls = tls_to_a_server_that_goes_silent(limit).await;
        let started = Instant::now();
        let err = tokio::time::timeout(Duration::from_secs(5), tls.read(&mut [0; 64])).await.expect("no time limit under TLS").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        assert!(started.elapsed() >= limit);
    }

    #[tokio::test]
    async fn under_tls_a_network_change_ends_a_wait_at_once() {
        let _one = SERIAL.lock().await;
        let mut tls = tls_to_a_server_that_goes_silent(QUIET_LIMIT).await;
        let started = Instant::now();
        tokio::spawn(async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            changed();
        });
        let err = tokio::time::timeout(Duration::from_secs(5), tls.read(&mut [0; 64])).await.expect("the network change did not end the wait under TLS").unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::ConnectionAborted);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test(start_paused = true)]
    async fn a_burst_of_reports_is_one_change() {
        let _one = SERIAL.lock().await;
        let count = Arc::new(AtomicU64::new(0));
        let seen = count.clone();
        let before = generation();
        tokio::spawn(settle(move || {
            seen.fetch_add(1, Ordering::SeqCst);
        }));
        for _ in 0..5 {
            report();
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        tokio::time::sleep(SETTLE * 2).await;
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(generation(), before + 1);
    }
}
