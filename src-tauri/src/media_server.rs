//! Loopback-only, read-only HTTP/1.1 streaming server for desktop runtime media.
//!
//! Binds exclusively to `127.0.0.1` on an OS-assigned ephemeral port with a per-process
//! 32-byte random path token, strict `Host` validation, GET/HEAD-only enforcement, bounded
//! concurrency, and chunk-by-chunk SQLite streaming via `runtime_content::open_media`.

use crate::runtime_content::{self, MediaChunks, OpenMedia};
use rusqlite::{Connection, OpenFlags};
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const MAX_CONCURRENT_CONNECTIONS: usize = 16;
const MAX_REQUEST_HEAD_BYTES: usize = 16 * 1024;
const MAX_HEADERS: usize = 64;
const WRITE_SLICE_BYTES: usize = 64 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);
const BUSY_WRITE_TIMEOUT: Duration = Duration::from_millis(50);
const ACCEPT_POLL_INTERVAL: Duration = Duration::from_millis(10);
const IO_POLL_INTERVAL: Duration = Duration::from_millis(100);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(6);

const BUSY_RESPONSE: &[u8] = b"HTTP/1.1 503 Service Unavailable\r\n\
Content-Length: 0\r\n\
Retry-After: 1\r\n\
Cache-Control: no-store\r\n\
X-Content-Type-Options: nosniff\r\n\
Connection: close\r\n\r\n";

/// A private listener configuration; only a successfully started handle publishes URLs.
#[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
pub struct MediaServer {
    listener: TcpListener,
    port: u16,
    token: String,
    max_connections: usize,
}

/// Live handle keeping the loopback accept loop running until dropped on app exit.
#[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
pub struct MediaServerHandle {
    port: u16,
    token: String,
    shutdown: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
    #[cfg(test)]
    chunk_reads: Arc<AtomicUsize>,
    accept_thread: Option<JoinHandle<()>>,
}

struct ServerConfig {
    db_path: PathBuf,
    expected_host: String,
    token: String,
    shutdown: Arc<AtomicBool>,
    header_timeout: Duration,
    #[cfg(test)]
    chunk_reads: Arc<AtomicUsize>,
}

struct Worker {
    socket: TcpStream,
    thread: JoinHandle<()>,
}

/// Preserve the write inactivity timeout while checking cancellation between waits.
struct SocketWriter<'a> {
    stream: &'a mut TcpStream,
    shutdown: &'a AtomicBool,
}

impl<'a> SocketWriter<'a> {
    fn new(stream: &'a mut TcpStream, shutdown: &'a AtomicBool) -> std::io::Result<Self> {
        // Nonblocking writes report an exact byte count. Retrying timed-out blocking
        // writes can duplicate bytes on Windows when the OS already sent part of them.
        stream.set_nonblocking(true)?;
        Ok(Self { stream, shutdown })
    }
}

impl Write for SocketWriter<'_> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let deadline = Instant::now() + WRITE_TIMEOUT;
        loop {
            if self.shutdown.load(Ordering::Acquire) {
                return Err(std::io::Error::new(
                    ErrorKind::ConnectionAborted,
                    "Media server stopped",
                ));
            }
            match self.stream.write(bytes) {
                Err(error)
                    if error.kind() == ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    thread::sleep(ACCEPT_POLL_INTERVAL);
                }
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

struct ActiveGuard(Arc<AtomicUsize>);

impl ActiveGuard {
    fn try_acquire(counter: &Arc<AtomicUsize>, limit: usize) -> Option<Self> {
        let mut current = counter.load(Ordering::Acquire);
        loop {
            if current >= limit {
                return None;
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return Some(Self(Arc::clone(counter))),
                Err(next) => current = next,
            }
        }
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Method {
    Get,
    Head,
}

struct ParsedRequest {
    method: Method,
    target: String,
    range: Option<String>,
    if_range: Option<String>,
    if_none_match: Option<String>,
}

enum ParseError {
    BadRequest,
    Forbidden,
    MethodNotAllowed,
    HeaderTooLarge,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RangeOutcome {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

#[cfg_attr(not(any(feature = "desktop", test)), allow(dead_code))]
impl MediaServer {
    fn bind() -> Result<Self, String> {
        Self::bind_with_limit(MAX_CONCURRENT_CONNECTIONS)
    }

    pub(crate) fn bind_with_limit(max_connections: usize) -> Result<Self, String> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "Could not bind desktop media server".to_owned())?;
        let port = listener
            .local_addr()
            .map_err(|_| "Could not read media server port".to_owned())?
            .port();
        let mut bytes = [0u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|_| "Could not initialize media server token".to_owned())?;
        let token: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        Ok(Self {
            listener,
            port,
            token,
            max_connections: max_connections.max(1),
        })
    }

    pub fn start(db_path: PathBuf) -> Result<MediaServerHandle, String> {
        Self::start_with_binder(db_path, Self::bind)
    }

    fn start_with_binder(
        db_path: PathBuf,
        bind: impl FnOnce() -> Result<Self, String>,
    ) -> Result<MediaServerHandle, String> {
        bind()?.start_bound(db_path, READ_TIMEOUT)
    }

    fn start_bound(
        self,
        db_path: PathBuf,
        header_timeout: Duration,
    ) -> Result<MediaServerHandle, String> {
        self.start_with_spawner(db_path, header_timeout, |job| {
            thread::Builder::new()
                .name("helia-media-accept".into())
                .spawn(job)
        })
    }

    fn start_with_spawner(
        self,
        db_path: PathBuf,
        header_timeout: Duration,
        spawn: impl FnOnce(Box<dyn FnOnce() + Send>) -> std::io::Result<JoinHandle<()>>,
    ) -> Result<MediaServerHandle, String> {
        self.listener
            .set_nonblocking(true)
            .map_err(|_| "Could not initialize media listener".to_owned())?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let active = Arc::new(AtomicUsize::new(0));
        #[cfg(test)]
        let chunk_reads = Arc::new(AtomicUsize::new(0));
        let config = Arc::new(ServerConfig {
            db_path,
            expected_host: format!("127.0.0.1:{}", self.port),
            token: self.token.clone(),
            shutdown: Arc::clone(&shutdown),
            header_timeout,
            #[cfg(test)]
            chunk_reads: Arc::clone(&chunk_reads),
        });
        let loop_shutdown = Arc::clone(&shutdown);
        let loop_active = Arc::clone(&active);
        let limit = self.max_connections;
        let listener = self.listener;
        let accept_thread = spawn(Box::new(move || {
            accept_loop(listener, config, loop_shutdown, loop_active, limit)
        }))
        .map_err(|_| "Could not start media server".to_owned())?;
        Ok(MediaServerHandle {
            port: self.port,
            token: self.token,
            shutdown,
            active,
            #[cfg(test)]
            chunk_reads,
            accept_thread: Some(accept_thread),
        })
    }
}

#[cfg_attr(not(test), allow(dead_code))]
impl MediaServerHandle {
    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}/{}", self.port, self.token)
    }

    /// Only a successfully started server can publish its URL.
    pub fn initialization_script(&self) -> String {
        format!(
            r#";(() => {{
            if (window !== window.top) return;
            Object.defineProperty(window, '__HELIA_MEDIA_BASE__', {{
                value: "{}",
                writable: false, configurable: false
            }});
        }})();"#,
            self.base_url()
        )
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    pub fn active_connections(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(crate) fn chunk_reads(&self) -> usize {
        self.chunk_reads.load(Ordering::Acquire)
    }
}

impl Drop for MediaServerHandle {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        if let Some(handle) = self.accept_thread.take() {
            let _ = handle.join();
        }
    }
}

fn accept_loop(
    listener: TcpListener,
    config: Arc<ServerConfig>,
    shutdown: Arc<AtomicBool>,
    active: Arc<AtomicUsize>,
    limit: usize,
) {
    let mut workers = Vec::new();
    while !shutdown.load(Ordering::Acquire) {
        reap_workers(&mut workers);
        let (mut stream, _) = match listener.accept() {
            Ok(incoming) => incoming,
            Err(_) => {
                thread::sleep(ACCEPT_POLL_INTERVAL);
                continue;
            }
        };
        if stream.set_nonblocking(false).is_err() {
            continue;
        }
        let Some(guard) = ActiveGuard::try_acquire(&active, limit) else {
            reject_busy(&mut stream, &shutdown);
            continue;
        };
        let Ok(socket) = stream.try_clone() else {
            continue;
        };
        let worker_config = Arc::clone(&config);
        if let Ok(worker) = thread::Builder::new()
            .name("helia-media-worker".into())
            .spawn(move || {
                let _guard = guard;
                handle_connection(stream, &worker_config);
            })
        {
            workers.push(Worker {
                socket,
                thread: worker,
            });
        }
    }
    for worker in &workers {
        let _ = worker.socket.shutdown(Shutdown::Both);
    }
    let deadline = Instant::now() + SHUTDOWN_TIMEOUT;
    while !workers.is_empty() && Instant::now() < deadline {
        reap_workers(&mut workers);
        if !workers.is_empty() {
            thread::sleep(ACCEPT_POLL_INTERVAL);
        }
    }
    // A stuck OS/SQLite operation must not block application shutdown indefinitely.
    if !workers.is_empty() {
        eprintln!("Media workers did not finish before the shutdown deadline");
    }
}

fn reap_workers(workers: &mut Vec<Worker>) {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].thread.is_finished() {
            let worker = workers.swap_remove(index);
            let _ = worker.thread.join();
        } else {
            index += 1;
        }
    }
}

fn reject_busy(stream: &mut TcpStream, shutdown: &AtomicBool) {
    let _ = stream.set_write_timeout(Some(BUSY_WRITE_TIMEOUT));
    let _ = stream.write_all(BUSY_RESPONSE);
    let _ = stream.shutdown(Shutdown::Write);
    // Briefly drain ordinary request bytes to preserve the 503 instead of a TCP reset.
    let deadline = Instant::now() + BUSY_WRITE_TIMEOUT;
    let mut remaining = MAX_REQUEST_HEAD_BYTES;
    let mut drain = [0u8; 512];
    while remaining > 0 && !shutdown.load(Ordering::Acquire) {
        let Some(timeout) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        if stream.set_read_timeout(Some(timeout)).is_err() {
            break;
        }
        match stream.read(&mut drain) {
            Ok(0) | Err(_) => break,
            Ok(count) => remaining = remaining.saturating_sub(count),
        }
    }
    let _ = stream.shutdown(Shutdown::Both);
}

fn handle_connection(mut stream: TcpStream, config: &ServerConfig) {
    let _ = stream.set_nodelay(true);
    if stream.set_write_timeout(Some(IO_POLL_INTERVAL)).is_err() {
        return;
    }
    let head = match read_request_head(&mut stream, config.header_timeout, &config.shutdown) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return,
        Err(ParseError::HeaderTooLarge) => {
            send_empty(&mut stream, "431 Request Header Fields Too Large", &[]);
            return;
        }
        Err(_) => {
            send_empty(&mut stream, "400 Bad Request", &[]);
            return;
        }
    };
    let request = match parse_request(&head, &config.expected_host) {
        Ok(parsed) => parsed,
        Err(ParseError::BadRequest) => {
            send_empty(&mut stream, "400 Bad Request", &[]);
            return;
        }
        Err(ParseError::Forbidden) => {
            send_empty(&mut stream, "403 Forbidden", &[]);
            return;
        }
        Err(ParseError::MethodNotAllowed) => {
            send_empty(
                &mut stream,
                "405 Method Not Allowed",
                &[("Allow", "GET, HEAD")],
            );
            return;
        }
        Err(ParseError::HeaderTooLarge) => {
            send_empty(&mut stream, "431 Request Header Fields Too Large", &[]);
            return;
        }
    };
    if config.shutdown.load(Ordering::Acquire) {
        return;
    }
    let Some((game_id, hash)) = parse_media_path(&request.target, &config.token) else {
        send_empty(&mut stream, "404 Not Found", &[]);
        return;
    };
    let Ok(connection) = open_readonly(&config.db_path) else {
        send_empty(&mut stream, "404 Not Found", &[]);
        return;
    };
    if config.shutdown.load(Ordering::Acquire) {
        return;
    }
    let Ok(Some(media)) = runtime_content::open_media(&connection, game_id, hash) else {
        send_empty(&mut stream, "404 Not Found", &[]);
        return;
    };
    serve_open_media(&mut stream, &request, &media, config);
}

fn read_request_head(
    stream: &mut TcpStream,
    timeout: Duration,
    shutdown: &AtomicBool,
) -> Result<Option<Vec<u8>>, ParseError> {
    let deadline = Instant::now() + timeout;
    let mut buffer = Vec::with_capacity(1024);
    let mut scratch = [0u8; 1024];
    loop {
        if shutdown.load(Ordering::Acquire) {
            return Ok(None);
        }
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            return Ok(None);
        };
        if remaining.is_zero()
            || stream
                .set_read_timeout(Some(remaining.min(IO_POLL_INTERVAL)))
                .is_err()
        {
            return Ok(None);
        }
        let count = match stream.read(&mut scratch) {
            Ok(0) => {
                return if buffer.is_empty() {
                    Ok(None)
                } else {
                    Err(ParseError::BadRequest)
                };
            }
            Ok(n) => n,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {
                continue;
            }
            Err(_) => return Ok(None),
        };
        if Instant::now() >= deadline {
            return Ok(None);
        }
        if buffer.len().saturating_add(count) > MAX_REQUEST_HEAD_BYTES {
            return Err(ParseError::HeaderTooLarge);
        }
        buffer.extend_from_slice(&scratch[..count]);
        if let Some(pos) = find_header_end(&buffer) {
            buffer.truncate(pos);
            return Ok(Some(buffer));
        }
    }
}

fn find_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n")
}

fn parse_request(head: &[u8], expected_host: &str) -> Result<ParsedRequest, ParseError> {
    let text = std::str::from_utf8(head).map_err(|_| ParseError::BadRequest)?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next().ok_or(ParseError::BadRequest)?;
    let (method_str, target, version) = parse_request_line(request_line)?;
    if version != "HTTP/1.1" && version != "HTTP/1.0" {
        return Err(ParseError::BadRequest);
    }

    let mut host: Option<&str> = None;
    let mut range: Option<String> = None;
    let mut if_range: Option<String> = None;
    let mut if_none_match: Option<String> = None;
    let mut header_count = 0usize;

    for line in lines {
        header_count += 1;
        if header_count > MAX_HEADERS {
            return Err(ParseError::HeaderTooLarge);
        }
        let (name, value) = parse_header_line(line)?;
        if name.eq_ignore_ascii_case("host") {
            if host.is_some() {
                return Err(ParseError::BadRequest);
            }
            host = Some(value);
        } else if name.eq_ignore_ascii_case("range") {
            match range.as_mut() {
                Some(existing) => {
                    existing.push(',');
                    existing.push_str(value);
                }
                None => range = Some(value.to_owned()),
            }
        } else if name.eq_ignore_ascii_case("if-range") && if_range.is_none() {
            if_range = Some(value.to_owned());
        } else if name.eq_ignore_ascii_case("if-none-match") && if_none_match.is_none() {
            if_none_match = Some(value.to_owned());
        }
    }

    // Validate Host before method or path so cross-host/DNS-rebinding probes fail immediately.
    let Some(host_value) = host else {
        return Err(ParseError::BadRequest);
    };
    if host_value != expected_host {
        return Err(ParseError::Forbidden);
    }

    let method = match method_str {
        "GET" => Method::Get,
        "HEAD" => Method::Head,
        _ => return Err(ParseError::MethodNotAllowed),
    };

    Ok(ParsedRequest {
        method,
        target: target.to_owned(),
        range,
        if_range,
        if_none_match,
    })
}

fn parse_request_line(line: &str) -> Result<(&str, &str, &str), ParseError> {
    let mut parts = line.split(' ');
    let method = parts.next().ok_or(ParseError::BadRequest)?;
    let target = parts.next().ok_or(ParseError::BadRequest)?;
    let version = parts.next().ok_or(ParseError::BadRequest)?;
    if parts.next().is_some() || method.is_empty() || target.is_empty() || version.is_empty() {
        return Err(ParseError::BadRequest);
    }
    if !method
        .bytes()
        .all(|b| b.is_ascii_uppercase() || b == b'-' || b == b'_')
    {
        return Err(ParseError::BadRequest);
    }
    Ok((method, target, version))
}

fn parse_header_line(line: &str) -> Result<(&str, &str), ParseError> {
    let (name, raw_value) = line.split_once(':').ok_or(ParseError::BadRequest)?;
    if name.is_empty() || !name.bytes().all(is_header_name_byte) {
        return Err(ParseError::BadRequest);
    }
    let value = raw_value.trim_matches(|ch| ch == ' ' || ch == '\t');
    if value.bytes().any(|b| b < 0x20 && b != b'\t' || b == 0x7f) {
        return Err(ParseError::BadRequest);
    }
    Ok((name, value))
}

fn is_header_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric()
        || matches!(
            b,
            b'!' | b'#'
                | b'$'
                | b'%'
                | b'&'
                | b'\''
                | b'*'
                | b'+'
                | b'-'
                | b'.'
                | b'^'
                | b'_'
                | b'`'
                | b'|'
                | b'~'
        )
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&a, &b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    std::hint::black_box(diff) == 0
}

fn parse_media_path<'a>(target: &'a str, expected_token: &str) -> Option<(&'a str, &'a str)> {
    if !target.starts_with('/')
        || target
            .bytes()
            .any(|b| b <= 0x20 || b == 0x7f || b == b'#' || b == b'\\')
    {
        return None;
    }
    let path = target.split_once('?').map_or(target, |(p, _)| p);
    let mut segments = path.strip_prefix('/')?.split('/');
    let req_token = segments.next()?;
    let game_id = segments.next()?;
    let hash = segments.next()?;
    if segments.next().is_some() {
        return None;
    }
    if !constant_time_eq(req_token.as_bytes(), expected_token.as_bytes()) {
        return None;
    }
    if game_id.is_empty()
        || game_id.len() > 100
        || !game_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || !runtime_content::valid_hash(hash)
    {
        return None;
    }
    Some((game_id, hash))
}

fn open_readonly(path: &Path) -> Result<Connection, String> {
    // Open without SQLITE_OPEN_CREATE and enable query_only so WAL databases can be read
    // safely even when no writer currently holds -shm, while SQLite blocks any writes.
    let flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let connection =
        Connection::open_with_flags(path, flags).map_err(|_| "Media unavailable".to_owned())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|_| "Media unavailable".to_owned())?;
    connection
        .execute_batch("PRAGMA query_only=ON;")
        .map_err(|_| "Media unavailable".to_owned())?;
    Ok(connection)
}

/// Parses a single HTTP `Range` header with the exact same semantics as web U5a (`http-range.ts`).
fn parse_byte_range(header: Option<&str>, size: u64) -> RangeOutcome {
    let Some(trimmed) = header.map(str::trim) else {
        return RangeOutcome::Full;
    };
    if !trimmed
        .as_bytes()
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(b"bytes="))
    {
        return RangeOutcome::Full;
    }
    let spec = &trimmed[6..];
    let Some((start_str, end_str)) = spec.split_once('-') else {
        return RangeOutcome::Full;
    };
    if end_str.contains('-')
        || (start_str.is_empty() && end_str.is_empty())
        || !start_str.bytes().all(|b| b.is_ascii_digit())
        || !end_str.bytes().all(|b| b.is_ascii_digit())
    {
        return RangeOutcome::Full;
    }
    if start_str.is_empty() {
        if size == 0 || end_str.bytes().all(|b| b == b'0') {
            return RangeOutcome::Unsatisfiable;
        }
        let suffix = parse_decimal_clamped(end_str, size);
        return RangeOutcome::Partial {
            start: size.saturating_sub(suffix),
            end: size,
        };
    }
    let Some(start) = parse_decimal_below(start_str, size) else {
        return RangeOutcome::Unsatisfiable;
    };
    if end_str.is_empty() {
        return RangeOutcome::Partial { start, end: size };
    }
    let end_inclusive = parse_decimal_clamped(end_str, size.saturating_sub(1));
    if end_inclusive < start {
        return RangeOutcome::Unsatisfiable;
    }
    RangeOutcome::Partial {
        start,
        end: end_inclusive + 1,
    }
}

/// Parses a non-empty ASCII decimal string, returning `None` if `value >= limit`.
fn parse_decimal_below(digits: &str, limit: u64) -> Option<u64> {
    let mut acc = 0u64;
    for byte in digits.bytes() {
        let digit = u64::from(byte - b'0');
        acc = acc.checked_mul(10)?.checked_add(digit)?;
        if acc >= limit {
            return None;
        }
    }
    Some(acc)
}

/// Parses a non-empty ASCII decimal string, clamping any larger value (including overflow) to `cap`.
fn parse_decimal_clamped(digits: &str, cap: u64) -> u64 {
    let mut acc = 0u64;
    for byte in digits.bytes() {
        let digit = u64::from(byte - b'0');
        match acc.checked_mul(10).and_then(|v| v.checked_add(digit)) {
            Some(next) if next < cap => acc = next,
            _ => return cap,
        }
    }
    acc
}

fn serve_open_media(
    stream: &mut TcpStream,
    request: &ParsedRequest,
    media: &OpenMedia<'_>,
    config: &ServerConfig,
) {
    if media.object_id.is_none() {
        serve_v1_media(stream, request, media, config);
        return;
    }
    if request.if_none_match.as_deref() == Some(media.etag.as_str()) {
        let header = format_immutable_head("304 Not Modified", media, true, None, None);
        let _ = stream.write_all(header.as_bytes());
        return;
    }
    let range_header = match request.if_range.as_deref() {
        None => request.range.as_deref(),
        Some(tag) if tag == media.etag => request.range.as_deref(),
        Some(_) => None,
    };
    match parse_byte_range(range_header, media.size) {
        RangeOutcome::Unsatisfiable => {
            let content_range = format!("bytes */{}", media.size);
            let head = format!(
                "HTTP/1.1 416 Range Not Satisfiable\r\n\
Content-Type: {}\r\n\
Cross-Origin-Resource-Policy: cross-origin\r\n\
Cache-Control: no-store\r\n\
X-Content-Type-Options: nosniff\r\n\
Accept-Ranges: bytes\r\n\
Content-Range: {content_range}\r\n\
Content-Length: 0\r\n\
Connection: close\r\n\r\n",
                media.mime
            );
            let _ = stream.write_all(head.as_bytes());
        }
        RangeOutcome::Partial { start, end } => {
            let content_range = format!("bytes {}-{}/{}", start, end - 1, media.size);
            let head = format_immutable_head(
                "206 Partial Content",
                media,
                true,
                Some(&content_range),
                Some(end - start),
            );
            if stream.write_all(head.as_bytes()).is_err() || request.method == Method::Head {
                return;
            }
            if let Ok(chunks) = media.read(start, end) {
                stream_chunks(stream, chunks, config);
            }
        }
        RangeOutcome::Full => {
            let head = format_immutable_head("200 OK", media, true, None, Some(media.size));
            if stream.write_all(head.as_bytes()).is_err() || request.method == Method::Head {
                return;
            }
            if let Ok(chunks) = media.read(0, media.size) {
                stream_chunks(stream, chunks, config);
            }
        }
    }
}

fn serve_v1_media(
    stream: &mut TcpStream,
    request: &ParsedRequest,
    media: &OpenMedia<'_>,
    config: &ServerConfig,
) {
    if request.if_none_match.as_deref() == Some(media.etag.as_str()) {
        let header = format_immutable_head("304 Not Modified", media, false, None, None);
        let _ = stream.write_all(header.as_bytes());
        return;
    }
    let head = format_immutable_head("200 OK", media, false, None, Some(media.size));
    if stream.write_all(head.as_bytes()).is_err() || request.method == Method::Head {
        return;
    }
    if let Ok(chunks) = media.read(0, media.size) {
        if let Ok(mut writer) = SocketWriter::new(stream, &config.shutdown) {
            let _ = write_chunks(&mut writer, chunks, &config.shutdown, || {});
        }
    }
}

fn format_immutable_head(
    status: &str,
    media: &OpenMedia<'_>,
    accept_ranges: bool,
    content_range: Option<&str>,
    content_length: Option<u64>,
) -> String {
    let mut head = format!(
        "HTTP/1.1 {status}\r\n\
Content-Type: {}\r\n\
Cross-Origin-Resource-Policy: cross-origin\r\n\
Cache-Control: private, max-age=31536000, immutable\r\n\
X-Content-Type-Options: nosniff\r\n\
ETag: {}\r\n",
        media.mime, media.etag
    );
    if accept_ranges {
        head.push_str("Accept-Ranges: bytes\r\n");
    }
    if let Some(range) = content_range {
        head.push_str(&format!("Content-Range: {range}\r\n"));
    }
    if let Some(length) = content_length {
        head.push_str(&format!("Content-Length: {length}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    head
}

fn stream_chunks(stream: &mut TcpStream, chunks: MediaChunks<'_>, config: &ServerConfig) {
    #[cfg(test)]
    let on_chunk = || {
        config.chunk_reads.fetch_add(1, Ordering::Relaxed);
    };
    #[cfg(not(test))]
    let on_chunk = {
        let _ = config;
        || {}
    };
    if let Ok(mut writer) = SocketWriter::new(stream, &config.shutdown) {
        let _ = write_chunks(&mut writer, chunks, &config.shutdown, on_chunk);
    }
}

fn write_chunks<W: Write, F: FnMut()>(
    writer: &mut W,
    mut chunks: MediaChunks<'_>,
    shutdown: &AtomicBool,
    mut on_chunk: F,
) -> bool {
    while !shutdown.load(Ordering::Acquire) {
        let Some(chunk) = chunks.next() else {
            return writer.flush().is_ok();
        };
        on_chunk();
        let Ok(bytes) = chunk else {
            return false;
        };
        for slice in bytes.chunks(WRITE_SLICE_BYTES) {
            if shutdown.load(Ordering::Acquire) || writer.write_all(slice).is_err() {
                return false;
            }
        }
    }
    false
}

fn send_empty(stream: &mut TcpStream, status: &str, extra: &[(&str, &str)]) {
    let mut head = format!(
        "HTTP/1.1 {status}\r\n\
Content-Length: 0\r\n\
Cache-Control: no-store\r\n\
X-Content-Type-Options: nosniff\r\n"
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("Connection: close\r\n\r\n");
    let _ = stream.write_all(head.as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_identity::MediaIdentity;
    use crate::storage;
    use rusqlite::params;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicUsize;

    struct TestDb {
        path: PathBuf,
        connection: Option<Connection>,
    }

    impl std::ops::Deref for TestDb {
        type Target = Connection;
        fn deref(&self) -> &Connection {
            self.connection.as_ref().unwrap()
        }
    }

    impl Drop for TestDb {
        fn drop(&mut self) {
            self.connection.take();
            for suffix in ["", "-wal", "-shm"] {
                let mut name = self.path.clone().into_os_string();
                name.push(suffix);
                let _ = std::fs::remove_file(name);
            }
        }
    }

    fn test_db() -> TestDb {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "helia-media-server-{}-{}.sqlite",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let db = storage::open(&path).unwrap();
        for id in ["one", "two"] {
            db.execute("INSERT INTO games(id,value) VALUES(?1,'{}')", [id])
                .unwrap();
        }
        TestDb {
            path,
            connection: Some(db),
        }
    }

    fn seed_v2(
        db: &Connection,
        game_id: &str,
        mime: &str,
        bytes: &[u8],
        object_id: &str,
    ) -> (String, String) {
        let mut identity = MediaIdentity::new(game_id, mime);
        identity.update(bytes).unwrap();
        let digest = identity.digest();
        db.execute(
            "INSERT INTO media_objects(id,game_id,state,size,chunk_size,sha256,crc32,created_at) VALUES(?1,?2,'ready',?3,1048576,?4,?5,'now')",
            params![object_id, game_id, bytes.len() as i64, digest.raw, digest.crc],
        )
        .unwrap();
        for (index, chunk) in bytes.chunks(1_048_576).enumerate() {
            let mut chunk_id = MediaIdentity::new(game_id, mime);
            chunk_id.update(chunk).unwrap();
            db.execute(
                "INSERT INTO media_chunks VALUES(?1,?2,?3,?4)",
                params![object_id, index as i64, chunk_id.digest().raw, chunk],
            )
            .unwrap();
        }
        let blob = json!({
            "schemaVersion": 2,
            "id": digest.blob_id,
            "gameId": game_id,
            "mime": mime,
            "object": digest.raw,
            "size": bytes.len()
        });
        db.execute(
            "INSERT OR REPLACE INTO blobs VALUES(?1,?2,?3)",
            params![digest.blob_id, game_id, blob.to_string()],
        )
        .unwrap();
        for hash in [&digest.asset_hash, &digest.blob_id] {
            db.execute(
                "INSERT OR REPLACE INTO runtime_assets VALUES(?1,?2,?3)",
                params![game_id, hash, digest.blob_id],
            )
            .unwrap();
        }
        (digest.blob_id, digest.asset_hash)
    }

    struct HttpResponse {
        status: u16,
        headers: HashMap<String, String>,
        body: Vec<u8>,
    }

    fn send_raw(port: u16, raw: &str) -> HttpResponse {
        send_raw_bytes(port, raw.as_bytes())
    }

    fn send_raw_bytes(port: u16, raw: &[u8]) -> HttpResponse {
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        stream.write_all(raw).unwrap();
        let mut response = Vec::new();
        stream.read_to_end(&mut response).unwrap();
        let split = find_header_end(&response).expect("HTTP response should contain header end");
        let head = std::str::from_utf8(&response[..split]).unwrap();
        let mut lines = head.split("\r\n");
        let status_line = lines.next().unwrap();
        let status = status_line
            .split_whitespace()
            .nth(1)
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let mut headers = HashMap::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(':') {
                headers.insert(name.to_ascii_lowercase(), value.trim().to_owned());
            }
        }
        HttpResponse {
            status,
            headers,
            body: response[split + 4..].to_vec(),
        }
    }

    fn request(
        server: &MediaServerHandle,
        method: &str,
        path: &str,
        extra_headers: &[(&str, &str)],
    ) -> HttpResponse {
        let mut raw = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n",
            server.port()
        );
        for (name, value) in extra_headers {
            raw.push_str(&format!("{name}: {value}\r\n"));
        }
        raw.push_str("\r\n");
        send_raw(server.port(), &raw)
    }

    #[test]
    fn rejects_invalid_host_method_token_and_path() {
        let db = test_db();
        let (blob_id, _) = seed_v2(&db, "one", "video/mp4", b"hello world", "obj-1");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let valid_path = format!("/{}/one/{blob_id}", server.token());

        // Missing Host -> 400
        let res = send_raw(server.port(), &format!("GET {valid_path} HTTP/1.1\r\n\r\n"));
        assert_eq!(res.status, 400);

        // Duplicate Host -> 400
        let res = send_raw(
            server.port(),
            &format!(
                "GET {valid_path} HTTP/1.1\r\nHost: 127.0.0.1:{0}\r\nHost: 127.0.0.1:{0}\r\n\r\n",
                server.port()
            ),
        );
        assert_eq!(res.status, 400);

        // Wrong Host values -> 403
        for bad_host in [
            format!("localhost:{}", server.port()),
            "127.0.0.1".to_owned(),
            format!("127.0.0.1:{}", server.port().wrapping_add(1)),
            "evil.example".to_owned(),
            "[::1]:80".to_owned(),
        ] {
            let res = send_raw(
                server.port(),
                &format!("GET {valid_path} HTTP/1.1\r\nHost: {bad_host}\r\n\r\n"),
            );
            assert_eq!(res.status, 403, "Host {bad_host} must be rejected");
        }

        // Non-GET/HEAD methods -> 405
        for method in ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"] {
            let res = request(&server, method, &valid_path, &[]);
            assert_eq!(res.status, 405, "Method {method} must be rejected");
            assert_eq!(
                res.headers.get("allow").map(String::as_str),
                Some("GET, HEAD")
            );
        }

        // Token mismatch and malformed/unknown paths -> 404
        let wrong_token = "0".repeat(64);
        for bad_path in [
            format!("/{wrong_token}/one/{blob_id}"),
            format!("/{}/one/{blob_id}/extra", server.token()),
            format!("/{}/one", server.token()),
            "/".to_owned(),
            format!("/{}/../one/{blob_id}", server.token()),
            format!("/{}/bad$game/{blob_id}", server.token()),
            format!("/{}/one/not-a-hash", server.token()),
            format!("/{}/one/{}", server.token(), "f".repeat(64)),
        ] {
            let res = request(&server, "GET", &bad_path, &[]);
            assert_eq!(res.status, 404, "Path {bad_path} must return 404");
            assert!(res.body.is_empty());
        }
    }

    #[test]
    fn enforces_game_scoping_and_mime_allowlist() {
        let db = test_db();
        let (blob_id, asset_hash) = seed_v2(&db, "one", "image/png", b"png-bytes", "obj-1");
        let server = MediaServer::start(db.path.clone()).unwrap();

        // Same game succeeds for both blob_id and asset_hash
        for hash in [&blob_id, &asset_hash] {
            let res = request(
                &server,
                "GET",
                &format!("/{}/one/{hash}", server.token()),
                &[],
            );
            assert_eq!(res.status, 200);
            assert_eq!(res.body, b"png-bytes");
        }

        // Another game is rejected with 404
        let other = request(
            &server,
            "GET",
            &format!("/{}/two/{blob_id}", server.token()),
            &[],
        );
        assert_eq!(other.status, 404);
        assert!(other.body.is_empty());

        // Unsupported MIME is rejected with 404
        db.execute(
            "UPDATE blobs SET value=json_set(value,'$.mime','text/html') WHERE id=?1",
            [&blob_id],
        )
        .unwrap();
        let unsafe_res = request(
            &server,
            "GET",
            &format!("/{}/one/{blob_id}", server.token()),
            &[],
        );
        assert_eq!(unsafe_res.status, 404);
    }

    #[test]
    fn supports_web_u5a_range_semantics_head_if_range_and_304() {
        let db = test_db();
        let bytes: Vec<u8> = (0u8..19).collect();
        let (blob_id, asset_hash) = seed_v2(&db, "one", "video/mp4", &bytes, "obj-range");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let path = format!("/{}/one/{asset_hash}", server.token());

        // Full 200 + headers
        let full = request(&server, "GET", &path, &[]);
        assert_eq!(full.status, 200);
        assert_eq!(full.body, bytes);
        assert_eq!(full.headers["content-type"], "video/mp4");
        assert_eq!(full.headers["accept-ranges"], "bytes");
        assert_eq!(full.headers["content-length"], "19");
        assert_eq!(full.headers["etag"], format!("\"{asset_hash}\""));
        assert_eq!(full.headers["x-content-type-options"], "nosniff");
        assert_eq!(
            full.headers["cache-control"],
            "private, max-age=31536000, immutable"
        );
        assert_eq!(full.headers["cross-origin-resource-policy"], "cross-origin");

        // HEAD reads zero chunks and returns exact length
        let before_head = server.chunk_reads();
        let head = request(&server, "HEAD", &path, &[]);
        assert_eq!(head.status, 200);
        assert_eq!(head.headers["content-length"], "19");
        assert!(head.body.is_empty());
        let head_range = request(&server, "HEAD", &path, &[("Range", "bytes=3-7")]);
        assert_eq!(head_range.status, 206);
        assert_eq!(head_range.headers["content-range"], "bytes 3-7/19");
        assert_eq!(head_range.headers["content-length"], "5");
        assert!(head_range.body.is_empty());
        assert_eq!(server.chunk_reads(), before_head);

        // Single valid ranges -> 206
        for (range, start, end) in [
            ("bytes=0-0", 0usize, 1usize),
            ("bytes=3-7", 3, 8),
            ("bytes=18-18", 18, 19),
            ("bytes=18-", 18, 19),
            ("bytes=3-", 3, 19),
            ("bytes=-4", 15, 19),
            ("bytes=-1", 18, 19),
            ("bytes=-9999999999999999999999999", 0, 19),
            ("bytes=4-9999999999999999999999999", 4, 19),
            ("bytes=00003-00007", 3, 8),
        ] {
            let res = request(&server, "GET", &path, &[("Range", range)]);
            assert_eq!(res.status, 206, "Range {range}");
            assert_eq!(
                res.headers["content-range"],
                format!("bytes {}-{}/19", start, end - 1)
            );
            assert_eq!(res.headers["content-length"], (end - start).to_string());
            assert_eq!(res.body, bytes[start..end]);
        }

        // Unsatisfiable ranges -> 416 without reading chunks
        let before_416 = server.chunk_reads();
        for range in [
            "bytes=19-",
            "bytes=19-20",
            "bytes=9-3",
            "bytes=-0",
            "bytes=999999999999999999999-",
        ] {
            let res = request(&server, "GET", &path, &[("Range", range)]);
            assert_eq!(res.status, 416, "Range {range}");
            assert_eq!(res.headers["content-range"], "bytes */19");
            assert_eq!(res.headers["content-length"], "0");
            assert_eq!(res.headers["cache-control"], "no-store");
            assert!(!res.headers.contains_key("etag"));
            assert!(res.body.is_empty());
        }
        assert_eq!(server.chunk_reads(), before_416);

        // Multi-range / malformed -> 200 full
        for range in [
            "bytes=0-1,4-5",
            "items=0-1",
            "bytes=bad",
            "bytes=-",
            "bytes=1.5-3",
        ] {
            let res = request(&server, "GET", &path, &[("Range", range)]);
            assert_eq!(res.status, 200, "Range {range}");
            assert!(!res.headers.contains_key("content-range"));
            assert_eq!(res.body, bytes);
        }

        // If-Range: strong match -> 206; mismatch / weak / date -> 200 full
        for (validator, expect_206) in [
            (format!("\"{asset_hash}\""), true),
            ("\"other\"".to_owned(), false),
            (format!("W/\"{asset_hash}\""), false),
            ("Fri, 27 Nov 2026 00:00:00 GMT".to_owned(), false),
        ] {
            let res = request(
                &server,
                "GET",
                &path,
                &[("Range", "bytes=1-2"), ("If-Range", &validator)],
            );
            assert_eq!(res.status, if expect_206 { 206 } else { 200 });
            assert_eq!(res.body, if expect_206 { &bytes[1..3] } else { &bytes[..] });
        }

        // If-None-Match checked before Range -> 304 without reading chunks
        let before_304 = server.chunk_reads();
        let cached = request(
            &server,
            "GET",
            &path,
            &[
                ("If-None-Match", &format!("\"{asset_hash}\"")),
                ("Range", "bytes=999-"),
            ],
        );
        assert_eq!(cached.status, 304);
        assert!(cached.body.is_empty());
        assert_eq!(server.chunk_reads(), before_304);

        // Direct blob_id lookup works identically
        let direct = request(
            &server,
            "GET",
            &format!("/{}/one/{blob_id}", server.token()),
            &[("Range", "bytes=0-3")],
        );
        assert_eq!(direct.status, 206);
        assert_eq!(direct.body, bytes[0..4]);
    }

    #[test]
    fn streams_across_chunk_boundaries_without_reading_unrelated_chunks() {
        let db = test_db();
        let size = 2 * 1_048_576 + 17;
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let (blob_id, _) = seed_v2(&db, "one", "video/webm", &bytes, "obj-chunks");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let path = format!("/{}/one/{blob_id}", server.token());

        // Cross chunk 0 / chunk 1 boundary: reads only 2 chunks (not chunk 2)
        let res = request(&server, "GET", &path, &[("Range", "bytes=1048573-1048579")]);
        assert_eq!(res.status, 206);
        assert_eq!(
            res.headers["content-range"],
            format!("bytes 1048573-1048579/{size}")
        );
        assert_eq!(res.body, bytes[1_048_573..=1_048_579]);
        assert_eq!(server.chunk_reads(), 2);

        // Small (<= 4 MiB) full 200 response returns all bytes intact
        let full = request(&server, "GET", &path, &[]);
        assert_eq!(full.status, 200);
        assert_eq!(full.body, bytes);
    }

    #[test]
    fn stops_reading_chunks_when_writer_or_client_disconnects() {
        let db = test_db();
        let chunk_count = 6;
        let bytes = vec![42u8; chunk_count * 1_048_576];
        let (blob_id, _) = seed_v2(&db, "one", "video/mp4", &bytes, "obj-abort");

        // Deterministic writer-error test: fail immediately on the 2nd write slice.
        struct FailingWriter {
            writes: usize,
        }
        impl Write for FailingWriter {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.writes += 1;
                if self.writes >= 2 {
                    return Err(std::io::Error::new(ErrorKind::BrokenPipe, "disconnected"));
                }
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let media = runtime_content::open_media(&db, "one", &blob_id)
            .unwrap()
            .unwrap();
        let mut reads = 0usize;
        let mut writer = FailingWriter { writes: 0 };
        let completed = write_chunks(
            &mut writer,
            media.read(0, media.size).unwrap(),
            &AtomicBool::new(false),
            || {
                reads += 1;
            },
        );
        assert!(!completed);
        assert_eq!(
            reads, 1,
            "Must stop after the chunk whose socket write failed"
        );

        // Real TCP disconnect test on a larger multi-chunk object (32 MiB).
        let big_bytes = vec![7u8; 32 * 1_048_576];
        let (big_id, _) = seed_v2(&db, "one", "video/mp4", &big_bytes, "obj-big");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let mut stream = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        let req = format!(
            "GET /{}/one/{big_id} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            server.token(),
            server.port()
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut first = [0u8; 256];
        let n = stream.read(&mut first).unwrap();
        assert!(n > 0);
        // Drop socket immediately without draining remaining 32 MiB
        drop(stream);

        // Wait for the server worker to observe the disconnect and exit
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while server.active_connections() > 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(server.active_connections(), 0);
        assert!(
            server.chunk_reads() < 32,
            "Expected DB chunk reads to stop early on disconnect, got {}",
            server.chunk_reads()
        );
    }

    #[test]
    fn enforces_concurrency_limit_and_recovers() {
        let db = test_db();
        let (blob_id, _) = seed_v2(&db, "one", "image/png", b"ok", "obj-cap");
        let server = MediaServer::bind_with_limit(1)
            .unwrap()
            .start_bound(db.path.clone(), READ_TIMEOUT)
            .unwrap();

        // Hold the sole connection slot open without sending headers
        let stalled = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while server.active_connections() == 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(server.active_connections(), 1);

        // Second concurrent connection immediately gets 503
        let busy = request(
            &server,
            "GET",
            &format!("/{}/one/{blob_id}", server.token()),
            &[],
        );
        assert_eq!(busy.status, 503);

        // Release slot and verify subsequent request succeeds
        drop(stalled);
        while server.active_connections() > 0 && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(5));
        }
        let ok = request(
            &server,
            "GET",
            &format!("/{}/one/{blob_id}", server.token()),
            &[],
        );
        assert_eq!(ok.status, 200);
        assert_eq!(ok.body, b"ok");
    }

    #[test]
    fn preserves_v1_blob_bytes_and_headers_and_existing_scheme() {
        let db = test_db();
        let data = "data:image/png;base64,AAEC/w==";
        let id = runtime_content::asset(&db, "one", "image/png", data).unwrap();
        let server = MediaServer::start(db.path.clone()).unwrap();
        let path = format!("/{}/one/{id}", server.token());

        // Loopback serves v1 with exact bytes, ignoring Range/If-Range (matching web U5a)
        let res = request(
            &server,
            "GET",
            &path,
            &[("Range", "bytes=1-2"), ("If-Range", &format!("\"{id}\""))],
        );
        assert_eq!(res.status, 200);
        assert_eq!(res.body, vec![0, 1, 2, 255]);
        assert_eq!(res.headers["content-type"], "image/png");
        assert_eq!(res.headers["x-content-type-options"], "nosniff");
        assert!(!res.headers.contains_key("accept-ranges"));

        // If-None-Match -> 304
        let cached = request(
            &server,
            "GET",
            &path,
            &[("If-None-Match", &format!("\"{id}\""))],
        );
        assert_eq!(cached.status, 304);
        assert!(cached.body.is_empty());

        // Legacy helia-media scheme response remains unchanged
        let legacy = runtime_content::media_response(&db.path, &format!("/one/{id}"));
        assert_eq!(legacy.status(), 200);
        assert_eq!(legacy.body(), &vec![0, 1, 2, 255]);
    }

    #[test]
    fn generates_distinct_32_byte_tokens_and_main_frame_init_script() {
        let db = test_db();
        let first = MediaServer::start(db.path.clone()).unwrap();
        let second = MediaServer::start(db.path.clone()).unwrap();
        assert_eq!(first.token().len(), 64);
        assert!(first.token().bytes().all(|b| b.is_ascii_hexdigit()));
        assert_ne!(first.token(), second.token());
        assert_ne!(first.port(), 0);
        let script = first.initialization_script();
        assert!(script.contains("if (window !== window.top) return;"));
        assert!(script.contains("__HELIA_MEDIA_BASE__"));
        assert!(script.contains(&first.base_url()));
    }

    fn wait_until(mut ready: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(2);
        while !ready() {
            assert!(
                Instant::now() < deadline,
                "Timed out waiting for worker state"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn drop_with_deadline(server: MediaServerHandle) {
        let (sender, receiver) = std::sync::mpsc::channel();
        thread::spawn(move || {
            drop(server);
            let _ = sender.send(());
        });
        receiver
            .recv_timeout(Duration::from_secs(1))
            .expect("Media server shutdown must not wait for clients");
    }

    fn drip(mut stream: TcpStream, interval: Duration) -> JoinHandle<()> {
        thread::spawn(move || {
            stream
                .set_write_timeout(Some(Duration::from_millis(100)))
                .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                if stream.write_all(b"x").is_err() {
                    return;
                }
                thread::sleep(interval);
            }
        })
    }

    #[test]
    fn busy_client_cannot_block_accept_or_shutdown_by_continuing_to_write() {
        let db = test_db();
        let (id, _) = seed_v2(&db, "one", "image/png", b"ok", "busy-spam");
        let server = MediaServer::bind_with_limit(1)
            .unwrap()
            .start_bound(db.path.clone(), READ_TIMEOUT)
            .unwrap();
        let stalled = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        wait_until(|| server.active_connections() == 1);
        let mut excess = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        excess
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let spam = drip(excess.try_clone().unwrap(), Duration::from_millis(1));
        let mut response = Vec::new();
        // A close with unread input may be reported as a reset after the response.
        let _ = excess.read_to_end(&mut response);
        assert!(response.starts_with(b"HTTP/1.1 503"));
        drop(stalled);
        wait_until(|| server.active_connections() == 0);
        let started = Instant::now();
        let response = request(
            &server,
            "GET",
            &format!("/{}/one/{id}", server.token()),
            &[],
        );
        assert_eq!(response.status, 200);
        assert!(started.elapsed() < Duration::from_millis(500));
        drop_with_deadline(server);
        spam.join().unwrap();
    }

    #[test]
    fn busy_client_cannot_block_shutdown_while_all_slots_are_occupied() {
        let db = test_db();
        let server = MediaServer::bind_with_limit(1)
            .unwrap()
            .start_bound(db.path.clone(), READ_TIMEOUT)
            .unwrap();
        let _stalled = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        wait_until(|| server.active_connections() == 1);
        let mut excess = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        excess
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let spam = drip(excess.try_clone().unwrap(), Duration::from_millis(1));
        let mut status = [0; 12];
        excess.read_exact(&mut status).unwrap();
        assert_eq!(&status, b"HTTP/1.1 503");
        let active = Arc::clone(&server.active);
        drop_with_deadline(server);
        assert_eq!(active.load(Ordering::Acquire), 0);
        spam.join().unwrap();
    }

    #[test]
    fn header_deadline_expires_even_when_each_read_receives_a_byte() {
        let db = test_db();
        let (id, _) = seed_v2(&db, "one", "image/png", b"ok", "slow-headers");
        let server = MediaServer::bind_with_limit(1)
            .unwrap()
            .start_bound(db.path.clone(), Duration::from_millis(200))
            .unwrap();
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        let started = Instant::now();
        let slow = drip(client.try_clone().unwrap(), Duration::from_millis(20));
        wait_until(|| server.active_connections() == 1);
        let mut response = Vec::new();
        if let Err(error) = client.read_to_end(&mut response) {
            assert_eq!(error.kind(), ErrorKind::ConnectionReset);
        }
        assert!(response.is_empty());
        assert!(started.elapsed() < Duration::from_millis(750));
        wait_until(|| server.active_connections() == 0);
        assert_eq!(
            request(
                &server,
                "GET",
                &format!("/{}/one/{id}", server.token()),
                &[]
            )
            .status,
            200
        );
        slow.join().unwrap();
    }

    #[test]
    fn non_ascii_range_and_invalid_utf8_requests_never_panic() {
        let db = test_db();
        let (id, _) = seed_v2(&db, "one", "video/mp4", b"full media", "utf8-range");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let path = format!("/{}/one/{id}", server.token());
        for range in ["aaaaa가", "😀😀", "bytes=가-", "aaaaéxx"] {
            let response = request(&server, "GET", &path, &[("Range", range)]);
            assert_eq!(response.status, 200);
            assert_eq!(response.body, b"full media");
        }
        let mut invalid = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nRange: ",
            server.port()
        )
        .into_bytes();
        invalid.extend_from_slice(b"\xff\r\n\r\n");
        assert_eq!(send_raw_bytes(server.port(), &invalid).status, 400);
        assert_eq!(request(&server, "GET", &path, &[]).status, 200);
    }

    #[test]
    fn bind_and_thread_start_failures_publish_no_initialization_script() {
        let db = test_db();
        let bind_failure =
            MediaServer::start_with_binder(db.path.clone(), || Err("bind failed".into()));
        assert!(matches!(&bind_failure, Err(error) if error == "bind failed"));
        assert!(
            bind_failure
                .as_ref()
                .ok()
                .map(MediaServerHandle::initialization_script)
                .is_none()
        );
        let bound = MediaServer::bind().unwrap();
        let port = bound.port;
        let spawn_failure = bound.start_with_spawner(db.path.clone(), READ_TIMEOUT, |_| {
            Err(std::io::Error::other("thread creation failed"))
        });
        assert!(spawn_failure.is_err());
        assert!(
            spawn_failure
                .as_ref()
                .ok()
                .map(MediaServerHandle::initialization_script)
                .is_none()
        );
        assert!(
            TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err(),
            "Failed start must close the listener"
        );
    }

    #[test]
    fn shutdown_closes_header_and_slow_media_workers_and_their_database_connections() {
        let db = test_db();
        let bytes = vec![7; 32 * 1_048_576];
        let (id, _) = seed_v2(&db, "one", "video/mp4", &bytes, "shutdown-media");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let port = server.port();
        let mut header_client = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        header_client.write_all(b"GET /").unwrap();
        wait_until(|| server.active_connections() == 1);
        let mut media_client = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        media_client
            .set_read_timeout(Some(Duration::from_secs(1)))
            .unwrap();
        media_client
            .write_all(
                format!(
                    "GET /{}/one/{id} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                    server.token(),
                    server.port()
                )
                .as_bytes(),
            )
            .unwrap();
        let mut first = [0; 256];
        assert!(media_client.read(&mut first).unwrap() > 0);
        wait_until(|| server.chunk_reads() > 0 && server.active_connections() == 2);
        let active = Arc::clone(&server.active);
        let reads = Arc::clone(&server.chunk_reads);
        drop_with_deadline(server);
        assert_eq!(
            active.load(Ordering::Acquire),
            0,
            "Workers must release DB connections before shutdown completes"
        );
        let stopped_at = reads.load(Ordering::Acquire);
        assert!(
            stopped_at < 32,
            "Slow client must not cause the remaining object to be read"
        );
        header_client
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        assert_eq!(header_client.read(&mut first).unwrap(), 0);
        db.execute("UPDATE games SET value='{}' WHERE id='one'", [])
            .unwrap();
        assert!(TcpStream::connect((Ipv4Addr::LOCALHOST, port)).is_err());
    }

    #[test]
    fn media_client_can_resume_after_multiple_write_poll_intervals() {
        let db = test_db();
        let bytes = vec![7; 8 * 1_048_576];
        let (id, _) = seed_v2(&db, "one", "video/mp4", &bytes, "paused-media");
        let server = MediaServer::start(db.path.clone()).unwrap();
        let mut client = TcpStream::connect((Ipv4Addr::LOCALHOST, server.port())).unwrap();
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        client
            .write_all(
                format!(
                    "GET /{}/one/{id} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
                    server.token(),
                    server.port()
                )
                .as_bytes(),
            )
            .unwrap();
        wait_until(|| server.chunk_reads() > 0);
        thread::sleep(IO_POLL_INTERVAL * 4);
        assert_eq!(server.active_connections(), 1);
        let mut response = Vec::new();
        client.read_to_end(&mut response).unwrap();
        let split = find_header_end(&response).unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200"));
        assert_eq!(response.len() - split - 4, bytes.len());
        assert!(
            &response[split + 4..] == bytes.as_slice(),
            "Media bytes must match after a pause"
        );
    }

    #[test]
    fn cancelled_stream_does_not_read_another_database_chunk() {
        let db = test_db();
        let (id, _) = seed_v2(
            &db,
            "one",
            "video/mp4",
            &vec![7; 2 * 1_048_576],
            "cancel-chunks",
        );
        let media = runtime_content::open_media(&db, "one", &id)
            .unwrap()
            .unwrap();
        let shutdown = AtomicBool::new(true);
        let mut reads = 0;
        let mut writer = Vec::new();
        assert!(!write_chunks(
            &mut writer,
            media.read(0, media.size).unwrap(),
            &shutdown,
            || reads += 1
        ));
        assert_eq!(reads, 0);
        shutdown.store(false, Ordering::Release);
        assert!(!write_chunks(
            &mut writer,
            media.read(0, media.size).unwrap(),
            &shutdown,
            || {
                reads += 1;
                shutdown.store(true, Ordering::Release);
            }
        ));
        assert_eq!(reads, 1);
        assert!(writer.is_empty());
    }
}
