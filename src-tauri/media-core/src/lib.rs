use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};

pub type Result<T> = std::result::Result<T, String>;
const CAPTURE_LIMIT: usize = 16 * 1024 * 1024;
const CANCELLED: &str = "Export cancelled";

#[derive(Clone, Debug)]
pub struct MediaTools {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Range {
    pub start: f64,
    pub end: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStream {
    pub index: u64,
    pub codec: String,
    pub channels: u64,
    pub sample_rate: u64,
    pub language: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub duration: f64,
    pub start_time: f64,
    pub codec: String,
    pub container: String,
    pub width: u64,
    pub height: u64,
    pub fps: f64,
    pub time_base: String,
    pub audio: Vec<AudioStream>,
    pub size: u64,
}

#[derive(Clone, Debug)]
pub struct ExportUpdate {
    pub percent: f64,
    pub stage: String,
}
#[derive(Clone, Copy)]
struct CutPoint {
    pts: f64,
    dts: f64,
}

pub fn command(path: &Path) -> Command {
    let mut cmd = Command::new(path);
    // A local media file must never cause FFmpeg to fetch an embedded network URL.
    cmd.args(["-protocol_whitelist", "file,pipe"]);
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW: no console flash on media work.
    }
    cmd
}

impl MediaTools {
    pub fn discover(resource_dir: Option<&Path>) -> Result<Self> {
        let find = |name: &str, var: &str| -> Result<PathBuf> {
            if let Some(path) = env::var_os(var) {
                let path = PathBuf::from(path);
                if path.is_file() {
                    return Ok(path);
                }
                return Err(format!("{var} does not point to a file."));
            }
            let filename = if cfg!(windows) {
                format!("{name}.exe")
            } else {
                name.into()
            };
            let mut candidates = Vec::new();
            if let Ok(exe) = env::current_exe() {
                if let Some(parent) = exe.parent() {
                    candidates.push(parent.join(&filename));
                    candidates.push(parent.join("binaries").join(&filename));
                }
            }
            if let Some(dir) = resource_dir {
                candidates.push(dir.join("binaries").join(&filename));
            }
            if let Some(path) = env::var_os("PATH") {
                candidates.extend(env::split_paths(&path).map(|dir| dir.join(&filename)));
            }
            candidates
                .into_iter()
                .find(|path| path.is_file())
                .ok_or_else(|| {
                    format!("{name} is missing. Install FFmpeg or place {filename} beside QuickCut.")
                })
        };
        Ok(Self {
            ffmpeg: find("ffmpeg", "QUICKCUT_FFMPEG")?,
            ffprobe: find("ffprobe", "QUICKCUT_FFPROBE")?,
        })
    }

    pub fn probe(&self, path: &Path) -> Result<MediaInfo> {
        self.probe_with_cancel(path, &AtomicBool::new(false))
    }
    fn probe_with_cancel(&self, path: &Path, cancel: &AtomicBool) -> Result<MediaInfo> {
        if !path.is_file() {
            return Err("The video file no longer exists.".into());
        }
        let mut cmd = command(&self.ffprobe);
        cmd.args([
            "-v",
            "error",
            "-show_format",
            "-show_streams",
            "-of",
            "json",
        ])
        .arg(path);
        let data = capture(cmd, cancel, Duration::from_secs(15))?;
        parse_probe(&data, path)
    }

    pub fn frame(&self, path: &Path, time: f64, accurate: bool) -> Result<Vec<u8>> {
        if !time.is_finite() || time < 0.0 {
            return Err("Invalid frame time.".into());
        }
        let mut cmd = command(&self.ffmpeg);
        cmd.args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            &format!("{time:.6}"),
        ]);
        if !accurate {
            cmd.args(["-skip_frame", "nokey"]);
        }
        cmd.arg("-i").arg(path).args([
            "-map",
            "0:v:0",
            "-an",
            "-sn",
            "-frames:v",
            "1",
            "-vf",
            "scale=960:540:force_original_aspect_ratio=decrease",
            "-q:v",
            "3",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ]);
        let data = capture(cmd, &AtomicBool::new(false), Duration::from_secs(12))?;
        if data.is_empty() {
            return Err("No preview frame found at this position.".into());
        }
        Ok(data)
    }

    // Seek in a bounded packet window. This never builds a full-file keyframe index.
    fn keyframe_near(
        &self,
        path: &Path,
        time: f64,
        duration: f64,
        offset: f64,
        cancel: &AtomicBool,
    ) -> Result<CutPoint> {
        if time <= 0.000001 {
            return Ok(CutPoint { pts: 0.0, dts: 0.0 });
        }
        if time >= duration - 0.000001 {
            return Ok(CutPoint {
                pts: duration,
                dts: duration,
            });
        }
        let mut cmd = command(&self.ffprobe);
        let interval = format!("{:.6}%+24", ((time - 8.0).max(0.0) + offset).max(0.0));
        cmd.args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-read_intervals",
            &interval,
            "-show_packets",
            "-show_entries",
            "packet=pts_time,dts_time,flags",
            "-of",
            "json",
        ])
        .arg(path);
        let data = capture(cmd, cancel, Duration::from_secs(20))?;
        let json: Value = serde_json::from_slice(&data).map_err(|e| e.to_string())?;
        let mut keys: Vec<CutPoint> = json["packets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|p| p["flags"].as_str().unwrap_or("").contains('K'))
            .filter_map(|p| {
                let pts = number(&p["pts_time"])? - offset;
                Some(CutPoint {
                    pts,
                    dts: number(&p["dts_time"]).unwrap_or(pts + offset) - offset,
                })
            })
            .filter(|p| p.pts >= 0.0 && p.pts < duration)
            .collect();
        keys.push(CutPoint {
            pts: duration,
            dts: duration,
        });
        keys.into_iter()
            .min_by(|a, b| (a.pts - time).abs().total_cmp(&(b.pts - time).abs()))
            .ok_or_else(|| {
                "No seekable keyframe found near the cut. Try a nearby cut point.".into()
            })
    }

    pub fn export<F: FnMut(ExportUpdate)>(
        &self,
        path: &Path,
        output: &Path,
        ranges: &[Range],
        source_duration: f64,
        cancel: &AtomicBool,
        mut progress: F,
    ) -> Result<Vec<Range>> {
        let ranges = validate_ranges(ranges, source_duration)?;
        let source = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let parent = output
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        let parent =
            fs::canonicalize(parent).map_err(|_| "The output directory does not exist.")?;
        let filename = output.file_name().ok_or("Choose an output filename.")?;
        let destination = parent.join(filename);
        if destination.exists() {
            if fs::canonicalize(&destination).ok().as_ref() == Some(&source) {
                return Err(
                    "The source video cannot be overwritten. Choose another filename.".into(),
                );
            }
            return Err(
                "The output already exists. Choose a new filename; existing files are preserved."
                    .into(),
            );
        }
        let extension = destination
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["mp4", "mov", "mkv"].contains(&extension.as_str()) {
            return Err("Export as MP4, MOV, or MKV.".into());
        }
        progress(ExportUpdate {
            percent: 0.0,
            stage: "Finding nearby cut points".into(),
        });
        // ffprobe is cheap metadata analysis; codecs are checked before disk-intensive work.
        let info = self.probe_with_cancel(&source, cancel)?;
        validate_ranges(&ranges, info.duration)?;
        validate_container(&info, &extension)?;
        let mut points = BTreeMap::<u64, CutPoint>::new();
        let mut end_dts = BTreeMap::<u64, f64>::new();
        let mut snapped = Vec::new();
        for (i, range) in ranges.iter().enumerate() {
            check_cancel(cancel)?;
            let mut snap = |time: f64| -> Result<CutPoint> {
                let key = time.to_bits();
                if let Some(value) = points.get(&key) {
                    return Ok(*value);
                }
                let value =
                    self.keyframe_near(&source, time, info.duration, info.start_time, cancel)?;
                points.insert(key, value);
                Ok(value)
            };
            let start = snap(range.start)?;
            let end = snap(range.end)?;
            if end.pts - start.pts < 0.000001 {
                return Err("A retained clip is shorter than the distance between nearby keyframes. Extend that range for fast export.".into());
            }
            end_dts.insert(end.pts.to_bits(), end.dts);
            snapped.push(Range {
                start: start.pts,
                end: end.pts,
            });
            progress(ExportUpdate {
                percent: (i + 1) as f64 / ranges.len() as f64 * 8.0,
                stage: format!("Cut points ready · clip {} of {}", i + 1, ranges.len()),
            });
        }
        // Adjacent/overlapping snapped clips are joined before copying, avoiding repeated GOPs.
        let actual = merge_ranges(snapped);
        let total: f64 = actual.iter().map(|r| r.end - r.start).sum();
        // All temporary media stays on the output volume; publication is a final atomic operation.
        let temp = tempfile::Builder::new()
            .prefix(".quickcut-export-")
            .tempdir_in(&parent)
            .map_err(|e| e.to_string())?;
        let staged = tempfile::Builder::new()
            .prefix("final-")
            .suffix(&format!(".{extension}"))
            .tempfile_in(temp.path())
            .map_err(|e| e.to_string())?
            .into_temp_path();
        let mut completed = 0.0;
        let mut concat = String::from("ffconcat version 1.0\n");
        for (i, range) in actual.iter().enumerate() {
            check_cancel(cancel)?;
            // Use the destination container for intermediate clips, preserving its
            // stream time base and container metadata such as MP4 rotation matrices.
            let name = format!("clip-{i:04}.{extension}");
            let segment = if actual.len() == 1 {
                staged.to_path_buf()
            } else {
                temp.path().join(&name)
            };
            let mut cmd = command(&self.ffmpeg);
            // Stop before the next key packet in decode order. In an open HEVC GOP,
            // leading B-frames before that keyframe can reference it; copying those
            // frames without their reference would create a damaged export.
            // amount=0 leaves every retained packet's encoded payload unchanged.
            let video_trim = format!(
                "noise=amount=0:drop='lt(pts*tb,0)+gte(dts*tb,{:.6})'",
                end_dts[&range.end.to_bits()] - range.start
            );
            let audio_trim = format!(
                "noise=amount=0:drop='lt(pts*tb,0)+gte(pts*tb,{:.6})'",
                range.end - range.start
            );
            cmd.args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                if actual.len() == 1 { "-y" } else { "-n" },
                "-ss",
                &format!("{:.6}", range.start),
            ])
            .arg("-i")
            .arg(&source)
            .args([
                "-t",
                &format!("{:.6}", range.end - range.start),
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c",
                "copy",
                "-bsf:v",
                &video_trim,
                "-bsf:a",
                &audio_trim,
                "-avoid_negative_ts",
                "disabled",
                "-progress",
                "pipe:1",
                "-nostats",
            ]);
            if actual.len() == 1 && (extension == "mp4" || extension == "mov") {
                cmd.args(["-movflags", "+faststart"]);
            }
            cmd.arg(&segment);
            run_progress(cmd, cancel, |seconds| {
                progress(ExportUpdate {
                    percent: 8.0
                        + (completed + seconds.min(range.end - range.start)) / total
                            * if actual.len() == 1 { 91.0 } else { 72.0 },
                    stage: format!("Copying clip {} of {}", i + 1, actual.len()),
                });
            })?;
            concat.push_str(&format!(
                "file '{name}'\nduration {:.6}\n",
                range.end - range.start
            ));
            completed += range.end - range.start;
        }
        check_cancel(cancel)?;
        if actual.len() == 1 {
            staged
                .persist_noclobber(&destination)
                .map_err(|e| format!("Could not save export: {e}"))?;
            progress(ExportUpdate {
                percent: 100.0,
                stage: "Export complete".into(),
            });
            return Ok(actual);
        }
        let list = temp.path().join("clips.ffconcat");
        fs::write(&list, concat).map_err(|e| e.to_string())?;
        let mut cmd = command(&self.ffmpeg);
        // Relative concat entries resolve correctly on Windows, including canonical \\?\ paths.
        cmd.current_dir(temp.path())
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-nostdin",
                "-y",
                "-f",
                "concat",
                "-safe",
                "1",
                "-auto_convert",
                "0",
            ])
            .args(["-i", "clips.ffconcat"])
            .args([
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-c",
                "copy",
                "-progress",
                "pipe:1",
                "-nostats",
            ]);
        if extension == "mp4" || extension == "mov" {
            cmd.args(["-movflags", "+faststart"]);
        }
        cmd.arg(staged.as_os_str());
        run_progress(cmd, cancel, |seconds| {
            progress(ExportUpdate {
                percent: 80.0 + (seconds / total).min(1.0) * 19.0,
                stage: "Joining clips · original quality".into(),
            });
        })?;
        check_cancel(cancel)?;
        // No overwrite even if another process creates the destination during export.
        // persist_noclobber uses a non-replacing move on Windows (including exFAT).
        staged
            .persist_noclobber(&destination)
            .map_err(|e| format!("Could not save export without overwriting another file: {e}"))?;
        progress(ExportUpdate {
            percent: 100.0,
            stage: "Export complete".into(),
        });
        Ok(actual)
    }
}

fn number(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| n.is_finite())
}
fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").into()
}
fn fraction(value: &Value) -> Option<f64> {
    let (n, d) = value.as_str()?.split_once('/')?;
    let result = n.parse::<f64>().ok()? / d.parse::<f64>().ok()?;
    (result.is_finite() && result > 0.0).then_some(result)
}
fn parse_probe(data: &[u8], path: &Path) -> Result<MediaInfo> {
    let json: Value = serde_json::from_slice(data).map_err(|e| e.to_string())?;
    let streams = json["streams"]
        .as_array()
        .ok_or("No media streams found.")?;
    let video = streams
        .iter()
        .find(|s| {
            s["codec_type"] == "video"
                && s["disposition"]["attached_pic"].as_u64().unwrap_or(0) == 0
        })
        .ok_or("The file contains no video stream.")?;
    let duration = number(&json["format"]["duration"])
        .or_else(|| number(&video["duration"]))
        .filter(|d| *d > 0.0)
        .ok_or("Could not determine video duration.")?;
    let audio = streams
        .iter()
        .filter(|s| s["codec_type"] == "audio")
        .map(|s| AudioStream {
            index: s["index"].as_u64().unwrap_or(0),
            codec: text(&s["codec_name"]),
            channels: s["channels"].as_u64().unwrap_or(0),
            sample_rate: number(&s["sample_rate"]).unwrap_or(0.0) as u64,
            language: s["tags"]["language"].as_str().map(String::from),
        })
        .collect();
    Ok(MediaInfo {
        path: path.to_string_lossy().into_owned(),
        duration,
        start_time: number(&json["format"]["start_time"]).unwrap_or(0.0),
        codec: text(&video["codec_name"]),
        container: text(&json["format"]["format_name"]),
        width: video["width"].as_u64().unwrap_or(0),
        height: video["height"].as_u64().unwrap_or(0),
        fps: fraction(&video["avg_frame_rate"])
            .or_else(|| fraction(&video["r_frame_rate"]))
            .unwrap_or(30.0),
        time_base: text(&video["time_base"]),
        audio,
        size: fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    })
}

pub fn validate_ranges(ranges: &[Range], duration: f64) -> Result<Vec<Range>> {
    if !duration.is_finite() || duration <= 0.0 || ranges.is_empty() || ranges.len() > 4096 {
        return Err("Choose between 1 and 4096 valid retained clips.".into());
    }
    let mut previous_end = 0.0;
    for r in ranges {
        if !r.start.is_finite()
            || !r.end.is_finite()
            || r.start < 0.0
            || r.end > duration + 0.01
            || r.end - r.start < 0.000001
            || r.start < previous_end - 0.000001
        {
            return Err(
                "Retained ranges must be ordered, non-overlapping, and inside the source video."
                    .into(),
            );
        }
        previous_end = r.end;
    }
    Ok(ranges.to_vec())
}
fn merge_ranges(ranges: Vec<Range>) -> Vec<Range> {
    let mut merged: Vec<Range> = Vec::new();
    for range in ranges {
        if let Some(last) = merged.last_mut() {
            if range.start <= last.end + 0.000001 {
                last.end = last.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    merged
}
fn validate_container(info: &MediaInfo, extension: &str) -> Result<()> {
    if extension == "mp4" && info.audio.iter().any(|a| a.codec.starts_with("pcm_")) {
        return Err("Choose MOV or MKV to preserve PCM audio without re-encoding.".into());
    }
    if extension != "mkv"
        && !["h264", "hevc", "av1", "mpeg4", "prores", "mjpeg"].contains(&info.codec.as_str())
    {
        return Err("Choose MKV to preserve this video codec without re-encoding.".into());
    }
    Ok(())
}
fn check_cancel(cancel: &AtomicBool) -> Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

fn read_bounded(mut reader: impl Read, limit: usize) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    let mut too_large = false;
    loop {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        if result.len() + n <= limit {
            result.extend_from_slice(&buffer[..n]);
        } else {
            too_large = true;
        }
    }
    if too_large {
        return Err("Media tool output exceeded its bounded buffer.".into());
    }
    Ok(result)
}
fn read_error(mut reader: impl Read) -> String {
    let mut tail = Vec::new();
    let mut buffer = [0u8; 4096];
    while let Ok(n) = reader.read(&mut buffer) {
        if n == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..n]);
        if tail.len() > 8192 {
            tail.drain(..tail.len() - 8192);
        }
    }
    String::from_utf8_lossy(&tail).trim().to_owned()
}
fn wait_child(
    child: &mut Child,
    cancel: &AtomicBool,
    timeout: Duration,
    mut poll: impl FnMut(),
) -> Result<ExitStatus> {
    let started = Instant::now();
    loop {
        poll();
        if cancel.load(Ordering::Acquire) || started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(if cancel.load(Ordering::Acquire) {
                CANCELLED.into()
            } else {
                "Media operation timed out.".into()
            });
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                poll();
                return Ok(status);
            }
            Ok(None) => thread::sleep(Duration::from_millis(15)),
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
    }
}
fn capture(mut cmd: Command, cancel: &AtomicBool, timeout: Duration) -> Result<Vec<u8>> {
    check_cancel(cancel)?;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start media tool: {e}"))?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let out = thread::spawn(move || read_bounded(stdout, CAPTURE_LIMIT));
    let err = thread::spawn(move || read_error(stderr));
    let status = wait_child(&mut child, cancel, timeout, || {});
    let data = out.join().map_err(|_| "Media output reader stopped.")?;
    let error = err.join().unwrap_or_default();
    if !status?.success() {
        return Err(if error.is_empty() {
            "Media tool failed.".into()
        } else {
            error
        });
    }
    data
}
fn run_progress(mut cmd: Command, cancel: &AtomicBool, mut update: impl FnMut(f64)) -> Result<()> {
    check_cancel(cancel)?;
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let (tx, rx) = mpsc::sync_channel::<f64>(64);
    let out = thread::spawn(move || {
        for line in BufReader::new(stdout)
            .lines()
            .map_while(std::result::Result::ok)
        {
            if let Some(value) = line
                .strip_prefix("out_time_us=")
                .and_then(|v| v.parse::<f64>().ok())
            {
                let _ = tx.try_send((value / 1_000_000.0).max(0.0));
            }
        }
    });
    let err = thread::spawn(move || read_error(stderr));
    let status = wait_child(
        &mut child,
        cancel,
        Duration::from_secs(24 * 60 * 60),
        || {
            while let Ok(seconds) = rx.try_recv() {
                update(seconds);
            }
        },
    );
    let _ = out.join();
    let error = err.join().unwrap_or_default();
    if !status?.success() {
        return Err(if error.is_empty() {
            "FFmpeg export failed.".into()
        } else {
            error
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_edit_ranges() {
        assert!(validate_ranges(
            &[
                Range {
                    start: 0.0,
                    end: 2.0
                },
                Range {
                    start: 4.0,
                    end: 8.0
                }
            ],
            10.0
        )
        .is_ok());
        for ranges in [
            vec![],
            vec![Range {
                start: f64::NAN,
                end: 2.0,
            }],
            vec![Range {
                start: 3.0,
                end: 2.0,
            }],
            vec![Range {
                start: 0.0,
                end: 11.0,
            }],
            vec![
                Range {
                    start: 0.0,
                    end: 5.0,
                },
                Range {
                    start: 4.0,
                    end: 6.0,
                },
            ],
        ] {
            assert!(validate_ranges(&ranges, 10.0).is_err());
        }
    }
    #[test]
    fn merges_snapped_overlap_without_duplicating_frames() {
        assert_eq!(
            merge_ranges(vec![
                Range {
                    start: 0.0,
                    end: 5.0
                },
                Range {
                    start: 4.0,
                    end: 7.0
                },
                Range {
                    start: 9.0,
                    end: 10.0
                }
            ]),
            vec![
                Range {
                    start: 0.0,
                    end: 7.0
                },
                Range {
                    start: 9.0,
                    end: 10.0
                }
            ]
        );
    }
    #[test]
    fn parses_fractional_framerate_and_pcm_metadata() {
        let data = br#"{"format":{"duration":"12.5","format_name":"mov,mp4"},"streams":[{"codec_type":"video","codec_name":"h264","width":1920,"height":1080,"avg_frame_rate":"30000/1001","time_base":"1/30000"},{"codec_type":"audio","codec_name":"pcm_s16le","sample_rate":"48000","channels":2}]}"#;
        let info = parse_probe(data, Path::new("test.mov")).unwrap();
        assert!((info.fps - 29.97002997).abs() < 0.00001);
        assert_eq!(info.audio[0].sample_rate, 48000);
        assert!(validate_container(&info, "mp4").is_err());
        assert!(validate_container(&info, "mov").is_ok());
    }
}
