#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD, Engine};
use quickcut_media::{MediaInfo, MediaTools, Range};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{Emitter, Manager, State};

struct EditorState {
    allowed: Mutex<HashSet<PathBuf>>,
    tools: Mutex<Option<MediaTools>>,
    jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    started: Instant,
}

impl EditorState {
    fn allowed_source(&self, path: &str) -> Result<PathBuf, String> {
        let path = std::fs::canonicalize(path).map_err(|e| format!("Cannot open video: {e}"))?;
        if !self
            .allowed
            .lock()
            .map_err(|_| "Source state unavailable.")?
            .contains(&path)
        {
            return Err("Open the video before requesting media operations.".into());
        }
        Ok(path)
    }
    fn media_tools(&self, app: &tauri::AppHandle) -> Result<MediaTools, String> {
        let mut tools = self.tools.lock().map_err(|_| "Media engine unavailable.")?;
        if tools.is_none() {
            *tools = Some(MediaTools::discover(
                app.path().resource_dir().ok().as_deref(),
            )?);
        }
        Ok(tools.as_ref().unwrap().clone())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExportProgress {
    job_id: String,
    percent: f64,
    stage: String,
    done: bool,
    cancelled: bool,
    error: Option<String>,
    output: Option<String>,
    actual_ranges: Option<Vec<Range>>,
}
#[derive(Clone, Serialize)]
struct MediaDrop {
    paths: Option<Vec<String>>,
    hover: bool,
}

#[tauri::command]
fn grant_media(
    app: tauri::AppHandle,
    state: State<EditorState>,
    path: String,
) -> Result<String, String> {
    let source = std::fs::canonicalize(&path).map_err(|e| format!("Cannot open video: {e}"))?;
    if !source.is_file() {
        return Err("Drop a video file, not a folder.".into());
    }
    let extension = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["mp4", "mov", "mkv", "m4v"].contains(&extension.as_str()) {
        return Err("Open an MP4, MOV, or MKV video.".into());
    }
    app.asset_protocol_scope()
        .allow_file(&source)
        .map_err(|e| e.to_string())?;
    state
        .allowed
        .lock()
        .map_err(|_| "Source state unavailable.")?
        .insert(source.clone());
    Ok(source.to_string_lossy().into_owned())
}

#[tauri::command]
async fn probe_media(
    app: tauri::AppHandle,
    state: State<'_, EditorState>,
    path: String,
) -> Result<MediaInfo, String> {
    let source = state.allowed_source(&path)?;
    let tools = state.media_tools(&app)?;
    tauri::async_runtime::spawn_blocking(move || tools.probe(&source))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn extract_frame(
    app: tauri::AppHandle,
    state: State<'_, EditorState>,
    path: String,
    time: f64,
    accurate: bool,
) -> Result<String, String> {
    let source = state.allowed_source(&path)?;
    let tools = state.media_tools(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        tools
            .frame(&source, time, accurate)
            .map(|frame| STANDARD.encode(frame))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn start_export(
    app: tauri::AppHandle,
    state: State<EditorState>,
    path: String,
    output: String,
    ranges: Vec<Range>,
    duration: f64,
    job_id: String,
) -> Result<(), String> {
    let source = state.allowed_source(&path)?;
    let tools = state.media_tools(&app)?;
    quickcut_media::validate_ranges(&ranges, duration)?;
    if job_id.is_empty() || job_id.len() > 100 {
        return Err("Invalid export job.".into());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut jobs = state.jobs.lock().map_err(|_| "Export state unavailable.")?;
        if !jobs.is_empty() {
            return Err("Wait for the current export, or cancel it first.".into());
        }
        jobs.insert(job_id.clone(), cancel.clone());
    }
    std::thread::spawn(move || {
        let result = tools.export(
            &source,
            Path::new(&output),
            &ranges,
            duration,
            &cancel,
            |update| {
                let _ = app.emit(
                    "export-progress",
                    ExportProgress {
                        job_id: job_id.clone(),
                        percent: update.percent,
                        stage: update.stage,
                        done: false,
                        cancelled: false,
                        error: None,
                        output: None,
                        actual_ranges: None,
                    },
                );
            },
        );
        // Remove the job before publishing completion so an immediate new export is safe.
        if let Ok(mut jobs) = app.state::<EditorState>().jobs.lock() {
            jobs.remove(&job_id);
        }
        let cancelled = cancel.load(Ordering::Acquire) && result.is_err();
        let (error, actual_ranges) = match result {
            Ok(ranges) => (None, Some(ranges)),
            Err(error) => (if cancelled { None } else { Some(error) }, None),
        };
        let _ = app.emit(
            "export-progress",
            ExportProgress {
                job_id,
                percent: if error.is_none() && !cancelled {
                    100.0
                } else {
                    0.0
                },
                stage: if cancelled {
                    "Cancelled".into()
                } else if error.is_some() {
                    "Export failed".into()
                } else {
                    "Export complete".into()
                },
                done: true,
                cancelled,
                output: if error.is_none() && !cancelled {
                    Some(output)
                } else {
                    None
                },
                error,
                actual_ranges,
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn cancel_export(state: State<EditorState>, job_id: String) -> Result<(), String> {
    if let Some(cancel) = state
        .jobs
        .lock()
        .map_err(|_| "Export state unavailable.")?
        .get(&job_id)
    {
        cancel.store(true, Ordering::Release);
    }
    Ok(())
}

#[tauri::command]
fn shell_ready(state: State<EditorState>, frontend_ms: f64) {
    // Opt-in diagnostics write only after the first editor paint.
    if let Some(path) = std::env::var_os("QUICKCUT_PERF_LOG") {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(
                file,
                "{{\"nativeShellMs\":{:.3},\"frontendMs\":{:.3}}}",
                state.started.elapsed().as_secs_f64() * 1000.0,
                frontend_ms
            );
        }
    }
}

fn main() {
    let started = Instant::now();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(EditorState {
            allowed: Mutex::new(HashSet::new()),
            tools: Mutex::new(None),
            jobs: Mutex::new(HashMap::new()),
            started,
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(event) = event {
                let payload = match event {
                    tauri::DragDropEvent::Drop { paths, .. } => MediaDrop {
                        paths: Some(
                            paths
                                .iter()
                                .map(|p| p.to_string_lossy().into_owned())
                                .collect(),
                        ),
                        hover: false,
                    },
                    tauri::DragDropEvent::Enter { .. } | tauri::DragDropEvent::Over { .. } => {
                        MediaDrop {
                            paths: None,
                            hover: true,
                        }
                    }
                    _ => MediaDrop {
                        paths: None,
                        hover: false,
                    },
                };
                let _ = window.emit("media-drop", payload);
            }
        })
        .invoke_handler(tauri::generate_handler![
            grant_media,
            probe_media,
            extract_frame,
            start_export,
            cancel_export,
            shell_ready
        ])
        .build(tauri::generate_context!())
        .expect("Could not create the QuickCut window")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let state = app.state::<EditorState>();
                if let Ok(jobs) = state.jobs.lock() {
                    if !jobs.is_empty() {
                        for cancel in jobs.values() {
                            cancel.store(true, Ordering::Release);
                        }
                        // Keep the process alive briefly so killed children are reaped and temp media is removed.
                        api.prevent_exit();
                        let handle = app.clone();
                        std::thread::spawn(move || {
                            for _ in 0..200 {
                                std::thread::sleep(std::time::Duration::from_millis(25));
                                if handle
                                    .state::<EditorState>()
                                    .jobs
                                    .lock()
                                    .map(|j| j.is_empty())
                                    .unwrap_or(true)
                                {
                                    break;
                                }
                            }
                            handle.exit(0);
                        });
                    }
                };
            }
        });
}
