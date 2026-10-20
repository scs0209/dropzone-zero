// Zee is the one thing that has to be running: it starts what Dropzone Zero
// needs behind it, Ollama (the local model) and `dz daemon` (the watcher and its
// API), and stops whatever it started when it quits. Anything already running,
// say an Ollama started by `brew services`, is used as is and left alone.

use std::fs::{create_dir_all, OpenOptions};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const OLLAMA_PORT: u16 = 11434;

#[derive(Default)]
pub struct Services {
    daemon: Mutex<Option<Child>>,
    ollama: Mutex<Option<Child>>,
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_default())
}

/// The Dropzone Zero checkout this app was built from; the daemon runs from there.
fn repo_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest.join("../..").canonicalize().unwrap_or(manifest)
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

/// The daemon's port from its info file, if it wrote one.
fn daemon_port() -> Option<u16> {
    let text = std::fs::read_to_string(home().join(".dropzone-zero/daemon.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("port")?.as_u64().map(|p| p as u16)
}

pub fn daemon_reachable() -> bool {
    daemon_port().map(port_open).unwrap_or(false)
}

/// Apps opened at login get a bare PATH, so look where Homebrew, uv, and the system put things.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(':')
        .filter(|d| !d.is_empty())
        .map(PathBuf::from)
        .collect();
    for extra in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        dirs.push(PathBuf::from(extra));
    }
    dirs.push(home().join(".local/bin"));
    dirs
}

fn find(name: &str) -> Option<PathBuf> {
    search_dirs().into_iter().map(|d| d.join(name)).find(|p| p.is_file())
}

fn log_file(name: &str) -> Stdio {
    let dir = home().join("Library/Logs/dropzone-zero");
    let _ = create_dir_all(&dir);
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(name))
        .map(Stdio::from)
        .unwrap_or_else(|_| Stdio::null())
}

fn alive(slot: &Mutex<Option<Child>>) -> bool {
    let mut guard = slot.lock().unwrap();
    match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Asks a child to stop (SIGTERM, so the daemon can release its lock), then insists.
fn stop_child(slot: &Mutex<Option<Child>>) {
    let Some(mut child) = slot.lock().unwrap().take() else { return };
    let _ = Command::new("kill").args(["-TERM", &child.id().to_string()]).status();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Services {
    /// True while a daemon Zee started is still coming up.
    pub fn starting(&self) -> bool {
        alive(&self.daemon) && !daemon_reachable()
    }

    /// Starts Ollama and the daemon unless they are already running.
    pub fn ensure(&self) -> Result<(), String> {
        if !port_open(OLLAMA_PORT) && !alive(&self.ollama) {
            let ollama = find("ollama").ok_or("Ollama is not installed. Install it from https://ollama.com.")?;
            let child = Command::new(ollama)
                .arg("serve")
                .stdout(log_file("ollama.log"))
                .stderr(log_file("ollama.log"))
                .spawn()
                .map_err(|e| format!("Could not start Ollama: {e}"))?;
            *self.ollama.lock().unwrap() = Some(child);
        }

        if !daemon_reachable() && !alive(&self.daemon) {
            let node = find("node").ok_or("Node.js is not installed.")?;
            let repo = repo_root();
            let path = search_dirs().iter().map(|d| d.display().to_string()).collect::<Vec<_>>().join(":");
            let downloads = home().join("Downloads");
            let child = Command::new(node)
                .args(["--import", "tsx"])
                .arg(repo.join("src/cli.ts"))
                .arg("daemon")
                .arg(downloads)
                .current_dir(&repo)
                .env("PATH", path)
                .stdout(log_file("watch.log"))
                .stderr(log_file("watch.log"))
                .spawn()
                .map_err(|e| format!("Could not start the Dropzone Zero daemon: {e}"))?;
            *self.daemon.lock().unwrap() = Some(child);
        }
        Ok(())
    }

    /// Stops what Zee started, daemon first so it lets go of the folder cleanly.
    pub fn stop(&self) {
        stop_child(&self.daemon);
        stop_child(&self.ollama);
    }
}
