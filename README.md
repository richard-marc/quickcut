# QuickCut

A desktop video cutter built with Rust, Tauri 2, vanilla TypeScript, and FFmpeg. Open a local video, mark unwanted ranges, delete them, and export the retained clips using stream copy.

The window opens straight into the editor. No projects, accounts, network requests, effects, asset scanning, waveform generation, or whole-video thumbnail/index generation. The source file is never modified.

## Download

[Download QuickCut 0.1.0 for Windows (64-bit)](https://github.com/richard-marc/quickcut/releases/download/v0.1.0/QuickCut_0.1.0_x64-setup.exe), run the installer, and open QuickCut. FFmpeg and ffprobe are included; no compiler, Node.js, or separate media-tool installation is needed.

See [GitHub Releases](https://github.com/richard-marc/quickcut/releases/latest) for the latest version and release notes.

## Run

The Windows release executable is `src-tauri/target/release/quickcut.exe`. The installer with FFmpeg included is generated under `src-tauri/target/release/bundle/nsis/`.

For development:

```sh
npm ci
npm run desktop
```

Prerequisites: Node.js 22+, Rust, the platform's Tauri system dependencies, and FFmpeg/ffprobe on PATH. On Windows, use the MSVC Rust toolchain, C++ build tools, and WebView2. The scripts also detect a local Rust/MSVC toolchain under `.tools/`, when present, without changing system PATH.

```sh
npm run desktop:build -- --no-bundle
```

To include local FFmpeg binaries in the Windows installer:

```sh
npm run tools:bundle
npm run desktop:build -- --config src-tauri/tauri.bundle-media.json
```

The media engine finds tools lazily, in this order: `QUICKCUT_FFMPEG`/`QUICKCUT_FFPROBE`, beside the executable, bundled `binaries/`, then PATH. Shared Windows builds also need their companion DLLs; the bundling script copies them. The app never downloads media tools at runtime.

`npm run dev` opens a browser preview. It supports local playback and range editing; native file dialogs and FFmpeg export require the desktop app. The shipped desktop app includes no development server or Node runtime.

## Workflow

Drop MP4, MOV, or MKV onto the window, or press Ctrl/Cmd + O. Drag across the clip track to select a range, then Delete to remove it. Drag either selection edge to adjust that boundary while keeping the other in place. Repeat and press Ctrl/Cmd + E, Enter to export. Clicking a retained clip selects it immediately. Dragging the ruler scrubs without selecting a range.

| Shortcut | Action |
| --- | --- |
| Space | Play/pause retained clips, skipping removed gaps |
| Left / Right | Seek 5 seconds |
| Shift + Left / Right | Step one frame using the source frame rate |
| I / O | Mark selection start/end |
| S | Split a retained clip at the playhead |
| Delete / Backspace | Remove the selection |
| K | Keep the selection; subsequent K operations add further ranges |
| Escape | Clear selection |
| Ctrl/Cmd + Z | Undo |
| Ctrl/Cmd + Shift + Z | Redo |
| Ctrl/Cmd + O / E | Open / export |
| Home / End | Seek to start/end |
| + / - | Zoom the timeline around the playhead |
| F | Fit the entire source timeline |
| Ctrl/Cmd + wheel | Zoom around the pointer |
| Wheel | Scroll a zoomed timeline |

Shortcuts work with toolbar controls focused. Editing only changes ranges in memory. Undo/redo stores up to 200 metadata commands.

## Media and export

- FFprobe obtains duration, codecs, resolution, fractional frame rate, time base, and every audio stream in a background worker. Native playback starts independently of the probe.
- Native video uses the operating system WebView decoder and Tauri's range-capable asset protocol, scoped to explicitly opened files. If a codec cannot play there, a bounded FFmpeg frame-preview fallback supports scrubbing, stepping, editing, and export. Continuous playback for that codec requires an OS decoder.
- The canvas timeline paints on animation frames. Native seeks are coalesced during dragging, and final seeks are accurate. Fallback preview work uses one in-flight request and one latest pending request, with a 20-frame memory cache.
- No keyframe index is built on open. Export reads bounded packet windows near requested boundaries, snaps to nearby keyframes, and retains only decodable GOP boundaries. Very short clips that collapse to the same keyframe produce a useful error.
- Export copies video plus all source audio streams with `-c copy`. Single clips are remuxed directly; multiple clips are copied individually and joined with the concat demuxer. There is no full-file render or implicit transcoding.
- B-frame/Open-GOP boundaries are handled in decode order to avoid missing references. Explicit concat durations prevent accumulated timestamp drift. Retained encoded video packet hashes are verified in the integration tests.
- MP4, MOV, and MKV outputs are available. PCM audio needs MOV or MKV. Incompatible codec/container combinations fail with a format suggestion. Subtitles, attachments, and additional video streams are outside the MVP.
- Export operates on a snapshot, so editing and opening another source remain usable. Cancellation interrupts the active child process and removes temporary media. Final publication never replaces the source or an existing file; choose an unused output name.
- Temporary files live beside the chosen output and are cleaned up on completion/failure/cancellation. Multiple-clip exports can require approximately twice the retained output size in free disk space. RAM remains bounded independently of source file size.
- The app has a restrictive local CSP. FFmpeg/ffprobe also use a `file,pipe` protocol whitelist, preventing media inputs from triggering network fetches.

Fast Cut is the MVP. Requested selection times can move to nearby keyframes, and open-GOP boundaries can omit a few dependent frames. Frame-accurate hybrid boundary-GOP encoding is deferred to phase 5; it is not simulated by a hidden full-file transcode.

## Verification

```sh
npm test
npm run media:test
npm run media:integration
npm run desktop:check
npm run build
powershell -NoProfile -File scripts/measure-startup.ps1 -Runs 5
```

Integration tests require FFmpeg builds with libx264/libx265 for generated test fixtures. They verify H.264 MP4, HEVC MKV with open GOPs, H.264 MOV with PCM audio, single-clip export, rotation metadata, packet preservation, decoded output, cancellation cleanup, and source/output overwrite protection.

See [verification and performance notes](docs/VERIFICATION.md) for the desktop acceptance workflow, measured timings, and remaining targets. Windows is the verified platform. macOS/Linux need their native build dependencies and appropriate bundle targets; they have not been tested here.

Technical references: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [scoped local media](https://v2.tauri.app/security/asset-protocol/), [FFmpeg stream copy](https://ffmpeg.org/ffmpeg.html), [concat demuxer](https://ffmpeg.org/ffmpeg-formats.html#concat), [packet-only bitstream filters](https://ffmpeg.org/ffmpeg-bitstream-filters.html#noise).
