//! Installs the Python runtime and keeps the sidecar server alive. All TTS logic
//! lives in the sidecar so the UI and external agents use one and the same engine.
use serde::Serialize;
use std::collections::VecDeque;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const DEFAULT_PORT: u16 = 8765;
const PYTHON_VERSION: &str = "3.12";
const SERVER_START_TIMEOUT: Duration = Duration::from_secs(180);
const LOG_LINES_KEPT: usize = 400;

type Logs = Arc<Mutex<VecDeque<String>>>;

#[derive(Default)]
struct Sidecar {
    child: Mutex<Option<Child>>,
    logs: Logs,
}

#[derive(Clone, Serialize)]
struct ServerInfo {
    url: String,
}

fn port() -> u16 {
    std::env::var("VIENEU_TTS_PORT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(DEFAULT_PORT)
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn sidecar_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().resource_dir().map_err(|e| e.to_string())?.join("sidecar"))
}

fn venv_python(data: &Path) -> PathBuf {
    if cfg!(windows) {
        data.join("venv").join("Scripts").join("python.exe")
    } else {
        data.join("venv").join("bin").join("python")
    }
}

/// Marks a finished install and records which lock file it came from, so an app
/// update that changes dependencies installs again.
fn install_marker(data: &Path) -> PathBuf {
    data.join("venv").join(".installed-requirements.lock")
}

fn uv_file_name() -> &'static str {
    if cfg!(windows) { "uv.exe" } else { "uv" }
}

/// Apps opened from Finder do not inherit the shell PATH, so usual locations are checked too.
fn find_uv(data: &Path) -> Option<PathBuf> {
    let name = uv_file_name();
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from);
    let mut folders = vec![data.join("bin")];
    if let Some(path) = std::env::var_os("PATH") {
        folders.extend(std::env::split_paths(&path));
    }
    if let Some(home) = home {
        folders.push(home.join(".local").join("bin"));
        folders.push(home.join(".cargo").join("bin"));
    }
    folders.push("/opt/homebrew/bin".into());
    folders.push("/usr/local/bin".into());
    folders.into_iter().map(|folder| folder.join(name)).find(|path| path.is_file())
}

fn no_console(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = command;
}

fn record_line(app: &AppHandle, logs: &Logs, line: String) {
    let mut lines = logs.lock().unwrap();
    if lines.len() == LOG_LINES_KEPT {
        lines.pop_front();
    }
    lines.push_back(line.clone());
    drop(lines);
    let _ = app.emit("sidecar-log", line);
}

fn pipe_output(app: &AppHandle, logs: &Logs, stream: impl Read + Send + 'static) -> thread::JoinHandle<()> {
    let (app, logs) = (app.clone(), logs.clone());
    thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            record_line(&app, &logs, line);
        }
    })
}

fn run_step(app: &AppHandle, logs: &Logs, title: &str, mut command: Command) -> Result<(), String> {
    let _ = app.emit("setup-step", title);
    record_line(app, logs, format!("--- {title}"));
    no_console(&mut command);
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{title}: không chạy được lệnh: {e}"))?;
    let readers = [
        pipe_output(app, logs, child.stdout.take().unwrap()),
        pipe_output(app, logs, child.stderr.take().unwrap()),
    ];
    let status = child.wait().map_err(|e| e.to_string())?;
    for reader in readers {
        let _ = reader.join();
    }
    if status.success() {
        Ok(())
    } else {
        Err(format!("{title} thất bại ({status}). Xem nhật ký bên dưới."))
    }
}

fn install_uv(app: &AppHandle, logs: &Logs, data: &Path) -> Result<PathBuf, String> {
    let bin = data.join("bin");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let mut command = if cfg!(windows) {
        let mut c = Command::new("powershell");
        c.args(["-ExecutionPolicy", "ByPass", "-c", "irm https://astral.sh/uv/install.ps1 | iex"]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]);
        c
    };
    // Stays inside the app's folder: no change to the user's PATH or shell profile.
    command.env("UV_INSTALL_DIR", &bin).env("UV_NO_MODIFY_PATH", "1");
    run_step(app, logs, "Tải trình quản lý Python (uv)", command)?;
    let uv = bin.join(uv_file_name());
    if uv.is_file() {
        Ok(uv)
    } else {
        Err("Đã chạy bộ cài uv nhưng không thấy file uv.".into())
    }
}

#[tauri::command]
fn is_installed(app: AppHandle) -> Result<bool, String> {
    let data = data_dir(&app)?;
    let lock = fs::read(sidecar_dir(&app)?.join("requirements.lock")).map_err(|e| e.to_string())?;
    Ok(venv_python(&data).is_file() && fs::read(install_marker(&data)).is_ok_and(|done| done == lock))
}

#[tauri::command(async)]
fn install(app: AppHandle, sidecar: State<'_, Sidecar>) -> Result<(), String> {
    let data = data_dir(&app)?;
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    let lock_path = sidecar_dir(&app)?.join("requirements.lock");
    let logs = &sidecar.logs;

    let uv = match find_uv(&data) {
        Some(uv) => uv,
        None => install_uv(&app, logs, &data)?,
    };

    let uv_command = |args: &[&str]| {
        let mut command = Command::new(&uv);
        command.args(args).env("UV_PYTHON_INSTALL_DIR", data.join("python"));
        command
    };

    let venv = data.join("venv");
    let mut create = uv_command(&["venv", "--clear", "--python", PYTHON_VERSION]);
    create.arg(&venv);
    run_step(&app, logs, "Tạo môi trường Python", create)?;

    let mut deps = uv_command(&["pip", "install", "--python"]);
    deps.arg(venv_python(&data)).arg("-r").arg(&lock_path);
    run_step(&app, logs, "Cài VieNeu-TTS và thư viện", deps)?;

    fs::copy(&lock_path, install_marker(&data)).map_err(|e| e.to_string())?;
    Ok(())
}

fn tail_of_logs(logs: &Logs, count: usize) -> String {
    let lines = logs.lock().unwrap();
    let skip = lines.len().saturating_sub(count);
    lines.iter().skip(skip).cloned().collect::<Vec<_>>().join("\n")
}

/// Starts the server unless it already runs. Holding the lock for the whole call
/// makes a concurrent caller wait for this start instead of spawning a second one.
#[tauri::command(async)]
fn start_server(app: AppHandle, sidecar: State<'_, Sidecar>) -> Result<ServerInfo, String> {
    let data = data_dir(&app)?;
    let port = port();
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut guard = sidecar.child.lock().unwrap();

    let running = match guard.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(None)),
        None => false,
    };

    if !running {
        *guard = None;
        TcpListener::bind(address).map_err(|_| {
            format!("Cổng {port} đang được ứng dụng khác dùng. Hãy đóng ứng dụng đó, hoặc đặt biến môi trường VIENEU_TTS_PORT sang cổng khác rồi mở lại.")
        })?;

        let mut command = Command::new(venv_python(&data));
        command
            .arg(sidecar_dir(&app)?.join("server.py"))
            .arg("--data-dir")
            .arg(&data)
            .arg("--port")
            .arg(port.to_string())
            .arg("--exit-with-parent")
            // The app bundle is read-only and signed; do not write .pyc files into it.
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        no_console(&mut command);
        let mut child = command.spawn().map_err(|e| format!("Không khởi động được server: {e}"))?;
        pipe_output(&app, &sidecar.logs, child.stdout.take().unwrap());
        pipe_output(&app, &sidecar.logs, child.stderr.take().unwrap());

        let started = Instant::now();
        while TcpStream::connect_timeout(&address, Duration::from_millis(300)).is_err() {
            if let Ok(Some(status)) = child.try_wait() {
                return Err(format!("Server dừng khi khởi động ({status}).\n{}", tail_of_logs(&sidecar.logs, 15)));
            }
            if started.elapsed() > SERVER_START_TIMEOUT {
                let _ = child.kill();
                return Err("Server không phản hồi sau 3 phút.".into());
            }
            thread::sleep(Duration::from_millis(300));
        }
        *guard = Some(child);
    }

    Ok(ServerInfo { url: format!("http://127.0.0.1:{port}") })
}

#[tauri::command]
fn get_logs(sidecar: State<'_, Sidecar>) -> Vec<String> {
    sidecar.logs.lock().unwrap().iter().cloned().collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Sidecar::default())
        .invoke_handler(tauri::generate_handler![is_installed, install, start_server, get_logs])
        .build(tauri::generate_context!())
        .expect("error while building the app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app.state::<Sidecar>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
