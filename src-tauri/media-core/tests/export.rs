use quickcut_media::{command, MediaTools, Range};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Instant,
};

fn fixture(tools: &MediaTools, path: &Path, hevc: bool, pcm: bool) {
    let output = command(&tools.ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=size=320x180:rate=30:duration=12",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:sample_rate=48000:duration=12",
            "-map",
            "0:v",
            "-map",
            "1:a",
            "-c:v",
            if hevc { "libx265" } else { "libx264" },
            "-preset",
            "ultrafast",
            "-g",
            "30",
            "-bf",
            "2",
            "-c:a",
            if pcm { "pcm_s16le" } else { "aac" },
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
fn packet_hashes(tools: &MediaTools, path: &Path) -> Vec<String> {
    let data = command(&tools.ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_packets",
            "-show_data_hash",
            "sha256",
            "-show_entries",
            "packet=data_hash",
            "-of",
            "json",
        ])
        .arg(path)
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&data.stdout).unwrap();
    value["packets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["data_hash"].as_str().unwrap().into())
        .collect()
}
fn decode(tools: &MediaTools, path: &Path) {
    let output = command(&tools.ffmpeg)
        .args(["-v", "error", "-i"])
        .arg(path)
        .args(["-f", "null", "-"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "decode error: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "requires FFmpeg/ffprobe with libx264 and libx265; run explicitly for integration QA"]
fn real_exports_preserve_encoded_packets_and_source_for_mp4_mov_and_mkv() {
    let tools = MediaTools::discover(None).unwrap();
    let temp = tempfile::tempdir().unwrap();
    for (name, hevc, pcm, extension) in [
        ("h264 source 'quote'.mp4", false, false, "mp4"),
        ("hevc.mkv", true, false, "mkv"),
        ("pcm.mov", false, true, "mov"),
    ] {
        let source = temp.path().join(name);
        fixture(&tools, &source, hevc, pcm);
        let original_bytes = fs::read(&source).unwrap();
        let info = tools.probe(&source).unwrap();
        assert!((info.duration - 12.0).abs() < 0.15);
        assert!(!tools.frame(&source, 4.5, true).unwrap().is_empty());
        assert!(!tools.frame(&source, 4.5, false).unwrap().is_empty());
        let output = temp.path().join(format!("{extension}-cut.{extension}"));
        let started = Instant::now();
        let actual = tools
            .export(
                &source,
                &output,
                &[
                    Range {
                        start: 0.0,
                        end: 2.2,
                    },
                    Range {
                        start: 4.2,
                        end: 6.2,
                    },
                    Range {
                        start: 9.2,
                        end: 12.0,
                    },
                ],
                info.duration,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        let result = tools.probe(&output).unwrap();
        let expected: f64 = actual.iter().map(|r| r.end - r.start).sum();
        assert!(
            (result.duration - expected).abs() < 0.15,
            "expected {expected}, got {}",
            result.duration
        );
        assert_eq!(result.codec, info.codec);
        assert_eq!(result.audio[0].codec, info.audio[0].codec);
        decode(&tools, &output);
        let original: HashSet<_> = packet_hashes(&tools, &source).into_iter().collect();
        let exported = packet_hashes(&tools, &output);
        assert!(exported.len() > 100);
        assert!(
            exported.iter().all(|h| original.contains(h)),
            "encoded packets changed"
        );
        assert_eq!(fs::read(&source).unwrap(), original_bytes);
        eprintln!(
            "{extension}: {:.0}ms, source={}s output={}s actual={actual:?}",
            started.elapsed().as_secs_f64() * 1000.0,
            info.duration,
            result.duration
        );
        assert!(tools
            .export(
                &source,
                &output,
                &actual,
                info.duration,
                &AtomicBool::new(false),
                |_| {}
            )
            .unwrap_err()
            .contains("already exists"));
        assert!(tools
            .export(
                &source,
                &source,
                &actual,
                info.duration,
                &AtomicBool::new(false),
                |_| {}
            )
            .unwrap_err()
            .contains("cannot be overwritten"));
    }
}

#[test]
#[ignore = "requires FFmpeg/ffprobe"]
fn direct_single_clip_and_rotated_multi_clip_exports_preserve_orientation() {
    let tools = MediaTools::discover(None).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let original = temp.path().join("original.mp4");
    fixture(&tools, &original, false, false);
    let source = temp.path().join("rotated.mp4");
    let result = command(&tools.ffmpeg)
        .args(["-v", "error", "-display_rotation", "90", "-i"])
        .arg(&original)
        .args(["-c", "copy"])
        .arg(&source)
        .output()
        .unwrap();
    assert!(result.status.success());
    for (i, ranges) in [
        vec![Range {
            start: 3.0,
            end: 7.0,
        }],
        vec![
            Range {
                start: 0.0,
                end: 3.0,
            },
            Range {
                start: 7.0,
                end: 12.0,
            },
        ],
    ]
    .into_iter()
    .enumerate()
    {
        let output = temp.path().join(format!("result-{i}.mp4"));
        tools
            .export(
                &source,
                &output,
                &ranges,
                12.0,
                &AtomicBool::new(false),
                |_| {},
            )
            .unwrap();
        decode(&tools, &output);
        let data = command(&tools.ffprobe)
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream_side_data=rotation",
                "-of",
                "json",
            ])
            .arg(&output)
            .output()
            .unwrap();
        let value: Value = serde_json::from_slice(&data.stdout).unwrap();
        assert_eq!(value["streams"][0]["side_data_list"][0]["rotation"], 90);
    }
}

#[test]
#[ignore = "requires FFmpeg/ffprobe"]
fn cancellation_removes_intermediate_files_and_never_publishes_output() {
    let tools = MediaTools::discover(None).unwrap();
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source.mp4");
    fixture(&tools, &source, false, false);
    let output = temp.path().join("cancelled.mp4");
    let cancel = AtomicBool::new(false);
    let result = tools.export(
        &source,
        &output,
        &[
            Range {
                start: 0.0,
                end: 4.0,
            },
            Range {
                start: 6.0,
                end: 10.0,
            },
        ],
        12.0,
        &cancel,
        |update| {
            if update.stage.starts_with("Copying") {
                cancel.store(true, Ordering::Release);
            }
        },
    );
    assert!(result.unwrap_err().contains("cancelled"));
    assert!(!output.exists());
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 1);
}
